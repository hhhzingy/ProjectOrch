/** DR02（PR2修复）：生产编排模块——把只存在于测试的 bootstrap/跨端消息/任务派发编排迁到正式实现。
 * 持久操作：SQLite表 durable_operations（operationId/idempotencyKey/steps_json/state/partial可恢复）。
 * 意图工具经控制主体授权调用；每步边界持久化；部分成功可恢复；unknown不盲重试。 */
import { randomUUID, createHash } from "node:crypto";
import type { Store } from "@projectorch/persistence";
import { completeStartupAck } from "@projectorch/domain/bootstrap";
import type { ControlPrincipal, OrchestrationTools } from "../auth/control-entry.js";
import { canonicalJson } from "@projectorch/persistence/outbox";
import { NativeRpcError } from "../native/stdio-peer.js";
import { parseSessionRef, type SessionRef } from '@projectorch/adapter-contract';
import {beginFactoryWrite,withBindingToolsWrite} from '../execution/factory-write-scope.js';
import {factoryAdmissionGuard} from '../execution/factory-admission.js';
import {readProjectPolicy} from '../auth/project-policy.js';
import {createRoleWithin} from '@projectorch/domain/roles';

export interface DurableStep { readonly step: string; readonly state: "pending" | "sent" | "observed" | "unknown" | "failed" | "skipped"; readonly detail: string | null; readonly at: number }
const backgroundFactories=new WeakMap<Store,Map<string,Promise<void>>>(),quiescedFactories=new WeakSet<Store>(),detachedFactories=new WeakSet<Store>();
function trackFactory(store:Store,id:string,work:Promise<void>){
 let active=backgroundFactories.get(store);if(!active){active=new Map();backgroundFactories.set(store,active);}
 const observed=work.catch(()=>{if(!detachedFactories.has(store)){try{recordStep(store,id,{step:'background-error',state:'unknown',detail:'ORCHESTRATION_BACKGROUND_FAILED',at:Date.now()},Date.now());}catch{/* 已失owner不能跨代写入。 */}}});
 active.set(id,observed);void observed.then(()=>active?.delete(id));
}
export function quiesceFactoryOrchestrations(store:Store){quiescedFactories.add(store);}
export function sealFactoryOrchestrations(store:Store){quiescedFactories.add(store);detachedFactories.add(store);}
export async function settleFactoryOrchestrations(store:Store){await Promise.allSettled([...(backgroundFactories.get(store)?.values()??[])]);}
export function detachFactoryOrchestrations(store:Store,now:number){
 if(detachedFactories.has(store))return;
 store.transaction(db=>{for(const id of backgroundFactories.get(store)?.keys()??[]){
  const operation=readOperation(store,id);if(!operation?.steps.some(s=>s.step==='factory-call'||s.step.endsWith(':factory-call')))continue;
  const steps=[...operation.steps,{step:'observation-detached',state:'unknown',detail:'SHUTDOWN_DRAIN_DEADLINE',at:now}];
  db.prepare("UPDATE durable_operations SET state='unknown',steps_json=?,updated_at=? WHERE id=?").run(JSON.stringify(steps),now,id);
  db.prepare("INSERT INTO events(id,project_id,type,entity_id,entity_revision,causation_id,body_json,occurred_at) VALUES(?,?,'orchestration.observation_detached',?,1,NULL,?,?)").run(randomUUID(),operation.projectId,id,JSON.stringify({operationId:id,kind:operation.kind,reason:'SHUTDOWN_DRAIN_DEADLINE',nativeTerminal:'not_asserted'}),now);
 }});detachedFactories.add(store);
}

/** 后阶段not_sent不能否认已经观察到的创建；共享工厂调用者统一保护原会话。 */
export function factoryCreationObserved(steps:readonly DurableStep[],prefix:string):boolean{return steps.some(s=>s.state==='observed'&&['create-thread','create-session','session-identity'].some(name=>s.step===prefix+name));}

/** 工厂会话登记后的启动握手（provisioning→ready）：六类版本全量取DB当前真实值（非伪造）——
 * 工厂观察到的create-session+deliver-charter observed即官方CLI真实完成证据；版本门槛照常校验。 */
export function completeBindingStartupAck(st: Store, projectId: string, roleId: string, now=Date.now()): { readonly id: string; readonly bindingState: string } {
  // 复核修复：adopt来源会话（verified_origin=0）不可凭DB版本代确认ready——须先有真实原生交互核验（markNativeSessionVerified）。
  const unverified = st.db.prepare("SELECT 1 FROM role_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.project_id=? AND b.role_id=? AND b.ended_at IS NULL AND s.verified_origin=0").get(projectId, roleId);
  if (unverified) throw new Error('STARTUP_ACK_NATIVE_VERIFICATION_REQUIRED: 接纳会话未经真实原生交互核验（resume回执匹配），保持provisioning');
  const project = st.db.prepare("SELECT policy_revision,plan_revision FROM projects WHERE id=?").get(projectId) as { policy_revision: number; plan_revision: number };
  const role = st.db.prepare("SELECT revision FROM roles WHERE id=? AND project_id=?").get(roleId, projectId) as { revision: number };
  // 任务规格门槛：派发校验要求ack含目标任务规格（STARTUP_TASK_SPEC_REQUIRED）——按当前任务清单确认（受信内核代确认+审计）
  const taskSpecs = st.db.prepare("SELECT id, spec_revision FROM tasks WHERE project_id=?").all(projectId) as { id: string; spec_revision: number }[];
  const binding=st.db.prepare('SELECT epoch FROM role_bindings WHERE project_id=? AND role_id=? AND ended_at IS NULL').get(projectId,roleId) as {epoch:number}|undefined;
  if(!binding)throw new Error('BINDING_NOT_FOUND');
  const acked = completeStartupAck(st, { projectId, roleId, bindingEpoch: Number(binding.epoch), protocolVersion: 2, policyRevision: Number(project.policy_revision), planRevision: Number(project.plan_revision), roleRevision: Number(role.revision), taskSpecRevisions: taskSpecs.map(t => ({ taskId: String(t.id), specRevision: Number(t.spec_revision) })) }, now);
  return { id: acked.id, bindingState: acked.bindingState };
}

/** 持久操作记录（查询/恢复/取消的数据源） */
export function createDurableOperation(store: Store, input: { readonly operationKey: string; readonly kind: string; readonly projectId: string; readonly payload: unknown }, now: number): { readonly operationId: string; readonly replay: boolean } {
  return store.transaction(db => {
    const existing = db.prepare("SELECT id,kind,project_id,payload_json FROM durable_operations WHERE operation_key=?").get(input.operationKey) as { id: string; kind: string; project_id: string; payload_json: string } | undefined;
    if (existing) {
      if (existing.kind !== input.kind || existing.project_id !== input.projectId || canonicalJson(JSON.parse(existing.payload_json)) !== canonicalJson(input.payload)) throw new Error('IDEMPOTENCY_PAYLOAD_CONFLICT');
      return { operationId: String(existing.id), replay: true };
    }
    const id = `op-${randomUUID()}`;
    db.prepare("INSERT INTO durable_operations(id,operation_key,kind,project_id,payload_json,state,steps_json,created_at,updated_at) VALUES(?,?,?,?,?,'pending','[]',?,?)").run(id, input.operationKey, input.kind, input.projectId, JSON.stringify(input.payload), now, now);
    return { operationId: id, replay: false };
  });
}

export function recordStep(store: Store, operationId: string, step: DurableStep, now: number): void {
  if(detachedFactories.has(store))return;
  try {
    store.transaction(db => {
    const row = db.prepare("SELECT steps_json,state FROM durable_operations WHERE id=?").get(operationId) as { steps_json: string; state: string } | undefined;
    if (!row) return;
    const steps = JSON.parse(String(row.steps_json)) as DurableStep[];
    steps.push(step);
    const state = step.state === 'unknown'||row.state==='unknown' ? 'unknown' : step.state === 'failed' ? 'failed' : row.state === 'pending' ? 'running' : row.state;
    db.prepare("UPDATE durable_operations SET steps_json=?,state=?,updated_at=? WHERE id=?").run(JSON.stringify(steps), state, now, operationId);
    });
  } catch (error) {
    // 进程关闭竞态：store已关时后台操作无法再持久化步骤——容忍（终态以已落库记录为准），其余错误如实抛出
    if (String((error as Error).message) !== 'STORE_CLOSED') throw error;
  }
}

export function readOperation(store: Store, operationId: string): { readonly id: string; readonly kind: string; readonly projectId: string; readonly state: string; readonly steps: readonly DurableStep[]; readonly payload: unknown } | null {
  const row = store.db.prepare("SELECT id,kind,project_id,state,steps_json,payload_json FROM durable_operations WHERE id=?").get(operationId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return { id: String(row.id), kind: String(row.kind), projectId: String(row.project_id), state: String(row.state), steps: JSON.parse(String(row.steps_json)), payload: JSON.parse(String(row.payload_json)) };
}

/** 以本操作精确来源结算“编排意图已完成”，不把入队当投递、done文字当原生终态。 */
export function settleCompletedOrchestrationsWithin(store:Store,projectId:string,now:number,onlyOperationId?:string):number{
 const db=store.db;if(!db.isTransaction)throw Error('ORCHESTRATION_SETTLEMENT_TRANSACTION_REQUIRED');let settled=0;
 for(const row of db.prepare("SELECT id,kind,payload_json,steps_json,state FROM durable_operations WHERE project_id=? AND state IN ('pending','running','unknown') AND kind IN ('project.bootstrap','message.send','task.dispatch')").all(projectId)){
  const id=String(row.id);if(onlyOperationId&&id!==onlyOperationId)continue;
  let proof:unknown;let steps:DurableStep[];
  try{
   const payload=JSON.parse(String(row.payload_json));steps=JSON.parse(String(row.steps_json)) as DurableStep[];
   const observed=(name:string)=>steps.some(s=>s.step===name&&s.state==='observed');
   const bindingProof=(roleId:string,prefix:string)=>{
    const current=db.prepare('SELECT b.id,b.epoch,s.harness_id,s.host_id,s.profile_id,s.native_conversation_id,s.native_workspace_id,r.binding_state FROM role_bindings b JOIN sessions s ON s.id=b.session_id JOIN roles r ON r.id=b.role_id AND r.project_id=b.project_id WHERE b.project_id=? AND b.role_id=? AND b.ended_at IS NULL').get(projectId,roleId);
    if(!current||current.binding_state!=='ready'||!db.prepare('SELECT 1 FROM role_startup_acks WHERE binding_id=? AND project_id=? AND binding_epoch=?').get(String(current.id),projectId,Number(current.epoch)))return null;
    const registrations=steps.map((s,index)=>({s,index})).filter(({s})=>s.step===prefix+'binding-registration'&&s.state==='observed'&&s.detail).map(({s,index})=>({data:JSON.parse(s.detail as string),index}));
    const own=registrations.find(r=>r.data.bindingId===current.id&&r.data.charterDelivered===true);
    if(own){const session=parseSessionRef(own.data.sessionRef);if(session.harnessId!==current.harness_id||session.hostId!==current.host_id||session.profileId!==current.profile_id||session.nativeConversationId!==current.native_conversation_id||(session.nativeWorkspaceId??'')!==(current.native_workspace_id??''))return null;
     if(steps.slice(own.index+1).some(s=>s.step===prefix+'factory-call'))return null;
     for(const s of steps.filter(s=>s.state==='observed'&&[prefix+'create-thread',prefix+'create-session',prefix+'session-identity'].includes(s.step))){if(!s.detail)return null;if(s.step.endsWith('session-identity')){const observed=parseSessionRef(JSON.parse(s.detail));if(observed.harnessId!==session.harnessId||observed.hostId!==session.hostId||observed.profileId!==session.profileId||(observed.nativeWorkspaceId??'')!==(session.nativeWorkspaceId??'')||observed.nativeConversationId!==session.nativeConversationId)return null;}else if(s.detail!==session.nativeConversationId)return null;}
     return{roleId,bindingId:String(current.id),bindingEpoch:Number(current.epoch),source:'original-binding-registration',sourceStep:own.index};}
    // 本操作有创建边界却无精确登记证明时，不能拿另一次绑定ready洗掉未知。
    if(steps.some(s=>s.step===prefix+'factory-call')||factoryCreationObserved(steps,prefix))return null;
    if(!bindingCharterConfirmed(store,projectId,String(current.id)))return null;
    return{roleId,bindingId:String(current.id),bindingEpoch:Number(current.epoch),source:'existing-confirmed-binding'};
   };
   if(row.kind==='project.bootstrap'){
    if(!observed('done')||!Array.isArray(payload.roles)||!payload.roles.length)continue;
    const roles=[];let complete=true;
    for(const role of payload.roles){if(!role||typeof role.roleId!=='string'){complete=false;break;}
     if(role.createSession===false){if(steps.some(s=>s.step===`role:${role.roleId}:factory-call`)||!observed(`role:${role.roleId}:registered-unbound`)||!db.prepare('SELECT 1 FROM roles WHERE id=? AND project_id=?').get(role.roleId,projectId)){complete=false;break;}roles.push({roleId:role.roleId,source:'explicit-register-only'});continue;}
     const evidence=bindingProof(role.roleId,`role:${role.roleId}:`);if(!evidence){complete=false;break;}roles.push(evidence);
    }
    if(!complete)continue;proof={kind:'bootstrap-ready',roles};
   }else if(row.kind==='message.send'){
    if(!observed('deliver-message')||typeof payload.toRoleId!=='string'||typeof payload.body!=='string')continue;
    const messages=db.prepare("SELECT m.id,c.id AS command_id,c.payload_json FROM messages m JOIN commands c ON c.id=m.command_id AND c.project_id=m.project_id WHERE m.project_id=? AND c.request_id=? AND c.type='message.send' AND m.to_role_id=? AND m.body=?").all(projectId,id,payload.toRoleId,payload.body);
    if(messages.length!==1)continue;const command=JSON.parse(String(messages[0]?.payload_json));if(command.toRoleId!==payload.toRoleId||command.body!==payload.body)continue;
    const binding=bindingProof(payload.toRoleId,'');if(!binding)continue;proof={kind:'message-queued-only',messageId:messages[0]?.id,commandId:messages[0]?.command_id,binding};
   }else{
    if(!observed('workflow-evaluate-enqueued')||typeof payload.taskId!=='string')continue;
    const outbox=db.prepare("SELECT o.id,c.id AS command_id,o.payload_json FROM outbox o JOIN commands c ON c.id=o.command_id WHERE c.project_id=? AND c.request_id=? AND c.type='task.dispatch'").all(projectId,id);
    if(outbox.length!==1)continue;const intent=JSON.parse(String(outbox[0]?.payload_json));if(intent.event!=='workflow.evaluate'||intent.projectId!==projectId||intent.taskId!==payload.taskId)continue;proof={kind:'workflow-enqueued-only',outboxId:outbox[0]?.id,commandId:outbox[0]?.command_id};
   }
  }catch{/* 缺失或坏来源保持原未决，不猜填。 */continue;}
   const terminal={step:'intent-settled',state:'observed',detail:JSON.stringify(proof),at:now};
   const changed=db.prepare("UPDATE durable_operations SET state='observed',steps_json=?,updated_at=? WHERE id=? AND project_id=? AND state=?").run(JSON.stringify([...steps,terminal]),now,id,projectId,String(row.state));
   if(changed.changes!==1)throw Error('ORCHESTRATION_SETTLEMENT_CONFLICT');
   db.prepare("INSERT INTO events(id,project_id,type,entity_id,entity_revision,causation_id,body_json,occurred_at) VALUES(?,?,'orchestration.intent_settled',?,1,NULL,?,?)").run(randomUUID(),projectId,id,JSON.stringify({previousState:row.state,proof}),now);settled++;
 }
 return settled;
}
function settleCompletedIntent(store:Store,projectId:string,id:string,now:number){return store.transaction(()=>settleCompletedOrchestrationsWithin(store,projectId,now,id));}

/** 本地消息意图补齐：有原工厂边界时只能消费本操作已登记的同一完整绑定，不借其他新绑定洗掉未知。 */
function enqueueMessageIntent(store:Store,principal:ControlPrincipal,projectId:string,roleId:string,operationId:string,body:string,now:number){
 return store.transaction(db=>{
  const operation=readOperation(store,operationId);if(!operation||operation.kind!=='message.send'||operation.projectId!==projectId||canonicalJson(operation.payload)!==canonicalJson({toRoleId:roleId,body}))throw Error('MESSAGE_INTENT_SOURCE_MISMATCH');
  factoryAdmissionGuard(store,principal,projectId,roleId,'message.send',operationId,undefined,'settlement')();
  if(operation.steps.some(s=>s.step==='factory-call')){
   const binding=db.prepare('SELECT b.id,s.harness_id,s.host_id,s.profile_id,s.native_conversation_id,s.native_workspace_id FROM role_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.role_id=? AND b.project_id=? AND b.ended_at IS NULL').get(roleId,projectId);
   const original=operation.steps.filter(s=>s.step==='binding-registration'&&s.state==='observed'&&s.detail).map(s=>JSON.parse(s.detail as string)).find(s=>s.bindingId===binding?.id);
   if(!binding||!original)throw Error('MESSAGE_FACTORY_ORIGINAL_BINDING_REQUIRED');const ref=parseSessionRef(original.sessionRef);
   if(ref.harnessId!==binding.harness_id||ref.hostId!==binding.host_id||ref.profileId!==binding.profile_id||ref.nativeConversationId!==binding.native_conversation_id||(ref.nativeWorkspaceId??'')!==(binding.native_workspace_id??''))throw Error('MESSAGE_FACTORY_ORIGINAL_BINDING_REQUIRED');
  }
  const existing=db.prepare("SELECT m.id,m.to_role_id,m.body,c.source_principal_id,c.payload_json FROM messages m JOIN commands c ON c.id=m.command_id AND c.project_id=m.project_id WHERE c.project_id=? AND c.request_id=? AND c.type='message.send'").all(projectId,operationId);
  if(existing.length){const row=existing[0];if(existing.length!==1||row?.to_role_id!==roleId||row.body!==body||row.source_principal_id!==principal.principalId||canonicalJson(JSON.parse(String(row.payload_json)))!==canonicalJson({toRoleId:roleId,body}))throw Error('MESSAGE_INTENT_SOURCE_MISMATCH');return String(row.id);}
  const commandId='cmd-'+operationId.slice(3),messageId='msg-'+operationId.slice(3);
  db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES(?,?,?,?,?,'message.send',?,'completed',?)").run(commandId,projectId,principal.principalId,operationId,createHash('sha256').update(canonicalJson({toRoleId:roleId,body})).digest('hex'),canonicalJson({toRoleId:roleId,body}),now);
  db.prepare("INSERT INTO messages(id,project_id,command_id,to_role_id,task_id,kind,body,delivery_json,state,created_at) VALUES(?,?,?,?,NULL,'information',?,?,'stored',?)").run(messageId,projectId,commandId,roleId,body,canonicalJson({transitions:[{state:'stored',at:now}]}),now);
  db.prepare("INSERT INTO events(id,project_id,type,entity_id,entity_revision,causation_id,body_json,occurred_at) VALUES(?,?,'message.intent_queued',?,1,?,?,?)").run(randomUUID(),projectId,messageId,commandId,canonicalJson({operationId,toRoleId:roleId}),now);return messageId;
 });
}

/** 恢复：重放未完成操作的已跳过步骤清单（bootstrap角色已建但会话unknown→重试会话步骤而非跳过整个角色） */
export function unfinishedRoleSessions(store: Store, operationId: string): readonly string[] {
  const op = readOperation(store, operationId);
  if (!op) return [];
  const done = new Set<string>();
  const pending: string[] = [];
  for (const s of op.steps) {
    const m = /^role:(.+):(.+)$/.exec(s.step);
    if (!m) continue;
    const role = m?.[1] ?? ''; const phase = m?.[2] ?? '';
    if (phase === 'created+bound' || phase === 'exists-with-binding') done.add(role);
    if (phase === 'session-unknown' || phase === 'created-no-session') pending.push(role);
  }
  return pending.filter(r => !done.has(r));
}

// ─── 编排实现（生产；测试导入这些函数而非重写） ───

export interface FactoryBoundSession { readonly sessionRef: SessionRef; readonly nativeSessionId: string; readonly nativeTurnId: string | null; readonly charterDelivered?: boolean;readonly effectiveModel?:{readonly modelId:string;readonly providerId:string|null}|null }
export interface FactoryAdapter {
  ensureBoundSession(input: { readonly projectId: string; readonly roleId: string; readonly charter: string; readonly harnessId: string; readonly workspaceRoot: string; readonly assertCanSend:()=>void; readonly onStep: (s: { readonly step: string; readonly state: string; readonly detail: string | null; readonly at: number }) => void }): Promise<FactoryBoundSession>;
  /** 核对既有外部动作，不能创建替代会话；null表示结果仍未知。 */
  recoverBoundSession?(input: { readonly operationId: string; readonly projectId: string; readonly roleId: string; readonly harnessId: string; readonly workspaceRoot: string; readonly steps: readonly DurableStep[];readonly charter?:string }): Promise<FactoryBoundSession | null>;
  /** 只读核对明确旧会话无原生活跃工作；不取消、不创建、不用空PID替代证明。 */
  observeBoundSession?(session:SessionRef):Promise<boolean>;
}

function factorySession(outcome: FactoryBoundSession, harnessId: string): SessionRef {
  const ref=parseSessionRef(outcome.sessionRef);
  if(ref.harnessId!==harnessId || ref.nativeConversationId!==outcome.nativeSessionId) throw new Error('FACTORY_SESSION_IDENTITY_MISMATCH');
  return ref;
}

/** 可跨操作恢复的绑定前置证明；只有受信工厂实际返回的记录可触发工具/握手。 */
function bindingCharterConfirmed(store:Store,projectId:string,bindingId:string):boolean {
  const rows=store.db.prepare('SELECT steps_json FROM durable_operations WHERE project_id=?').all(projectId);
  return rows.some(row=>(JSON.parse(String(row.steps_json)) as DurableStep[]).some(s=>{
    if(!s.step.endsWith('binding-registration') || s.state!=='observed' || !s.detail)return false;
    try {const record=JSON.parse(s.detail);return record.bindingId===bindingId && record.charterDelivered===true;}catch{return false;}
  }));
}

function prepareBoundRole(store:Store,projectId:string,roleId:string,operationId:string,onBoundSession:((bindingId:string,roleId:string,harnessId:string,workspaceRoot:string)=>void)|undefined,now:number,admission:()=>void,writeScope?:ReturnType<typeof beginFactoryWrite>):boolean {
  const binding=store.db.prepare('SELECT b.id,b.epoch,s.harness_id AS h,s.native_workspace_id AS w FROM role_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.project_id=? AND b.role_id=? AND b.ended_at IS NULL').get(projectId,roleId) as {id:string;epoch:number;h:string;w:string}|undefined;
  if(!binding || !bindingCharterConfirmed(store,projectId,binding.id))return false;
  try {
   if(onBoundSession){
    if(writeScope){admission();writeScope.assertScope();writeScope.runBindingTools(()=>onBoundSession(binding.id,roleId,binding.h,binding.w));}
    else{
     const origin=store.db.prepare('SELECT id,steps_json FROM durable_operations WHERE project_id=? ORDER BY created_at,id').all(projectId).find(row=>(JSON.parse(String(row.steps_json)) as DurableStep[]).some(step=>{if(step.state!=='observed'||!step.step.endsWith('binding-registration')||!step.detail)return false;const record=JSON.parse(step.detail);return record.bindingId===binding.id&&record.charterDelivered===true;}));
     if(!origin)throw Error('NATIVE_WRITE_FACTORY_PROOF_REQUIRED');
     withBindingToolsWrite(store,{projectId,roleId,operationId:String(origin.id),bindingId:binding.id,bindingEpoch:Number(binding.epoch),workspaceRoot:binding.w,admission,now:()=>now},()=>onBoundSession(binding.id,roleId,binding.h,binding.w));
    }
   }
  }
  catch {recordStep(store,operationId,{step:`role:${roleId}:tool-entry-inject-failed`,state:'unknown',detail:null,at:now},now);return false;}
  completeBindingStartupAck(store,projectId,roleId);return true;
}

const runningBootstraps = new WeakMap<object, Set<string>>();

/** project.bootstrap：现有负责人接纳+多角色+会话+章程（持久分步；角色级harness支持双Harness分工） */
export function projectBootstrapOrchestration(store: Store, factory: FactoryAdapter, charterFor: (roleId: string) => string, hooks?: { onBoundSession?: (bindingId: string, roleId: string, harnessId: string, workspaceRoot: string) => void }, factoryWorkspaceFor?: (projectId: string, taskId: string, bindingId: string) => string): OrchestrationTools['projectBootstrap'] {
  return (st, principal, args) => {
    if(quiescedFactories.has(store))return {ok:false,payload:{error:'KERNEL_STOPPING'}};
    const projectId = principal.projectId ?? (typeof args.projectId === 'string' && args.projectId ? args.projectId : '');
    if (!projectId) return { ok: false, payload: { error: 'FORBIDDEN', reason: '控制主体未绑定项目——全局控制码须显式传projectId' } };
    const objective = String(args.objective ?? '');
    const roles = Array.isArray(args.roles) ? args.roles as readonly { roleId: string; name?: string; harnessId?: string; charter?: string; permissionProfileId?:string; createSession?:boolean;parentRoleId?:string }[] : [];
    const opKey = `bootstrap:${projectId}:${createHash('sha256').update(JSON.stringify([objective, roles.map(r => r.roleId).sort()])).digest('hex').slice(0, 16)}`;
    // 复核批次一：组合入口——项目不存在则创建（须先于durable_operations的FK；"建项目—接纳—四角色"一句话组合不依赖外部种子）
    if (!store.db.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)) return {ok:false,payload:{error:'PROJECT_NOT_FOUND',hint:'先用projectorch_project_create按固定合同登记初始策略，再使用返回projectId建组；不会创建空策略半成品'}};
    const { operationId, replay } = createDurableOperation(store, { operationKey: opKey, kind: 'project.bootstrap', projectId: projectId, payload: { objective, roles: roles.map(r => ({ roleId: r.roleId, harnessId: r.harnessId ?? String(args.harnessId ?? 'zcode'),...(r.permissionProfileId?{permissionProfileId:r.permissionProfileId}:{}),...(r.charter?{charter:r.charter}:{}),...(r.name?{name:r.name}:{}),...(r.createSession===false?{createSession:false}:{}),...(r.parentRoleId?{parentRoleId:r.parentRoleId}:{}) })) } }, Date.now());
    let running = runningBootstraps.get(store);
    if (!running) { running = new Set(); runningBootstraps.set(store, running); }
    if (running.has(operationId)) return { ok: true, payload: { operationId, note: '幂等重放——操作仍在进行', query: 'durable_operations' } };
    running.add(operationId);
    const work=(async () => {
      const now = () => Date.now();
      try {
        for (const role of roles) {
          if(detachedFactories.has(store))return;
          if(quiescedFactories.has(store)){
            recordStep(store,operationId,{step:'awaiting-resume',state:'pending',detail:'INPUTS_QUIESCED_BEFORE_NEXT_ROLE',at:now()},now());
            store.transaction(db=>{db.prepare("UPDATE durable_operations SET state='pending',updated_at=? WHERE id=? AND state<>'unknown'").run(now(),operationId);});return;
          }
          const existing = st.db.prepare("SELECT binding_state,charter,permission_profile FROM roles WHERE id=? AND project_id=?").get(role.roleId, projectId) as { binding_state: string; charter: string; permission_profile:string } | undefined;
          if(existing&&((role.permissionProfileId&&existing.permission_profile!==role.permissionProfileId)||(role.charter&&existing.charter!==role.charter)))throw new NativeRpcError('ROLE_CONFIGURATION_CONFLICT','not_sent');
          if (existing?.binding_state === 'ready') { recordStep(store, operationId, { step: `role:${role.roleId}:exists-with-binding`, state: 'skipped', detail: null, at: now() }, now()); continue; }
          const bound = st.db.prepare("SELECT 1 FROM role_bindings WHERE project_id=? AND role_id=? AND ended_at IS NULL").get(projectId, role.roleId);
          if(existing&&role.createSession===false){recordStep(store,operationId,{step:`role:${role.roleId}:registered-unbound`,state:'observed',detail:'只确认已登记职责；本意图不创建或接纳会话',at:now()},now());continue;}
          if (bound) { const ready=prepareBoundRole(store,projectId,role.roleId,operationId,hooks?.onBoundSession,now(),factoryAdmissionGuard(store,principal,projectId,role.roleId,'project.bootstrap',operationId,undefined,'settlement'));recordStep(store, operationId, { step: `role:${role.roleId}:existing-binding-pending`, state: ready?'observed':'unknown', detail: '保留同一原生绑定核对工具与章程，不建替代', at: now() }, now()); continue; }
          // 角色创建（生产域函数；charter支持角色级传入——章程来自角色记录非硬编码）
          const roleCharter = existing?.charter ?? (typeof role.charter === 'string' && role.charter ? role.charter : (charterFor(role.roleId) ?? role.roleId));
          if (!existing) {
            const profile=readProjectPolicy(st.db,projectId).profiles.find(p=>p.id===(role.permissionProfileId??'team'));
            if(!profile)throw new NativeRpcError('POLICY_PROFILE_NOT_FOUND','not_sent');
            if(profile.roleIds.length&&!profile.roleIds.includes(role.roleId))throw new NativeRpcError('POLICY_PROFILE_ROLE_OUT_OF_SCOPE','not_sent');
            st.transaction(db=>createRoleWithin(db,{id:role.roleId,projectId,name:role.name??role.roleId,charter:roleCharter,permissionProfileId:profile.id,permissionProfileRevision:profile.revision,scopePaths:[],parentId:role.parentRoleId??null},now()));
          }
          if(role.createSession===false){recordStep(store,operationId,{step:`role:${role.roleId}:registered-unbound`,state:'observed',detail:'等待显式接纳已有原生会话，不启动替代会话',at:now()},now());continue;}
          const harnessId = role.harnessId ?? String(args.harnessId ?? 'zcode');
          let writeScope:ReturnType<typeof beginFactoryWrite>|undefined;
          try {
            const oldSteps = (readOperation(store, operationId)?.steps ?? []).filter(s => s.step.startsWith(`role:${role.roleId}:`));
            const lastBoundary = [...oldSteps].reverse().find(s => s.step.endsWith(':factory-call') || s.step.endsWith(':session-not-sent'));
            const workspaceRoot = factoryWorkspaceFor?.(String(projectId), role.roleId, `bnd-${role.roleId}`) ?? String(args.workspaceRoot ?? st.db.prepare('SELECT canonical_root FROM projects WHERE id=?').get(projectId)?.canonical_root ?? '');
            let outcome: FactoryBoundSession | null | undefined;
            if (existing && (lastBoundary?.step.endsWith(':factory-call')||factoryCreationObserved(oldSteps,`role:${role.roleId}:`))) {
              outcome = await factory.recoverBoundSession?.({ operationId, projectId, roleId: role.roleId, harnessId, workspaceRoot, steps: oldSteps });
              if (!outcome) { recordStep(store, operationId, { step: `role:${role.roleId}:session-unknown`, state: 'unknown', detail: '外部创建结果未核对；禁止盲目再建', at: now() }, now()); continue; }
            } else {
              const admission=factoryAdmissionGuard(store,principal,projectId,role.roleId,'project.bootstrap',operationId);
              writeScope=beginFactoryWrite(store,{projectId,roleId:role.roleId,operationId,workspaceRoot,admission:()=>{if(quiescedFactories.has(store))throw new NativeRpcError('KERNEL_STOPPING','not_sent');admission();},now});
              const assertCanSend=writeScope.assertCanSend;
              assertCanSend();
              recordStep(store, operationId, { step: `role:${role.roleId}:factory-call`, state: 'sent', detail: null, at: now() }, now());
              outcome = await factory.ensureBoundSession({ projectId: projectId as string, roleId: role.roleId, charter: roleCharter, harnessId, workspaceRoot, assertCanSend, onStep: s => {recordStep(store, operationId, { step: `role:${role.roleId}:${s.step}`, state: s.state as DurableStep['state'], detail: s.detail ?? null, at: s.at }, now());writeScope?.observeStep(s);} });
            }
            if(detachedFactories.has(store))return;
            writeScope?.assertOutcome(outcome);
            const session=factorySession(outcome,harnessId);
            st.transaction(db => {
              const sessRow = `sessrow-${role.roleId}`;
              db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id,native_workspace_id) VALUES(?,?,?,?,?,?)").run(sessRow, session.harnessId, session.hostId, session.profileId, session.nativeConversationId, session.nativeWorkspaceId??'');
              db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES(?,?,?,?,1,?)").run(`bnd-${role.roleId}`, projectId, role.roleId, sessRow, now());
              db.prepare("UPDATE roles SET binding_state='provisioning' WHERE id=? AND project_id=?").run(role.roleId, projectId);
            });
            recordStep(store,operationId,{step:`role:${role.roleId}:binding-registration`,state:'observed',detail:JSON.stringify({bindingId:`bnd-${role.roleId}`,sessionRef:session,charterDelivered:outcome.charterDelivered!==false,nativeTurnId:outcome.nativeTurnId}),at:now()},now());
            // T110：会话内角色工具注入点（application写工作区.zcode/mcp.json——角色凭据指向内核入口）
            // 复核批次二修复：注入目录必须与attempt执行目录一致（workspaceForTask(projectId,roleId,binding)）——此前args.workspaceRoot('.'，解析为内核进程cwd)导致任务轮cwd无.zcode/config.json、工具被宿主插件淹没
            try {
              if(writeScope){writeScope.assertScope();writeScope.runBindingTools(()=>hooks?.onBoundSession?.(`bnd-${role.roleId}`, role.roleId, harnessId, workspaceRoot));}
              else if(hooks?.onBoundSession){withBindingToolsWrite(store,{projectId,roleId:role.roleId,operationId,bindingId:`bnd-${role.roleId}`,bindingEpoch:1,workspaceRoot,admission:factoryAdmissionGuard(store,principal,projectId,role.roleId,'project.bootstrap',operationId,undefined,'settlement'),now},()=>hooks.onBoundSession?.(`bnd-${role.roleId}`,role.roleId,harnessId,workspaceRoot));}
            } catch(error) { writeScope?.fail(error,true);recordStep(store, operationId, { step: `role:${role.roleId}:tool-entry-inject-failed`, state: 'unknown', detail: null, at: now() }, now()); continue; }
            if (outcome.charterDelivered === false) {
              // 部分成功：原生会话/线程真实存在并登记，但章程未观察送达（如Codex额度耗尽）——不握手，保持provisioning可恢复
              recordStep(store, operationId, { step: `role:${role.roleId}:charter-not-delivered`, state: 'failed', detail: '会话已登记；章程轮未观察送达——绑定保持provisioning待恢复', at: now() }, now());
            } else {
              completeBindingStartupAck(st, projectId as string, role.roleId);
              recordStep(store, operationId, { step: `role:${role.roleId}:startup-ack`, state: 'observed', detail: 'binding ready（六类版本=DB当前值）', at: now() }, now());
            }
            writeScope?.complete(outcome);
            recordStep(store, operationId, { step: `role:${role.roleId}:created+bound`, state: 'observed', detail: outcome.nativeSessionId, at: now() }, now());
          } catch (error) {
            if(detachedFactories.has(store))return;
            writeScope?.fail(error,factoryCreationObserved(readOperation(store,operationId)?.steps??[],`role:${role.roleId}:`));
            const notSent = error instanceof NativeRpcError && error.delivery === 'not_sent'&&!factoryCreationObserved(readOperation(store,operationId)?.steps??[],`role:${role.roleId}:`);
            recordStep(store, operationId, { step: `role:${role.roleId}:${notSent ? 'session-not-sent' : 'session-unknown'}`, state: notSent ? 'failed' : 'unknown', detail: String((error as Error).message).slice(0, 120), at: now() }, now());
          }
        }
        recordStep(store, operationId, { step: 'done', state: 'observed', detail: null, at: now() }, now());
        settleCompletedIntent(store,projectId,operationId,now());
      } catch (error) {
        if(detachedFactories.has(store))return;
        recordStep(store, operationId, { step: 'error', state: 'failed', detail: String((error as Error).message).slice(0, 120), at: now() }, now());
      } finally { running!.delete(operationId); }
    })();trackFactory(store,operationId,work);
    return { ok: true, payload: { operationId, note: replay ? '幂等重放——核对并续行未完成步骤' : '持久分步操作已启动——用operationId查询进度' } };
  };
}

/** message.send：目标无绑定→工厂现场建会话→消息入库（排队≠delivered）；onQueued触发真实投递泵 */
export function messageSendOrchestration(store: Store, factory: FactoryAdapter, hooks?: { onQueued?: (projectId: string) => void; onBoundSession?: (bindingId: string, roleId: string, harnessId: string, workspaceRoot: string) => void },factoryWorkspaceFor?: (projectId:string,taskId:string,bindingId:string)=>string): OrchestrationTools['messageSend'] {
  return (st, principal, args) => {
    if(quiescedFactories.has(store))return {ok:false,payload:{error:'KERNEL_STOPPING'}};
    const projectId = principal.projectId ?? (typeof args.projectId === 'string' && args.projectId ? args.projectId : '');
    if (!projectId) return { ok: false, payload: { error: 'FORBIDDEN', reason: '控制主体未绑定项目——全局控制码须显式传projectId' } };
    const toRoleId = String(args.toRoleId ?? '');
    const body = String(args.body ?? '');
    if (!toRoleId || !body) return { ok: false, payload: { error: 'VALIDATION_ERROR' } };
    const callerKey = args.requestId ?? args.idempotencyKey;
    if (callerKey !== undefined && (typeof callerKey !== 'string' || callerKey.length < 1 || callerKey.length > 256)) return { ok: false, payload: { error: 'INVALID_REQUEST_ID' } };
    // 有请求键按意图去重；旧客户端未提供时保留原正文重放语义，不冒充不同请求。
    const intent = callerKey === undefined ? `legacy:${toRoleId}:${createHash('sha256').update(body).digest('hex')}` : `request:${principal.principalId}:${callerKey}`;
    const opKey = `xmsg:${projectId}:${intent}`;
    let created: { operationId: string; replay: boolean };
    try { created = createDurableOperation(store, { operationKey: opKey, kind: 'message.send', projectId: projectId, payload: { toRoleId, body } }, Date.now()); }
    catch (error) { if ((error as Error).message === 'IDEMPOTENCY_PAYLOAD_CONFLICT') return { ok: false, payload: { error: 'IDEMPOTENCY_PAYLOAD_CONFLICT' } }; throw error; }
    const { operationId, replay } = created;
    if (replay) {
      try{
       factoryAdmissionGuard(store,principal,projectId,toRoleId,'message.send',operationId,undefined,'settlement')();
       if(backgroundFactories.get(store)?.has(operationId))return{ok:true,payload:{operationId,note:'原操作仍在观察，未启动另一工厂'}};
       const binding=st.db.prepare('SELECT 1 FROM role_bindings WHERE role_id=? AND project_id=? AND ended_at IS NULL').get(toRoleId,projectId);
       if(!binding)return{ok:true,payload:{operationId,note:'原外部创建仍待核对，未重复创建或入队'}};
       const ready=st.db.prepare("SELECT 1 FROM roles WHERE id=? AND project_id=? AND binding_state='ready'").get(toRoleId,projectId);
       if(!ready&&!prepareBoundRole(store,projectId,toRoleId,operationId,hooks?.onBoundSession,Date.now(),factoryAdmissionGuard(store,principal,projectId,toRoleId,'message.send',operationId,undefined,'settlement')))return{ok:true,payload:{operationId,note:'原绑定章程/工具仍待核对，未补发'}};
       const messageId=enqueueMessageIntent(st,principal,projectId,toRoleId,operationId,body,Date.now());
       if(!readOperation(store,operationId)?.steps.some(s=>s.step==='deliver-message'&&s.state==='observed'))recordStep(store,operationId,{step:'deliver-message',state:'observed',detail:JSON.stringify({messageId,basis:'same-original-intent-reconciliation',delivery:'queued-only'}),at:Date.now()},Date.now());
       settleCompletedIntent(store,projectId,operationId,Date.now());hooks?.onQueued?.(projectId);
       return { ok: true, payload: { operationId, note: '幂等重放——核对原消息并补齐未入队意图，入队不表示送达' } };
      }catch(error){return{ok:false,payload:{operationId,error:/^[A-Z_]{1,100}$/.test(String((error as Error).message))?String((error as Error).message):'MESSAGE_INTENT_RECOVERY_REJECTED'}};}
    }
    const work=(async () => {
      let writeScope:ReturnType<typeof beginFactoryWrite>|undefined;
      const now = () => Date.now();
      try {
        const enqueueMessage = (): void => {
          enqueueMessageIntent(st,principal,projectId,toRoleId,operationId,body,now());
        };
        const binding = st.db.prepare("SELECT b.id, s.native_conversation_id FROM role_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.project_id=? AND b.role_id=? AND b.ended_at IS NULL").get(projectId, toRoleId) as { id: string; native_conversation_id: string } | undefined;
        if (binding) {
          const ready=st.db.prepare("SELECT 1 FROM roles WHERE id=? AND project_id=? AND binding_state='ready'").get(toRoleId,projectId);
          if(!ready&&!prepareBoundRole(store,projectId,toRoleId,operationId,hooks?.onBoundSession,now(),factoryAdmissionGuard(store,principal,projectId,toRoleId,'message.send',operationId,undefined,'settlement')))throw Error('MESSAGE_BINDING_TOOLS_UNCONFIRMED');
          // 已有绑定：消息同样必须走管线（不因绑定存在而吞掉消息体）
          recordStep(store, operationId, { step: 'use-existing-binding', state: 'observed', detail: String(binding.native_conversation_id), at: now() }, now());
          enqueueMessage();
        } else {
          const charter = String(st.db.prepare("SELECT charter FROM roles WHERE id=? AND project_id=?").get(toRoleId, projectId)?.charter ?? toRoleId);
          // 复核修复：现场建会话按角色注册harness（bootstrap记录）——此前默认zcode导致codex角色被建到zcode会话（跨端张冠李戴）
          const registeredHarness = (() => {
            const rows = st.db.prepare("SELECT payload_json FROM durable_operations WHERE kind='project.bootstrap' AND project_id=? ORDER BY created_at DESC LIMIT 5").all(projectId) as { payload_json: string }[];
            for (const row of rows) {
              try { const payload = JSON.parse(String(row.payload_json)) as { roles?: readonly { roleId: string; harnessId?: string }[] }; const hit = payload.roles?.find(r => r.roleId === toRoleId && r.harnessId); if (hit) return String(hit.harnessId); } catch { /* 尽力 */ }
            }
            return null;
          })();
          const harnessId = String(args.harnessId ?? registeredHarness ?? 'zcode');
          const futureBindingId=`bnd-${toRoleId}-${randomUUID()}`;
          const workspaceRoot=factoryWorkspaceFor?.(projectId,toRoleId,futureBindingId)??String(st.db.prepare('SELECT canonical_root FROM projects WHERE id=?').get(projectId)?.canonical_root??'.');
          const admission=factoryAdmissionGuard(store,principal,projectId,toRoleId,'message.send',operationId);
          writeScope=beginFactoryWrite(store,{projectId,roleId:toRoleId,operationId,workspaceRoot,admission:()=>{if(quiescedFactories.has(store))throw new NativeRpcError('KERNEL_STOPPING','not_sent');admission();},now});
          const assertCanSend=writeScope.assertCanSend;
          assertCanSend();
          recordStep(store,operationId,{step:'factory-call',state:'sent',detail:null,at:now()},now());
          const outcome = await factory.ensureBoundSession({ projectId: projectId as string, roleId: toRoleId, charter, harnessId, workspaceRoot, assertCanSend, onStep: s => {recordStep(store, operationId, { step: s.step, state: s.state as DurableStep['state'], detail: s.detail ?? null, at: s.at }, now());writeScope?.observeStep(s);} });
          if(detachedFactories.has(store))return;
          writeScope?.assertOutcome(outcome);
            const session=factorySession(outcome,harnessId);
          const bindingId = st.transaction(db => {
            // 会话+绑定登记（与projectBootstrap同语义——工厂产物登记后才投递）
            const sessRow = `sessrow-${toRoleId}`;
            db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id,native_workspace_id) VALUES(?,?,?,?,?,?)").run(sessRow, session.harnessId, session.hostId, session.profileId, session.nativeConversationId,session.nativeWorkspaceId??'');
            const id = futureBindingId;
            db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES(?,?,?,?,1,?)").run(id, projectId, toRoleId, sessRow, now());
            db.prepare("UPDATE roles SET binding_state='provisioning' WHERE id=? AND project_id=? AND binding_state='unbound'").run(toRoleId, projectId);
            return id;
          });
          recordStep(store,operationId,{step:'binding-registration',state:'observed',detail:JSON.stringify({bindingId,sessionRef:session,charterDelivered:outcome.charterDelivered!==false,nativeTurnId:outcome.nativeTurnId}),at:now()},now());
          if (outcome.charterDelivered === false) {
            recordStep(store, operationId, { step: 'charter-not-delivered', state: 'failed', detail: '会话已登记；章程未送达——绑定保持provisioning（消息仍入队，握手完成前不投递）', at: now() }, now());
          } else {
            writeScope?.assertCanSend();
            if(!prepareBoundRole(store,projectId,toRoleId,operationId,hooks?.onBoundSession,now(),factoryAdmissionGuard(store,principal,projectId,toRoleId,'message.send',operationId,undefined,'settlement'),writeScope))throw Error('MESSAGE_BINDING_TOOLS_UNCONFIRMED');
            recordStep(store, operationId, { step: 'startup-ack', state: 'observed', detail: '同绑定工具与章程前置通过', at: now() }, now());
          }
          writeScope?.complete(outcome);
          enqueueMessage();
        }
        recordStep(store, operationId, { step: 'deliver-message', state: 'observed', detail: 'queued（真实投递由消息投递泵执行——queued≠delivered）', at: now() }, now());
        settleCompletedIntent(store,projectId,operationId,now());
        hooks?.onQueued?.(projectId as string);
      } catch (error) {
        if(detachedFactories.has(store))return;
        writeScope?.fail(error,factoryCreationObserved(readOperation(store,operationId)?.steps??[],''));
        const notSent=error instanceof NativeRpcError&&error.delivery==='not_sent'&&!factoryCreationObserved(readOperation(store,operationId)?.steps??[],'');
        recordStep(store, operationId, { step: notSent?'session-not-sent':'error', state: notSent?'failed':'unknown', detail: String((error as Error).message).slice(0, 120), at: now() }, now());
      }
    })();trackFactory(store,operationId,work);
    return { ok: true, payload: { operationId, note: '消息操作已启动（排队≠delivered）' } };
  };
}

/** task.dispatch：任务进入工作流评估（复用既有workflow.evaluate意图） */
export function taskDispatchOrchestration(store: Store): OrchestrationTools['taskDispatch'] {
  return (st, principal, args) => {
    const projectId = principal.projectId ?? (typeof args.projectId === 'string' && args.projectId ? args.projectId : '');
    if (!projectId) return { ok: false, payload: { error: 'FORBIDDEN', reason: '控制主体未绑定项目——全局控制码须显式传projectId' } };
    const taskId = String(args.taskId ?? '');
    const task = st.db.prepare("SELECT id,revision,spec_revision,state,role_id FROM tasks WHERE id=? AND project_id=?").get(taskId, projectId) as Record<string, unknown> | undefined;
    if (!task || !task.role_id) return { ok: false, payload: { error: 'TASK_NOT_FOUND' } };
    if (!['draft', 'ready'].includes(String(task.state))) return { ok: false, payload: { error: 'TASK_NOT_READY' } };
    const opKey = `dispatch:${projectId}:${taskId}:${task.revision}:${task.spec_revision}`;
    const { operationId, replay } = createDurableOperation(store, { operationKey: opKey, kind: 'task.dispatch', projectId: projectId, payload: { taskId } }, Date.now());
    if (replay) return { ok: true, payload: { operationId, note: '幂等重放' } };
    const now = Date.now();
    recordStep(store, operationId, { step: 'workflow-evaluate-enqueued', state: 'sent', detail: null, at: now }, now);
    // 生产路径：命令+意图入队（与userCommandServices同语义）
    st.transaction(db => {
      const cmdId = `cmd-${operationId.slice(3, 11)}`;
      db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES(?,?,?,?,?,'task.dispatch',?,'completed',?)").run(cmdId, projectId, principal.principalId, operationId, '0'.repeat(64), JSON.stringify({ taskId }), now);
      db.prepare("INSERT INTO outbox(id,command_id,operation_key,payload_json,state,next_attempt_at) VALUES(?,?,?,?,'pending',?)").run(randomUUID(), cmdId, `workflow.task:${projectId}:${taskId}:${task.revision}:${task.spec_revision}`, JSON.stringify({ schemaVersion: 2, event: 'workflow.evaluate', projectId: projectId, taskId, taskRevision: Number(task.revision), specRevision: Number(task.spec_revision) }), now);
    });
    recordStep(store, operationId, { step: 'workflow-evaluate-enqueued', state: 'observed', detail: taskId, at: now }, now);
    settleCompletedIntent(store,projectId,operationId,now);
    return { ok: true, payload: { operationId, note: '任务进入工作流评估' } };
  };
}

import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,realpathSync} from 'node:fs';
import path from 'node:path';
import type {Store} from '@projectorch/persistence';
import {canonicalJson} from '@projectorch/persistence/outbox';
import {nativeWriteConflict,nativeWriteScope,readOwnedNativeWrite,nativeWriteSourceDigest,factoryWriteSourceAvailable,type NativeWriteProof} from './writer-conflicts.js';

const owners=new WeakMap<Store,string>();
const owner=(store:Store)=>{let key=owners.get(store);if(!key){key=randomUUID();owners.set(store,key);}return key;};
const text=(value:string)=>{if(typeof value!=='string'||!value||value.length>512||/[\0\r\n]/.test(value))throw Error('NATIVE_WRITE_ID_INVALID');return value;};
const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
// 中断记录只追加事实；兼容旧版本曾覆盖当前 evidence 的数据库，从不可改写观察中取回阶段事实。
function observedEvidence(store:Store,row:Record<string,unknown>):Record<string,unknown>{
 const evidence:Record<string,unknown>={};let unattributed=false;
 for(const observation of store.db.prepare('SELECT evidence_json FROM native_write_effect_observations WHERE effect_id=? ORDER BY sequence').all(String(row.id))){
  if(observation.evidence_json){Object.assign(evidence,JSON.parse(String(observation.evidence_json)));unattributed ||= evidence.unattributed===true;}
 }
 if(row.evidence_json)Object.assign(evidence,JSON.parse(String(row.evidence_json)));
 if(unattributed)evidence.unattributed=true;
 return evidence;
}
function assertFactoryLocalRecovery(row:Record<string,unknown>,evidence:Record<string,unknown>){
 if(row.purpose!=='factory'||evidence.unattributed===true||((row.phase==='binding-tools'||evidence.localWriteStarted===true)&&evidence.localWriteCompleted!==true))throw Error('NATIVE_WRITE_LOCAL_RECOVERY_REQUIRED');
}
export interface NativeWriteRequest {
 readonly projectId:string;readonly roleId:string;readonly kind:'factory'|'message';readonly sourceId:string;
 readonly targetRoot:string;readonly writePaths?:readonly string[];readonly bindingId?:string;readonly bindingEpoch?:number;
 readonly purpose?:'factory'|'message'|'binding-tools';
}
function identity(root:string){
 let anchor=root;
 for(;;){try{const stat=lstatSync(anchor,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('NATIVE_WRITE_IDENTITY_CHANGED');return {anchor,dev:String(stat.dev),ino:String(stat.ino)};}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))throw error;const parent=path.dirname(anchor);if(parent===anchor)throw error;anchor=parent;}}
}
function assertIdentity(value:unknown){
 if(!value||typeof value!=='object')throw Error('NATIVE_WRITE_IDENTITY_CHANGED');
 const data=value as {anchor:string;dev:string;ino:string},stat=lstatSync(data.anchor,{bigint:true});
 const normalize=(p:string)=>process.platform==='win32'?path.resolve(p).toLowerCase():path.resolve(p);
 if(!stat.isDirectory()||stat.isSymbolicLink()||normalize(realpathSync.native(data.anchor))!==normalize(data.anchor)||String(stat.dev)!==data.dev||String(stat.ino)!==data.ino)throw Error('NATIVE_WRITE_IDENTITY_CHANGED');
}
function factoryTerminal(store:Store,projectId:string,roleId:string,sourceId:string,session:Record<string,unknown>,bindingId:string){
 const operation=store.db.prepare('SELECT steps_json FROM durable_operations WHERE id=? AND project_id=?').get(sourceId,projectId);if(!operation)throw Error('NATIVE_WRITE_FACTORY_PROOF_REQUIRED');
 const steps=JSON.parse(String(operation.steps_json)) as {step:string;state:string;detail:string|null}[],prefix=steps.some(s=>['binding-registration','factory-call','session-identity'].some(name=>s.step===`role:${roleId}:`+name))?`role:${roleId}:`:'';
 let nativeExecutionId:string|null=null,identitySeen=false,charter=false,registrationSeen=false;
 for(const step of steps.filter(s=>s.state==='observed'&&s.detail)){
  if(step.step===prefix+'binding-registration'){const record=JSON.parse(step.detail as string);if(record.bindingId===bindingId&&record.sessionRef&&canonicalJson(record.sessionRef)===canonicalJson(session)){identitySeen=true;registrationSeen=true;charter=record.charterDelivered===true;if(typeof record.nativeTurnId==='string'&&record.nativeTurnId)nativeExecutionId=record.nativeTurnId;}}
  if(step.step===prefix+'session-identity'&&canonicalJson(JSON.parse(step.detail as string))===canonicalJson(session))identitySeen=true;
  if(step.step===prefix+'deliver-charter')charter=true;
  if(step.step===prefix+'charter-execution')nativeExecutionId=step.detail;
  if(step.step===prefix+'charter-history-proof'){const record=JSON.parse(step.detail as string);if(typeof record.executionId==='string'&&record.executionId)nativeExecutionId=record.executionId;}
  if(step.step===prefix+'deliver-charter'&&session.harnessId==='zcode')nativeExecutionId=step.detail;
 }
 if(!identitySeen||!registrationSeen||!charter||!nativeExecutionId||nativeExecutionId===session.nativeConversationId)throw Error('NATIVE_WRITE_FACTORY_PROOF_REQUIRED');
 return {nativeConversationId:session.nativeConversationId,nativeExecutionId,sessionRef:session,terminalConfirmed:true};
}
function source(store:Store,input:NativeWriteRequest){
 const db=store.db;
 const role=db.prepare("SELECT 1 FROM roles WHERE id=? AND project_id=? AND desired_state='enabled'").get(input.roleId,input.projectId);if(!role)throw Error('NATIVE_WRITE_ROLE_NOT_AVAILABLE');
 let bindingId:string|null=null,bindingEpoch:number|null=null,session:Record<string,unknown>|null=null;
 if(input.bindingId!==undefined){
  if(!Number.isSafeInteger(input.bindingEpoch))throw Error('NATIVE_WRITE_BINDING_REQUIRED');
  const row=db.prepare('SELECT b.id,b.epoch,s.harness_id,s.host_id,s.profile_id,s.native_conversation_id,s.native_workspace_id FROM role_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.id=? AND b.project_id=? AND b.role_id=? AND b.epoch=? AND b.ended_at IS NULL').get(input.bindingId,input.projectId,input.roleId,input.bindingEpoch as number);
  if(!row)throw Error('NATIVE_WRITE_BINDING_REQUIRED');
  bindingId=String(row.id);bindingEpoch=Number(row.epoch);session={harnessId:row.harness_id,hostId:row.host_id,profileId:row.profile_id,nativeConversationId:row.native_conversation_id,...(row.native_workspace_id?{nativeWorkspaceId:row.native_workspace_id}:{})};
 }
 if(input.kind==='message'){
  const directory=lstatSync(input.targetRoot);if(!directory.isDirectory()||directory.isSymbolicLink())throw Error('NATIVE_WRITE_SCOPE_REQUIRED');
  if(!session?.nativeWorkspaceId||nativeWriteScope(store,input.projectId,String(session.nativeWorkspaceId)).root!==nativeWriteScope(store,input.projectId,input.targetRoot).root)throw Error('NATIVE_WRITE_SCOPE_REQUIRED');
  if(!db.prepare("SELECT 1 FROM messages WHERE id=? AND project_id=? AND to_role_id=? AND state IN ('queued','sending')").get(input.sourceId,input.projectId,input.roleId))throw Error('NATIVE_WRITE_SOURCE_REQUIRED');
 }else if(input.kind==='factory'){
  const operation=db.prepare("SELECT payload_json,state FROM durable_operations WHERE id=? AND project_id=? AND kind IN ('project.bootstrap','role.provision','message.send')").get(input.sourceId,input.projectId);
  if(!operation)throw Error('NATIVE_WRITE_SOURCE_REQUIRED');const payload=JSON.parse(String(operation.payload_json));
  if(input.purpose!=='binding-tools'&&!factoryWriteSourceAvailable(store,input.projectId,input.sourceId,input.roleId))throw Error('NATIVE_WRITE_SOURCE_REQUIRED');
  if(input.purpose==='binding-tools'&&(!session?.nativeWorkspaceId||nativeWriteScope(store,input.projectId,String(session.nativeWorkspaceId)).root!==nativeWriteScope(store,input.projectId,input.targetRoot).root))throw Error('NATIVE_WRITE_BINDING_REQUIRED');
  if(payload.roleId!==input.roleId&&payload.toRoleId!==input.roleId&&!(Array.isArray(payload.roles)&&payload.roles.some((r:{roleId?:unknown})=>r?.roleId===input.roleId)))throw Error('NATIVE_WRITE_SOURCE_ROLE_MISMATCH');
 }else throw Error('NATIVE_WRITE_SOURCE_REQUIRED');
 if(input.purpose==='binding-tools'){if(!session||!bindingId)throw Error('NATIVE_WRITE_BINDING_REQUIRED');factoryTerminal(store,input.projectId,input.roleId,input.sourceId,session,bindingId);}
 return {bindingId,bindingEpoch,session};
}

/** 只供受信内核；授权、owner、暂停、预算仍由各生产入口重核，不接收模型自报证明。 */
export function reserveNativeWriteWithin(store:Store,input:NativeWriteRequest,now:number):NativeWriteProof{
 const db=store.db;if(!db.isTransaction)throw Error('NATIVE_WRITE_TRANSACTION_REQUIRED');
 if(!Number.isSafeInteger(now)||now<0)throw Error('NATIVE_WRITE_TIME_INVALID');
 for(const value of [input.projectId,input.roleId,input.sourceId])text(value);
 const bound=source(store,input),sourceSha256=nativeWriteSourceDigest(store,input.kind,input.sourceId,input.projectId),scope=nativeWriteScope(store,input.projectId,input.targetRoot,input.writePaths),writes=[...(input.writePaths??[])];
 const purpose=input.purpose??input.kind;
 if(input.kind==='message'&&purpose!=='message'||input.kind==='factory'&&!['factory','binding-tools'].includes(purpose))throw Error('NATIVE_WRITE_PURPOSE_INVALID');
 const previous=db.prepare("SELECT * FROM native_write_effects WHERE source_kind=? AND source_id=? AND role_id=? AND state IN ('reserved','active','unknown')").get(input.kind,input.sourceId,input.roleId);
 if(previous){
  if(previous.purpose!==purpose||previous.project_id!==input.projectId||previous.source_sha256!==sourceSha256||previous.target_root!==scope.root||previous.scope_json!==canonicalJson(writes)||previous.binding_id!==bound.bindingId||previous.binding_epoch!==bound.bindingEpoch||previous.session_json!==(bound.session?canonicalJson(bound.session):null))throw Error('NATIVE_WRITE_INTENT_CHANGED');
  const proof={id:String(previous.id),ownerKey:owner(store),fence:Number(previous.fence),proofSha256:String(previous.proof_sha256)};
  assertNativeWriteWithin(store,proof);return proof;
 }
 if(purpose!=='binding-tools'){
  const prior=db.prepare('SELECT state,phase,evidence_json FROM native_write_effects WHERE source_kind=? AND source_id=? AND role_id=? ORDER BY fence DESC LIMIT 1').get(input.kind,input.sourceId,input.roleId);
  if(prior&&!(input.kind==='factory'&&prior.state==='settled'&&prior.phase==='not_sent'&&prior.evidence_json&&JSON.parse(String(prior.evidence_json)).notSent===true))throw Error('NATIVE_WRITE_EFFECT_ALREADY_SETTLED');
 }
 if(nativeWriteConflict(store,input.projectId,scope.root,writes))throw Error('NATIVE_WRITE_CONFLICT');
 if(input.kind==='factory'&&purpose==='factory')db.prepare("UPDATE durable_operations SET state='running' WHERE id=? AND project_id=? AND state='failed'").run(input.sourceId,input.projectId);
 const fence=Number(db.prepare('SELECT COALESCE(MAX(fence),0)+1 n FROM native_write_effects WHERE source_kind=? AND source_id=? AND role_id=?').get(input.kind,input.sourceId,input.roleId)?.n),id='nwe-'+randomUUID(),key=owner(store),snapshot=identity(scope.root),materialized=snapshot.anchor===scope.root?canonicalJson(snapshot):null,proofSha256=digest({id,projectId:input.projectId,roleId:input.roleId,kind:input.kind,purpose,sourceId:input.sourceId,sourceSha256,...bound,targetRoot:scope.root,writePaths:writes,identity:snapshot,ownerKey:key,fence});
 db.prepare("INSERT INTO native_write_effects(id,project_id,role_id,source_kind,purpose,source_id,source_sha256,operation_id,message_id,binding_id,binding_epoch,session_json,target_root,scope_json,identity_json,materialized_identity_json,proof_sha256,owner_key,fence,state,phase,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved','planned',?,?)")
  .run(id,input.projectId,input.roleId,input.kind,purpose,input.sourceId,sourceSha256,input.kind==='factory'?input.sourceId:null,input.kind==='message'?input.sourceId:null,bound.bindingId,bound.bindingEpoch,bound.session?canonicalJson(bound.session):null,scope.root,canonicalJson(writes),canonicalJson(snapshot),materialized,proofSha256,key,fence,now,now);
 return {id,ownerKey:key,fence,proofSha256};
}
export function assertNativeWriteWithin(store:Store,proof:NativeWriteProof){
 if(proof.ownerKey!==owner(store))throw Error('NATIVE_WRITE_OWNER_OR_FENCE_LOST');
 const row=readOwnedNativeWrite(store,proof);assertIdentity(JSON.parse(String(row.identity_json)));
 if(row.materialized_identity_json!==null)assertIdentity(JSON.parse(String(row.materialized_identity_json)));
 else{
  try{
   lstatSync(String(row.target_root));const materialized=identity(String(row.target_root));
   if(materialized.anchor!==row.target_root)throw Error('NATIVE_WRITE_IDENTITY_CHANGED');
   store.db.prepare('UPDATE native_write_effects SET materialized_identity_json=? WHERE id=? AND materialized_identity_json IS NULL').run(canonicalJson(materialized),proof.id);
  }catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))throw error;}
 }
 if(nativeWriteConflict(store,String(row.project_id),String(row.target_root),JSON.parse(String(row.scope_json)),proof))throw Error('NATIVE_WRITE_CONFLICT');
 return row;
}
/** 外部调用已返回后的身份复核，不授权新的原生输入；允许登记精确部分成功事实。 */
export function assertNativeWriteIdentityWithin(store:Store,proof:NativeWriteProof){
 if(!store.db.isTransaction||proof.ownerKey!==owner(store))throw Error('NATIVE_WRITE_OWNER_OR_FENCE_LOST');
 const row=store.db.prepare("SELECT * FROM native_write_effects WHERE id=? AND owner_key=? AND fence=? AND proof_sha256=? AND state IN ('reserved','active')").get(proof.id,proof.ownerKey,proof.fence,proof.proofSha256);
 if(!row||row.source_sha256!==nativeWriteSourceDigest(store,String(row.source_kind),String(row.source_id),String(row.project_id)))throw Error('NATIVE_WRITE_SOURCE_CHANGED');
 assertIdentity(JSON.parse(String(row.identity_json)));if(row.materialized_identity_json===null)throw Error('NATIVE_WRITE_MATERIALIZED_IDENTITY_REQUIRED');assertIdentity(JSON.parse(String(row.materialized_identity_json)));return row;
}
export function activateNativeWriteWithin(store:Store,proof:NativeWriteProof,phase:'planned'|'created'|'charter'|'message',now:number){
 const row=assertNativeWriteWithin(store,proof);store.db.prepare("UPDATE native_write_effects SET state='active',phase=?,updated_at=? WHERE id=? AND owner_key=? AND fence=? AND state IN ('reserved','active')").run(phase,now,row.id as string,proof.ownerKey,proof.fence);
}
export function finishNativeWriteWithin(store:Store,proof:NativeWriteProof,outcome:'not_sent'|'terminal'|'unknown'|'local_terminal',evidence:Readonly<Record<string,unknown>>,now:number){
 if(!store.db.isTransaction||proof.ownerKey!==owner(store))throw Error('NATIVE_WRITE_OWNER_OR_FENCE_LOST');
 const row=store.db.prepare("SELECT * FROM native_write_effects WHERE id=? AND owner_key=? AND fence=? AND proof_sha256=? AND state IN ('reserved','active')").get(proof.id,proof.ownerKey,proof.fence,proof.proofSha256);
 if(!row)throw Error('NATIVE_WRITE_OWNER_OR_FENCE_LOST');
 if(evidence.sourceId!==row.source_id||!['not_sent','terminal','unknown','local_terminal'].includes(outcome))throw Error('NATIVE_WRITE_EVIDENCE_SOURCE_REQUIRED');
 if(outcome==='local_terminal'&&(row.purpose!=='binding-tools'||evidence.localWriteCompleted!==true))throw Error('NATIVE_WRITE_LOCAL_PROOF_REQUIRED');
 // evidence由受信适配器/原操作账本提供；本函数不是对Agent开放的“成功”接口。
 if(outcome==='terminal'&&(typeof evidence.nativeConversationId!=='string'||typeof evidence.nativeExecutionId!=='string'||!evidence.nativeExecutionId||evidence.terminalConfirmed!==true))throw Error('NATIVE_WRITE_TERMINAL_PROOF_REQUIRED');
 if(outcome==='terminal'&&row.session_json!==null&&JSON.parse(String(row.session_json)).nativeConversationId!==evidence.nativeConversationId)throw Error('NATIVE_WRITE_TERMINAL_SESSION_MISMATCH');
 if(outcome==='not_sent'&&evidence.notSent!==true)throw Error('NATIVE_WRITE_NOT_SENT_PROOF_REQUIRED');
 const previous=row.evidence_json?JSON.parse(String(row.evidence_json)):{};
 store.db.prepare('UPDATE native_write_effects SET state=?,phase=?,evidence_json=?,updated_at=? WHERE id=? AND owner_key=? AND fence=?').run(outcome==='unknown'?'unknown':'settled',outcome==='not_sent'?'not_sent':['terminal','local_terminal'].includes(outcome)?'terminal':String(row.phase),canonicalJson({...previous,...evidence}),now,proof.id,proof.ownerKey,proof.fence);
}

/** 只消费原来源已持久化的精确会话/轮次完成观察；不接收模型自报完成、不取得原owner。 */
export function reconcileFactoryWriteWithin(store:Store,input:{projectId:string;roleId:string;sourceId:string;bindingId:string;bindingEpoch:number;targetRoot:string},now:number){
 if(!store.db.isTransaction)throw Error('NATIVE_WRITE_TRANSACTION_REQUIRED');
 const bound=source(store,{...input,kind:'factory',purpose:'binding-tools'});if(!bound.session)throw Error('NATIVE_WRITE_BINDING_REQUIRED');
 const terminal=factoryTerminal(store,input.projectId,input.roleId,input.sourceId,bound.session,input.bindingId),scope=nativeWriteScope(store,input.projectId,input.targetRoot);
 for(const row of store.db.prepare("SELECT * FROM native_write_effects WHERE project_id=? AND role_id=? AND source_kind='factory' AND source_id=? AND state IN ('reserved','active','unknown')").all(input.projectId,input.roleId,input.sourceId)){
  const evidence=observedEvidence(store,row);assertFactoryLocalRecovery(row,evidence);
  if(row.source_sha256!==nativeWriteSourceDigest(store,'factory',input.sourceId,input.projectId)||row.target_root!==scope.root)throw Error('NATIVE_WRITE_INTENT_CHANGED');
  assertIdentity(JSON.parse(String(row.identity_json)));
  if(row.materialized_identity_json===null)throw Error('NATIVE_WRITE_MATERIALIZED_IDENTITY_REQUIRED');
  assertIdentity(JSON.parse(String(row.materialized_identity_json)));
  store.db.prepare("UPDATE native_write_effects SET state='settled',phase='terminal',evidence_json=?,updated_at=? WHERE id=? AND state IN ('reserved','active','unknown')").run(canonicalJson({...evidence,...terminal,sourceId:input.sourceId,basis:'same-original-persisted-native-terminal'}),now,String(row.id));
 }
}

export function interruptNativeWritesWithin(store:Store,now:number){
 if(!store.db.isTransaction)throw Error('NATIVE_WRITE_TRANSACTION_REQUIRED');
 store.db.prepare("UPDATE native_write_effects SET state='unknown',evidence_json=json_patch(COALESCE(evidence_json,'{}'),json_object('sourceId',source_id,'reason','KERNEL_OBSERVATION_INTERRUPTED','nativeTerminal','not_asserted')),updated_at=? WHERE state IN ('reserved','active')").run(now);
}

/** 受信只读观察者核对原消息的明确失败/中断；不重发、不标送达，不回滚可能存在的业务部分成功。 */
export function reconcileInterruptedMessageWithin(store:Store,input:{projectId:string;messageId:string;sessionRef:Readonly<Record<string,unknown>>;nativeTurnId:string;status:'failed'|'interrupted';terminalConfirmed:boolean},now:number){
 if(!store.db.isTransaction)throw Error('NATIVE_WRITE_TRANSACTION_REQUIRED');
 if(!input.terminalConfirmed||!['failed','interrupted'].includes(input.status)||!input.nativeTurnId||input.nativeTurnId===input.sessionRef.nativeConversationId)throw Error('MESSAGE_ORIGINAL_TERMINAL_REQUIRED');
 const message=store.db.prepare("SELECT * FROM messages WHERE id=? AND project_id=? AND state='uncertain'").get(input.messageId,input.projectId);
 const row=store.db.prepare("SELECT * FROM native_write_effects WHERE source_kind='message' AND source_id=? AND project_id=? AND purpose='message' AND state='unknown'").get(input.messageId,input.projectId);
 if(!message||!row||row.role_id!==message.to_role_id)throw Error('MESSAGE_ORIGINAL_EFFECT_REQUIRED');
 const evidence=observedEvidence(store,row),receipt=evidence.receipt as Record<string,unknown>|undefined;
 if(evidence.unattributed===true||evidence.localWriteStarted===true||!receipt||receipt.harnessId!==input.sessionRef.harnessId||receipt.nativeConversationId!==input.sessionRef.nativeConversationId||receipt.nativeTurnId!==input.nativeTurnId)throw Error('MESSAGE_ORIGINAL_TERMINAL_REQUIRED');
 if(row.session_json!==canonicalJson(input.sessionRef)||row.source_sha256!==nativeWriteSourceDigest(store,'message',input.messageId,input.projectId))throw Error('NATIVE_WRITE_SOURCE_CHANGED');
 const binding=store.db.prepare('SELECT s.harness_id,s.host_id,s.profile_id,s.native_conversation_id,s.native_workspace_id FROM role_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.id=? AND b.project_id=? AND b.role_id=? AND b.epoch=? AND b.ended_at IS NULL').get(String(row.binding_id),input.projectId,String(row.role_id),Number(row.binding_epoch));
 const current=binding?{harnessId:binding.harness_id,hostId:binding.host_id,profileId:binding.profile_id,nativeConversationId:binding.native_conversation_id,...(binding.native_workspace_id?{nativeWorkspaceId:binding.native_workspace_id}:{})}:null;
 if(!current||canonicalJson(current)!==canonicalJson(input.sessionRef))throw Error('NATIVE_WRITE_BINDING_CHANGED');
 const scope=nativeWriteScope(store,input.projectId,String(input.sessionRef.nativeWorkspaceId));
 if(row.target_root!==scope.root||row.materialized_identity_json===null)throw Error('NATIVE_WRITE_INTENT_CHANGED');
 assertIdentity(JSON.parse(String(row.identity_json)));assertIdentity(JSON.parse(String(row.materialized_identity_json)));
 const terminal={sourceId:input.messageId,sessionRef:input.sessionRef,nativeConversationId:input.sessionRef.nativeConversationId,nativeExecutionId:input.nativeTurnId,status:input.status,nativeStatus:input.status,terminalConfirmed:true,basis:'same-original-authoritative-negative-terminal',partialBusinessEffectsNotRolledBack:true};
 const delivery=JSON.parse(String(message.delivery_json));
 if(!Array.isArray(delivery.transitions))throw Error('MESSAGE_ORIGINAL_RECEIPT_REQUIRED');
 const prior=delivery.transitions.findLast((s:{state?:string;receipt?:Record<string,unknown>})=>s.state==='uncertain')?.receipt;
 if(prior?.harnessId!==input.sessionRef.harnessId||prior?.nativeConversationId!==input.sessionRef.nativeConversationId||prior?.nativeTurnId!==input.nativeTurnId)throw Error('MESSAGE_ORIGINAL_RECEIPT_REQUIRED');
 delivery.transitions.push({state:'failed',at:now,receipt:terminal});
 store.db.prepare("UPDATE native_write_effects SET state='settled',phase='terminal',evidence_json=?,updated_at=? WHERE id=? AND state='unknown'").run(canonicalJson({...evidence,...terminal}),now,String(row.id));
 store.db.prepare("UPDATE messages SET state='failed',delivery_json=? WHERE id=? AND project_id=? AND state='uncertain'").run(canonicalJson(delivery),input.messageId,input.projectId);
 return {messageId:input.messageId,state:'failed' as const,nativeTurnId:input.nativeTurnId,status:input.status};
}

/** 原会话/原轮的只读权威恢复，不颁发owned能力，也不把本地未知借章程结算。 */
export function reconcileRecoveredFactoryWriteWithin(store:Store,input:{projectId:string;roleId:string;sourceId:string;sessionRef:Readonly<Record<string,unknown>>;nativeTurnId:string},now:number){
 if(!store.db.isTransaction)throw Error('NATIVE_WRITE_TRANSACTION_REQUIRED');
 const operation=store.db.prepare('SELECT kind,payload_json,steps_json FROM durable_operations WHERE id=? AND project_id=?').get(input.sourceId,input.projectId);if(!operation)throw Error('NATIVE_WRITE_FACTORY_PROOF_REQUIRED');
 const payload=JSON.parse(String(operation.payload_json));if(payload.roleId!==input.roleId&&payload.toRoleId!==input.roleId&&!(Array.isArray(payload.roles)&&payload.roles.some((r:{roleId?:unknown})=>r.roleId===input.roleId)))throw Error('NATIVE_WRITE_SOURCE_ROLE_MISMATCH');
 const prefix=operation.kind==='message.send'?'':`role:${input.roleId}:`,steps=JSON.parse(String(operation.steps_json)) as {step:string;state:string;detail:string|null}[],ids=new Set<string>();
 for(const step of steps.filter(s=>s.state==='observed'&&s.detail)){
  if(['create-thread','create-session'].some(name=>step.step===prefix+name))ids.add(step.detail as string);
  if(step.step===prefix+'session-identity'){const session=JSON.parse(step.detail as string);ids.add(session.nativeConversationId);if(canonicalJson(session)!==canonicalJson(input.sessionRef))throw Error('NATIVE_WRITE_SESSION_CHANGED');}
 }
 const observed=steps.findLast(s=>s.step===prefix+'recovered-terminal'&&s.state==='observed'&&s.detail),proof=observed?.detail?JSON.parse(observed.detail):null;
 if(ids.size!==1||!ids.has(String(input.sessionRef.nativeConversationId))||!input.nativeTurnId||input.nativeTurnId===input.sessionRef.nativeConversationId||!proof||proof.charterDelivered!==true||proof.nativeTurnId!==input.nativeTurnId||canonicalJson(proof.sessionRef)!==canonicalJson(input.sessionRef))throw Error('NATIVE_WRITE_FACTORY_PROOF_REQUIRED');
 const scope=nativeWriteScope(store,input.projectId,String(input.sessionRef.nativeWorkspaceId));
 for(const row of store.db.prepare("SELECT * FROM native_write_effects WHERE project_id=? AND role_id=? AND source_kind='factory' AND source_id=? AND state IN ('reserved','active','unknown')").all(input.projectId,input.roleId,input.sourceId)){
  const evidence=observedEvidence(store,row);assertFactoryLocalRecovery(row,evidence);
  if(row.source_sha256!==nativeWriteSourceDigest(store,'factory',input.sourceId,input.projectId)||row.target_root!==scope.root||row.materialized_identity_json===null)throw Error('NATIVE_WRITE_INTENT_CHANGED');
  assertIdentity(JSON.parse(String(row.identity_json)));assertIdentity(JSON.parse(String(row.materialized_identity_json)));
  store.db.prepare("UPDATE native_write_effects SET state='settled',phase='terminal',evidence_json=?,updated_at=? WHERE id=? AND state IN ('reserved','active','unknown')").run(canonicalJson({...evidence,sourceId:input.sourceId,sessionRef:input.sessionRef,nativeConversationId:input.sessionRef.nativeConversationId,nativeExecutionId:input.nativeTurnId,terminalConfirmed:true,basis:'same-original-authoritative-readonly'}),now,String(row.id));
 }
}

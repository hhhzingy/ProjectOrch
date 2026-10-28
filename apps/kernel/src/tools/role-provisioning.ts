import {reconcileRecoveredFactoryWriteWithin,type NativeWriteProof} from '@projectorch/domain/workspaces';
import {beginFactoryWrite,withBindingToolsWrite} from '../execution/factory-write-scope.js';
import {randomUUID} from 'node:crypto';
import type {Store} from '@projectorch/persistence';
import type {AgentPrincipal} from '../auth/agent-credential.js';
import {assertAgentPrincipalCurrent} from '../auth/agent-credential.js';
import {authorizeAgentAction} from '../auth/policy-check.js';
import {factoryAdmissionGuard} from '../execution/factory-admission.js';
import {NativeRpcError} from '../native/stdio-peer.js';
import {parseSessionRef} from '@projectorch/adapter-contract';
import {completeBindingStartupAck,recordStep,readOperation,factoryCreationObserved,type FactoryAdapter,type FactoryBoundSession} from './orchestration-tools.js';
import {consumableHandover,type Authorize} from './collaboration-workflow.js';
import {succeedBindingWithin} from '@projectorch/domain/native-binding';
import {enqueueWorkflowCandidatesWithin} from '../execution/workflow-intents.js';
import {recordModelEffective} from '@projectorch/domain/roles';

/** 固定role.provision命令的事务部分；不在事务内启动原生进程。 */
export function queueRoleProvisionWithin(store:Store,principal:AgentPrincipal,payload:{roleId:string;expectedRevision:number;harnessId:string;handoverId?:string},commandId:string,now:number,check:Authorize){
 const db=store.db;if(!db.isTransaction)throw Error('PROVISION_TRANSACTION_REQUIRED');
 const role=db.prepare('SELECT revision,parent_id,charter,binding_state,model_preference_revision FROM roles WHERE id=? AND project_id=?').get(payload.roleId,principal.projectId),project=db.prepare('SELECT policy_revision,hold_revision FROM projects WHERE id=?').get(principal.projectId);
 if(!role||role.parent_id!==principal.roleId)throw Error('PROVISION_TARGET_NOT_CHILD');
 if(role.revision!==payload.expectedRevision)throw Error('PROVISION_REVISION_CONFLICT');
 const previous=db.prepare('SELECT b.id,b.epoch,s.harness_id,s.host_id,s.profile_id,s.native_conversation_id,s.native_workspace_id FROM role_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.role_id=? AND b.project_id=? AND b.ended_at IS NULL').get(payload.roleId,principal.projectId);
 if(previous&&!payload.handoverId)throw Error('PROVISION_ALREADY_BOUND');if(!previous&&payload.handoverId)throw Error('HANDOVER_BINDING_NOT_CURRENT');
 const handover=payload.handoverId?consumableHandover(store,principal.projectId,payload.roleId,payload.handoverId,check):null;
 if(db.prepare("SELECT 1 FROM durable_operations WHERE project_id=? AND kind='role.provision' AND state IN ('pending','running','unknown') AND json_extract(payload_json,'$.roleId')=?").get(principal.projectId,payload.roleId))throw Error('PROVISION_ALREADY_PENDING');
 const context=handover?{handoverId:handover.id,revision:handover.revision,fromBindingEpoch:handover.fromBindingEpoch,planRevision:handover.planRevision,artifact:handover.artifact,taskSpecRevisions:handover.taskSpecRevisions,workspaceVersions:handover.workspaceVersions,unresolvedIssueIds:handover.unresolvedIssueIds}:null;
 const factoryCharter=String(role.charter)+(context?'\n\nProjectOrch明确的新会话接替，不是原会话恢复。持久上下文：'+JSON.stringify(context)+'\n首项业务工作先handover.read，再artifact.content分片读取该上下文成果；只按当前任务/权限执行，争议不等于通过，不重复旧外部动作。收到本章程仅确认就绪，等待业务任务。':'');
 if(Buffer.byteLength(factoryCharter,'utf8')>60000)throw Error('HANDOVER_BOOTSTRAP_TOO_LARGE');
 const operationId='op-'+randomUUID(),input={...payload,commandId,factoryCharter,...(handover?{handoverRevision:handover.revision,previousBindingId:previous?.id,previousBindingEpoch:previous?.epoch,previousSession:{harnessId:previous?.harness_id,hostId:previous?.host_id,profileId:previous?.profile_id,nativeConversationId:previous?.native_conversation_id,...(previous?.native_workspace_id?{nativeWorkspaceId:previous.native_workspace_id}:{})}}:{}),sourceRoleId:principal.roleId,sourceBindingId:principal.bindingId,sourceBindingEpoch:principal.bindingEpoch,sourceCredentialId:principal.credentialId,policyRevision:project?.policy_revision,holdRevision:project?.hold_revision,modelPreferenceRevision:role.model_preference_revision};
 db.prepare("INSERT INTO durable_operations(id,operation_key,kind,project_id,payload_json,state,steps_json,created_at,updated_at) VALUES(?,?,'role.provision',?,?,'pending','[]',?,?)").run(operationId,'role.provision:'+commandId,principal.projectId,JSON.stringify(input),now,now);
 return {operationId,roleId:payload.roleId,state:'pending',bindingState:String(role.binding_state),handoverId:payload.handoverId??null};
}

export interface ProvisionServices{
 readonly principalForBinding:(bindingId:string)=>AgentPrincipal;
 readonly isOwner:()=>boolean;
 readonly workspaceForRole:(projectId:string,roleId:string,bindingId:string)=>string;
 readonly onBoundSession:(bindingId:string,roleId:string,harnessId:string,workspaceRoot:string)=>void;
 readonly now:()=>number;
}
const runners=new WeakMap<Store,Map<string,Promise<void>>>(),nextCheck=new WeakMap<Store,Map<string,number>>();
const detachedStores=new WeakSet<Store>();

/** 管理Agent委派后的后台工厂；沿用生产工厂、原始授权与共享预算，不提升成控制入口主体。 */
export function pumpRoleProvisioning(store:Store,factory:FactoryAdapter,services:ProvisionServices,limit=2){
 if(detachedStores.has(store))return {started:0,running:0};
 if(!services.isOwner())throw Error('PROVISION_OWNER_LOST');
 let running=runners.get(store);if(!running){running=new Map();runners.set(store,running);}let checked=nextCheck.get(store);if(!checked){checked=new Map();nextCheck.set(store,checked);}
 let started=0;
 for(const row of store.db.prepare("SELECT id,project_id,payload_json FROM durable_operations WHERE kind='role.provision' AND state IN ('pending','running','unknown') ORDER BY created_at,id").all()){
  const operationId=String(row.id);if(started>=limit)break;if(running.has(operationId)||(checked.get(operationId)??0)>services.now())continue;
  const payload=JSON.parse(String(row.payload_json)),projectId=String(row.project_id),roleId=String(payload.roleId),prefix=`role:${roleId}:`;
  const work=Promise.resolve().then(async()=>{
   let enteredFactory=false,recovery=false,factoryReturned=false;
   let writeScope:ReturnType<typeof beginFactoryWrite>|undefined,currentNativeProof:NativeWriteProof|undefined;let readonlyRecovery=false;
   const now=services.now;
   let registered=false,registeredRevision=Number(payload.expectedRevision);
   const authorizeFor=(principal:AgentPrincipal):Authorize=>(action,path,kind)=>{if(!authorizeAgentAction(store,principal,undefined,{action,targetProjectId:projectId,kind:kind??'read',path},now()).allowed)throw Error('FORBIDDEN');};
   const authority=()=>{
    if(detachedStores.has(store)||!services.isOwner())throw new NativeRpcError('PROVISION_OWNER_LOST','not_sent');
    const principal=services.principalForBinding(String(payload.sourceBindingId));assertAgentPrincipalCurrent(store,principal,now());
    const grant=store.db.prepare('SELECT expires_at,revoked_at FROM agent_credentials WHERE id=? AND project_id=? AND binding_id=? AND binding_epoch=?').get(String(payload.sourceCredentialId),projectId,String(payload.sourceBindingId),Number(payload.sourceBindingEpoch));
    const role=store.db.prepare('SELECT revision,model_preference_revision,parent_id FROM roles WHERE id=? AND project_id=?').get(roleId,projectId),project=store.db.prepare('SELECT policy_revision,hold_revision FROM projects WHERE id=?').get(projectId);
    const allowedRevision=!registered?role?.revision===payload.expectedRevision:role?.revision===registeredRevision||(role?.revision===registeredRevision+1&&store.db.prepare("SELECT 1 FROM roles WHERE id=? AND project_id=? AND binding_state='ready'").get(roleId,projectId));
    if(!grant||grant.revoked_at!==null||Number(grant.expires_at)<=now()||principal.roleId!==payload.sourceRoleId||principal.bindingEpoch!==payload.sourceBindingEpoch||role?.parent_id!==principal.roleId||project?.policy_revision!==payload.policyRevision||project?.hold_revision!==payload.holdRevision||!allowedRevision||role?.model_preference_revision!==payload.modelPreferenceRevision)throw new NativeRpcError('PROVISION_AUTHORIZATION_CHANGED','not_sent');
    if(!authorizeAgentAction(store,principal,undefined,{action:'role.bind',targetProjectId:projectId,kind:'write',path:`roles/${roleId}`},now()).allowed)throw new NativeRpcError('PROVISION_AUTHORIZATION_CHANGED','not_sent');
    if(payload.handoverId&&!registered&&!readonlyRecovery){const verify=()=>consumableHandover(store,projectId,roleId,String(payload.handoverId),authorizeFor(principal),operationId,currentNativeProof);const handover=store.db.isTransaction?verify():store.transaction(verify);if(handover.revision!==payload.handoverRevision||handover.fromBindingEpoch!==payload.previousBindingEpoch)throw new NativeRpcError('HANDOVER_STALE','not_sent');const old=store.db.prepare('SELECT id FROM role_bindings WHERE project_id=? AND role_id=? AND ended_at IS NULL').get(projectId,roleId);if(old?.id!==payload.previousBindingId)throw new NativeRpcError('HANDOVER_BINDING_NOT_CURRENT','not_sent');}
   };
   try{
    const operation=readOperation(store,operationId);if(!operation)throw Error('PROVISION_OPERATION_NOT_FOUND');
    const registration=[...operation.steps].reverse().find(s=>s.step===prefix+'binding-registration'&&s.state==='observed');
    if(registration){
      // 登记与来源步骤原子提交。重启只恢复原绑定工具/握手，不再次建会话。
      const data=JSON.parse(registration.detail??'{}');
      registered=true;registeredRevision=Number(data.roleRevision??payload.expectedRevision);factoryAdmissionGuard(store,null,projectId,roleId,'project.bootstrap',operationId,authority,'settlement')();
      if(data.charterDelivered!==true)throw Error('PROVISION_CHARTER_UNCONFIRMED');
      if(!services.isOwner())throw Error('PROVISION_OWNER_LOST');
      const active=store.db.prepare('SELECT id FROM role_bindings WHERE id=? AND project_id=? AND role_id=? AND epoch=? AND ended_at IS NULL').get(data.bindingId,projectId,roleId,Number(data.bindingEpoch??1));if(!active)throw Error('PROVISION_BINDING_CHANGED');
      if(payload.handoverId&&!store.db.prepare('SELECT 1 FROM handover_consumptions WHERE project_id=? AND handover_id=? AND new_binding_id=? AND new_binding_epoch=?').get(projectId,String(payload.handoverId),data.bindingId,Number(data.bindingEpoch)))throw Error('PROVISION_HANDOVER_SOURCE_MISSING');
      withBindingToolsWrite(store,{projectId,roleId,operationId,bindingId:data.bindingId,bindingEpoch:Number(data.bindingEpoch??1),workspaceRoot:data.workspaceRoot,admission:()=>factoryAdmissionGuard(store,null,projectId,roleId,'project.bootstrap',operationId,authority,'settlement')(),now},()=>services.onBoundSession(data.bindingId,roleId,payload.harnessId,data.workspaceRoot));
      if(data.effectiveModel)recordModelEffective(store,projectId,roleId,{...data.effectiveModel,observedAt:now(),basis:'session-authoritative'},Number(payload.modelPreferenceRevision));
      if(!store.db.prepare("SELECT 1 FROM roles WHERE id=? AND project_id=? AND binding_state='ready'").get(roleId,projectId))completeBindingStartupAck(store,projectId,roleId,now());
      store.db.prepare("UPDATE durable_operations SET state='observed',updated_at=? WHERE id=?").run(now(),operationId);return;
    }
    const oldBoundary=[...operation.steps].reverse().find(s=>s.step===prefix+'factory-call'||s.step===prefix+'session-not-sent');
    recovery=oldBoundary?.step===prefix+'factory-call'||factoryCreationObserved(operation.steps,prefix);readonlyRecovery=recovery;
    authority();
    const bindingId='bnd-'+roleId+'-'+operationId.slice(3),workspaceRoot=services.workspaceForRole(projectId,roleId,bindingId),role=store.db.prepare('SELECT charter FROM roles WHERE id=? AND project_id=?').get(roleId,projectId),charter=typeof payload.factoryCharter==='string'?payload.factoryCharter:String(role?.charter);
    const guard=factoryAdmissionGuard(store,null,projectId,roleId,'project.bootstrap',operationId,authority);
    const boundary=[...operation.steps].reverse().find(s=>s.step===prefix+'factory-call'||s.step===prefix+'session-not-sent');
    recovery=boundary?.step===prefix+'factory-call'||factoryCreationObserved(operation.steps,prefix);let outcome:FactoryBoundSession|null|undefined;
    if(recovery){outcome=await factory.recoverBoundSession?.({operationId,projectId,roleId,harnessId:payload.harnessId,workspaceRoot,steps:operation.steps,charter});if(!outcome){if(detachedStores.has(store)||!services.isOwner())return;store.db.prepare("UPDATE durable_operations SET state='unknown',updated_at=? WHERE id=?").run(now(),operationId);return;}
     if(detachedStores.has(store)||!services.isOwner())return;
     if(outcome.charterDelivered===true&&outcome.nativeTurnId){authority();recordStep(store,operationId,{step:prefix+'recovered-terminal',state:'observed',detail:JSON.stringify({sessionRef:outcome.sessionRef,nativeTurnId:outcome.nativeTurnId,charterDelivered:true}),at:now()},now());store.transaction(()=>{authority();reconcileRecoveredFactoryWriteWithin(store,{projectId,roleId,sourceId:operationId,sessionRef:{...outcome!.sessionRef},nativeTurnId:outcome!.nativeTurnId!},now());});}
     readonlyRecovery=false;
    }
    else{
     if(payload.handoverId){if(!factory.observeBoundSession||!await factory.observeBoundSession(parseSessionRef(payload.previousSession)))throw new NativeRpcError('HANDOVER_OLD_SESSION_UNPROVEN','not_sent');authority();}
     writeScope=beginFactoryWrite(store,{projectId,roleId,operationId,workspaceRoot,admission:proof=>{currentNativeProof=proof;guard();},now});
     writeScope.assertCanSend();recordStep(store,operationId,{step:prefix+'factory-call',state:'sent',detail:null,at:now()},now());enteredFactory=true;
     outcome=await factory.ensureBoundSession({projectId,roleId,charter,harnessId:payload.harnessId,workspaceRoot,assertCanSend:writeScope.assertCanSend,onStep:s=>{if(!detachedStores.has(store)&&services.isOwner()){recordStep(store,operationId,{step:prefix+s.step,state:s.state as 'observed',detail:s.detail,at:s.at},now());writeScope?.observeStep(s);}}});
    }
    factoryReturned=true;if(detachedStores.has(store)||!services.isOwner())return;
    writeScope?.assertOutcome(outcome);
    if(payload.handoverId){if(outcome.charterDelivered!==true)throw Error('PROVISION_CHARTER_UNCONFIRMED');if(!factory.observeBoundSession||!await factory.observeBoundSession(parseSessionRef(payload.previousSession)))throw Error('HANDOVER_OLD_SESSION_UNPROVEN');}
    const settleGuard=factoryAdmissionGuard(store,null,projectId,roleId,'project.bootstrap',operationId,authority,'settlement');settleGuard();const session=parseSessionRef(outcome.sessionRef);if(session.harnessId!==payload.harnessId||session.nativeConversationId!==outcome.nativeSessionId)throw Error('PROVISION_SESSION_MISMATCH');
    const registrationRevision=store.transaction(db=>{
     settleGuard();const transitionAt=now(),old=db.prepare('SELECT id FROM role_bindings WHERE role_id=? AND project_id=? AND ended_at IS NULL').get(roleId,projectId);
     if(!payload.handoverId&&old)throw Error('PROVISION_ALREADY_BOUND');
     if(payload.handoverId&&old?.id!==payload.previousBindingId)throw Error('HANDOVER_BINDING_NOT_CURRENT');
     if(payload.handoverId){const before=parseSessionRef(payload.previousSession);if(before.harnessId===session.harnessId&&before.hostId===session.hostId&&before.profileId===session.profileId&&before.nativeConversationId===session.nativeConversationId)throw Error('PROVISION_REPLACEMENT_SESSION_NOT_NEW');}
     const sessionId='session-'+randomUUID();db.prepare('INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id,native_workspace_id) VALUES(?,?,?,?,?,?)').run(sessionId,session.harnessId,session.hostId,session.profileId,session.nativeConversationId,session.nativeWorkspaceId??'');
     let bindingEpoch=1;
     if(payload.handoverId){
      const handover=consumableHandover(store,projectId,roleId,String(payload.handoverId),authorizeFor(services.principalForBinding(String(payload.sourceBindingId))),operationId,currentNativeProof);if(handover.revision!==payload.handoverRevision)throw Error('HANDOVER_STALE');
      const changed=db.prepare("UPDATE handovers SET state='consumed',revision=revision+1 WHERE id=? AND project_id=? AND revision=? AND state='verified'").run(handover.id,projectId,handover.revision);if(changed.changes!==1)throw Error('HANDOVER_REVISION_CONFLICT');
      const succession=succeedBindingWithin(db,{newBindingId:bindingId,projectId,roleId,sessionId,handoverId:handover.id},transitionAt);bindingEpoch=succession.newBinding.epoch;
      db.prepare('INSERT INTO handover_consumptions(handover_id,project_id,role_id,old_binding_id,old_binding_epoch,new_binding_id,new_binding_epoch,command_id,consumed_at) VALUES(?,?,?,?,?,?,?,?,?)').run(handover.id,projectId,roleId,String(payload.previousBindingId),Number(payload.previousBindingEpoch),bindingId,bindingEpoch,String(payload.commandId),transitionAt);
     }else{db.prepare('INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES(?,?,?,?,1,?)').run(bindingId,projectId,roleId,sessionId,transitionAt);db.prepare("UPDATE roles SET binding_state='provisioning' WHERE id=? AND project_id=?").run(roleId,projectId);}
     const roleRevision=Number(db.prepare('SELECT revision FROM roles WHERE id=? AND project_id=?').get(roleId,projectId)?.revision);
     const latest=readOperation(store,operationId);const steps=[...(latest?.steps??[]),{step:prefix+'binding-registration',state:'observed',detail:JSON.stringify({bindingId,bindingEpoch,roleRevision,sessionRef:session,workspaceRoot,handoverId:payload.handoverId??null,effectiveModel:outcome.effectiveModel??null,nativeTurnId:outcome.nativeTurnId,charterDelivered:outcome.charterDelivered===true}),at:transitionAt}];
     db.prepare("UPDATE durable_operations SET steps_json=?,state='running',updated_at=? WHERE id=?").run(JSON.stringify(steps),now(),operationId);
     db.prepare("INSERT INTO events(id,project_id,type,entity_id,entity_revision,causation_id,body_json,occurred_at) VALUES(?,?,'role.provision.bound',?,?,?,?,?)").run(randomUUID(),projectId,roleId,roleRevision,String(payload.commandId),JSON.stringify({bindingId,bindingEpoch,handoverId:payload.handoverId??null,sessionRef:session,charterDelivered:outcome.charterDelivered===true}),transitionAt);
     if(payload.handoverId)enqueueWorkflowCandidatesWithin(db,projectId,String(payload.commandId),transitionAt,db.prepare("SELECT id FROM tasks WHERE project_id=? AND role_id=? AND state IN ('draft','ready')").all(projectId,roleId).map(t=>String(t.id)),true);
     return roleRevision;
    });
    registered=true;registeredRevision=registrationRevision;
    if(outcome.charterDelivered!==true)throw Error('PROVISION_CHARTER_UNCONFIRMED');
    if(outcome.effectiveModel)recordModelEffective(store,projectId,roleId,{...outcome.effectiveModel,observedAt:now(),basis:'session-authoritative'},Number(payload.modelPreferenceRevision));
    const postBindGuard=factoryAdmissionGuard(store,null,projectId,roleId,'project.bootstrap',operationId,authority,'settlement');postBindGuard();if(writeScope){writeScope.assertScope();writeScope.runBindingTools(()=>services.onBoundSession(bindingId,roleId,payload.harnessId,workspaceRoot));}else withBindingToolsWrite(store,{projectId,roleId,operationId,bindingId,bindingEpoch:payload.handoverId?Number(payload.previousBindingEpoch)+1:1,workspaceRoot,admission:postBindGuard,now},()=>services.onBoundSession(bindingId,roleId,payload.harnessId,workspaceRoot));completeBindingStartupAck(store,projectId,roleId,now());
    writeScope?.complete(outcome);
    recordStep(store,operationId,{step:prefix+'created+bound',state:'observed',detail:null,at:now()},now());store.db.prepare("UPDATE durable_operations SET state='observed',updated_at=? WHERE id=?").run(now(),operationId);
   }catch(error){
    if(detachedStores.has(store)||!services.isOwner())return;
    writeScope?.fail(error,factoryCreationObserved(readOperation(store,operationId)?.steps??[],prefix));
    const prior=readOperation(store,operationId),hasExternalBoundary=prior?.steps.some(s=>s.step===prefix+'factory-call')??false;
    if(!hasExternalBoundary&&!registered){
     // 准入拒绝发生在任何外发边界之前：容量不足是排队，不能制造unknown或占用原生容量。
     const code=error instanceof NativeRpcError?error.code:((error as Error)?.message??'PROVISION_FAILED');
     const deferred=code==='FACTORY_CONCURRENCY_EXCEEDED';
     recordStep(store,operationId,{step:prefix+(deferred?'admission-deferred':'admission-not-sent'),state:'failed',detail:/^[A-Z_]{1,100}$/.test(code)?code:'PROVISION_FAILED',at:services.now()},services.now());
     store.db.prepare('UPDATE durable_operations SET state=?,updated_at=? WHERE id=?').run(deferred?'pending':'failed',services.now(),operationId);return;
    }
    const creationObserved=factoryCreationObserved(prior?.steps??[],prefix);
    // 章程发送前的not_sent不能反推之前创建线程也未发生；保存原ID和原占位，禁止下一次再建。
    const confirmedNotSent=enteredFactory&&!recovery&&!factoryReturned&&!creationObserved&&error instanceof NativeRpcError&&error.delivery==='not_sent';
    const code=error instanceof NativeRpcError?error.code:((error as Error)?.message??'PROVISION_FAILED');
    recordStep(store,operationId,{step:prefix+(confirmedNotSent?'session-not-sent':'blocked'),state:confirmedNotSent?'failed':'unknown',detail:/^[A-Z_]{1,100}$/.test(code)?code:'PROVISION_FAILED',at:services.now()},services.now());
   }
  }).finally(()=>{running?.delete(operationId);checked?.set(operationId,services.now()+30000);});
  running.set(operationId,work);started++;
 }
 return {started,running:running.size};
}
export async function settleRoleProvisioning(store:Store){await Promise.allSettled([...(runners.get(store)?.values()??[])]);}
export function sealRoleProvisioning(store:Store){detachedStores.add(store);}

/** 停机观察截止：保留已发边界和原操作；迟到回调不能写旧Store或触发下一次外发。 */
export function detachRoleProvisioning(store:Store,now:number){
 if(detachedStores.has(store))return;
 store.transaction(db=>{for(const row of db.prepare("SELECT id,project_id,payload_json FROM durable_operations WHERE kind='role.provision' AND state IN ('pending','running','unknown')").all()){
  const operation=readOperation(store,String(row.id)),payload=JSON.parse(String(row.payload_json));if(!operation?.steps.some(s=>s.step===`role:${payload.roleId}:factory-call`))continue;
  const steps=[...operation.steps,{step:`role:${payload.roleId}:observation-detached`,state:'unknown',detail:'SHUTDOWN_DRAIN_DEADLINE',at:now}];
  db.prepare("UPDATE durable_operations SET state='unknown',steps_json=?,updated_at=? WHERE id=?").run(JSON.stringify(steps),now,String(row.id));
  db.prepare("INSERT INTO events(id,project_id,type,entity_id,entity_revision,causation_id,body_json,occurred_at) VALUES(?,?,'role.provision.observation_detached',?,?,?,?,?)").run(randomUUID(),String(row.project_id),payload.roleId,Number(payload.expectedRevision),payload.commandId,JSON.stringify({operationId:row.id,reason:'SHUTDOWN_DRAIN_DEADLINE',nativeTerminal:'not_asserted'}),now);
 }});detachedStores.add(store);
}



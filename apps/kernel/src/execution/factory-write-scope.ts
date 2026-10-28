import {mkdirSync,realpathSync} from 'node:fs';
import path from 'node:path';
import type {Store} from '@projectorch/persistence';
import {reserveNativeWriteWithin,assertNativeWriteWithin,assertNativeWriteIdentityWithin,activateNativeWriteWithin,finishNativeWriteWithin,reconcileFactoryWriteWithin,type NativeWriteProof} from '@projectorch/domain/workspaces';
import {NativeRpcError} from '../native/stdio-peer.js';
import type {FactoryBoundSession} from '../tools/orchestration-tools.js';

/** 工厂先预约再建目录/写工具配置/创建会话，生命周期由调用方持有到工具注入结束。 */
export function beginFactoryWrite(store:Store,input:{projectId:string;roleId:string;operationId:string;workspaceRoot:string;admission:(proof?:NativeWriteProof)=>void;now:()=>number}){
 let proof:NativeWriteProof;let finished=false;
 const transaction=<T>(run:()=>T)=>store.db.isTransaction?run():store.transaction(run);
 try{proof=transaction(()=>{input.admission();return reserveNativeWriteWithin(store,{projectId:input.projectId,roleId:input.roleId,kind:'factory',sourceId:input.operationId,targetRoot:input.workspaceRoot},input.now());});}
 catch(error){throw new NativeRpcError(/^[A-Z_]{1,100}$/.test(String((error as Error).message))?(error as Error).message:'FACTORY_WRITE_SCOPE_BLOCKED','not_sent');}
 const assertCanSend=()=>{
  try{transaction(()=>{input.admission(proof);const row=assertNativeWriteWithin(store,proof);if(row.evidence_json&&JSON.parse(String(row.evidence_json)).localWriteStarted===true)throw Error('FACTORY_NATIVE_PHASE_COMPLETE');activateNativeWriteWithin(store,proof,row.phase as 'planned'|'created'|'charter'|'message',input.now());});}
  catch{throw new NativeRpcError('FACTORY_WRITE_RESERVATION_CHANGED','not_sent');}
 };
 const fail=(error:unknown,creationObserved:boolean)=>{
  if(finished)return;
  const notSent=error instanceof NativeRpcError&&error.delivery==='not_sent'&&!creationObserved;
  transaction(()=>finishNativeWriteWithin(store,proof,notSent?'not_sent':'unknown',{sourceId:input.operationId,notSent,unattributed:/FACTORY_WORKSPACE_/.test(String((error as Error)?.message)),reason:'FACTORY_INPUT_OR_OBSERVATION_FAILED'},input.now()));finished=true;
 };
 try{assertCanSend();mkdirSync(input.workspaceRoot,{recursive:true});assertCanSend();}
 catch(error){fail(new NativeRpcError('FACTORY_DIRECTORY_PREPARATION_NOT_SENT','not_sent'),false);throw error;}
 const assertOutcome=(outcome:FactoryBoundSession)=>{
  const normalize=(value:string)=>{const resolved=path.resolve(realpathSync.native(value));return process.platform==='win32'?resolved.toLowerCase():resolved;};
  try{transaction(()=>assertNativeWriteIdentityWithin(store,proof));if(!outcome.sessionRef.nativeWorkspaceId||normalize(outcome.sessionRef.nativeWorkspaceId)!==normalize(input.workspaceRoot))throw Error('FACTORY_WORKSPACE_MISMATCH');}
  catch{throw Error('FACTORY_WORKSPACE_MISMATCH');}
 };
 return {proof,assertCanSend,assertScope:()=>transaction(()=>assertNativeWriteWithin(store,proof)),assertOutcome,fail,
  runBindingTools(write:()=>unknown){
   const observe=(completed:boolean,succeeded:boolean)=>transaction(()=>{const row=assertNativeWriteIdentityWithin(store,proof),previous=row.evidence_json?JSON.parse(String(row.evidence_json)):{};store.db.prepare("UPDATE native_write_effects SET phase='binding-tools',evidence_json=?,updated_at=? WHERE id=? AND owner_key=? AND fence=?").run(JSON.stringify({...previous,sourceId:input.operationId,localWriteStarted:true,localWriteCompleted:completed,localWriteSucceeded:succeeded}),input.now(),proof.id,proof.ownerKey,proof.fence);});
   observe(false,false);
   try{const result=write();if(result&&typeof(result as {then?:unknown}).then==='function'){void Promise.resolve(result).catch(()=>{});throw Error('ASYNC_BINDING_TOOLS_WRITE_UNSUPPORTED');}observe(true,true);}
   catch(error){if((error as Error).message!=='ASYNC_BINDING_TOOLS_WRITE_UNSUPPORTED')observe(true,false);throw error;}
  },
  observeStep(step:{step:string;state:string;detail:string|null}){
   if(finished||!['create-thread','create-session','deliver-charter','session-identity','charter-execution'].includes(step.step))return;
   transaction(()=>{
    const row=assertNativeWriteIdentityWithin(store,proof),previous=row.evidence_json?JSON.parse(String(row.evidence_json)):{};
    const phase=step.step==='deliver-charter'||step.step==='charter-execution'?'charter':step.state==='observed'?'created':String(row.phase);
    const observation={...previous,sourceId:input.operationId,lastStep:{name:step.step,state:step.state}};
    if(step.state==='observed'&&step.detail){if(step.step==='session-identity')observation.sessionRef=JSON.parse(step.detail);else if(['create-thread','create-session'].includes(step.step))observation.nativeConversationId=step.detail;else if(step.step==='charter-execution')observation.nativeExecutionId=step.detail;}
    store.db.prepare('UPDATE native_write_effects SET phase=?,evidence_json=?,updated_at=? WHERE id=? AND owner_key=? AND fence=?').run(phase,JSON.stringify(observation),input.now(),proof.id,proof.ownerKey,proof.fence);
   });
  },
  complete(outcome:FactoryBoundSession){
   if(finished)return;
   assertOutcome(outcome);
   const terminal=outcome.charterDelivered===true&&typeof outcome.nativeTurnId==='string'&&outcome.nativeTurnId.length>0;
   transaction(()=>finishNativeWriteWithin(store,proof,terminal?'terminal':'unknown',{sourceId:input.operationId,nativeConversationId:outcome.nativeSessionId,nativeExecutionId:outcome.nativeTurnId,sessionRef:outcome.sessionRef,terminalConfirmed:terminal,charterDelivered:outcome.charterDelivered===true},input.now()));finished=true;
  },
 };
}

/** 已创建会话的工具配置修复仅做同步本地写入，不具备创建/模型输入入口。 */
export function withBindingToolsWrite(store:Store,input:{projectId:string;roleId:string;operationId:string;bindingId:string;bindingEpoch:number;workspaceRoot:string;admission:()=>void;now:()=>number},write:()=>unknown){
 const proof=store.transaction(()=>{input.admission();reconcileFactoryWriteWithin(store,{projectId:input.projectId,roleId:input.roleId,sourceId:input.operationId,bindingId:input.bindingId,bindingEpoch:input.bindingEpoch,targetRoot:input.workspaceRoot},input.now());return reserveNativeWriteWithin(store,{projectId:input.projectId,roleId:input.roleId,kind:'factory',purpose:'binding-tools',sourceId:input.operationId,targetRoot:input.workspaceRoot,bindingId:input.bindingId,bindingEpoch:input.bindingEpoch},input.now());});
 try{
  store.transaction(()=>{input.admission();assertNativeWriteWithin(store,proof);activateNativeWriteWithin(store,proof,'created',input.now());});
  const result=write();
  if(result&&typeof(result as {then?:unknown}).then==='function'){void Promise.resolve(result).catch(()=>{});throw Error('ASYNC_BINDING_TOOLS_WRITE_UNSUPPORTED');}
  store.transaction(()=>{assertNativeWriteWithin(store,proof);finishNativeWriteWithin(store,proof,'local_terminal',{sourceId:input.operationId,localWriteCompleted:true},input.now());});
 }catch(error){
  // 同步本地写调用已返回/抛错；若出现异步不明调用则保留unknown，绝不推断完成。
  store.transaction(()=>finishNativeWriteWithin(store,proof,(error as Error).message==='ASYNC_BINDING_TOOLS_WRITE_UNSUPPORTED'?'unknown':'local_terminal',{sourceId:input.operationId,localWriteCompleted:(error as Error).message!=='ASYNC_BINDING_TOOLS_WRITE_UNSUPPORTED',localWriteSucceeded:false},input.now()));throw error;
 }
}

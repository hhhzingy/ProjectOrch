import type {Store} from '@projectorch/persistence';
import {issueAgentCredentialWithin,type AgentPrincipal} from './agent-credential.js';

/** 受信驱动在原尝试发送前签发；仅有绑定凭据不能自报一个原生执行ID。 */
export function issueRoleTurnCredential(store:Store,bindingId:string,attemptId:string,now:number){
 return store.transaction(db=>{
  const row=db.prepare(`SELECT b.epoch,s.harness_id,s.host_id,s.profile_id,s.native_conversation_id,s.native_workspace_id,a.project_id
   FROM attempts a JOIN role_bindings b ON b.id=a.binding_id AND b.project_id=a.project_id AND b.epoch=a.binding_epoch AND b.ended_at IS NULL
   JOIN sessions s ON s.id=b.session_id JOIN execution_dispatches d ON d.attempt_id=a.id AND d.binding_id=b.id
   WHERE a.id=? AND b.id=? AND a.state='dispatching' AND d.phase='sending' AND a.native_execution_id IS NULL`).get(attemptId,bindingId);
  if(!row)throw Error('ROLE_TURN_DISPATCH_REQUIRED');
  const session={harnessId:String(row.harness_id),hostId:String(row.host_id),profileId:String(row.profile_id),nativeConversationId:String(row.native_conversation_id),...(row.native_workspace_id?{nativeWorkspaceId:String(row.native_workspace_id)}:{})};
  const issued=issueAgentCredentialWithin(store,bindingId,Number(row.epoch),{isolation:'verified_session',session},now,86400000);
  db.prepare('INSERT INTO role_turn_credentials(credential_id,project_id,attempt_id,binding_id,binding_epoch) VALUES(?,?,?,?,?)').run(issued.credential.split('.')[0]??'',String(row.project_id),attemptId,bindingId,Number(row.epoch));
  return issued.credential;
 });
}
export function roleTurnExecution(store:Store,principal:AgentPrincipal):string|undefined{
 const row=store.db.prepare(`SELECT a.native_execution_id,a.state,d.phase FROM role_turn_credentials c
  JOIN attempts a ON a.id=c.attempt_id AND a.project_id=c.project_id AND a.binding_id=c.binding_id AND a.binding_epoch=c.binding_epoch
  JOIN execution_dispatches d ON d.attempt_id=a.id AND d.native_execution_id=a.native_execution_id
  WHERE c.credential_id=? AND c.project_id=? AND c.binding_id=? AND c.binding_epoch=?`).get(principal.credentialId,principal.projectId,principal.bindingId,principal.bindingEpoch);
 if(!row){if(store.db.prepare('SELECT 1 FROM role_turn_credentials WHERE credential_id=?').get(principal.credentialId))throw Error('ROLE_TURN_NOT_CURRENT');return undefined;}
 if(row.state!=='running'||row.phase!=='running'||!row.native_execution_id)throw Error('ROLE_TURN_NOT_CURRENT');
 return String(row.native_execution_id);
}

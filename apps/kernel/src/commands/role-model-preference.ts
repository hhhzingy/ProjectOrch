import {randomUUID} from 'node:crypto';
import type {Store} from '@projectorch/persistence';
import {parseRoleModelPreferenceCommand,reserveRoleModelPreferenceCommand,commitCommandReceipt} from '@projectorch/persistence/commands';
import {setRoleModelPreferenceWithin} from '@projectorch/domain/roles';
import {enqueueWorkflowCandidatesWithin} from '../execution/workflow-intents.js';

const effectiveNote='配置已保存；下个安全轮次发送前通过官方接口核验。保存不代表实际生效，未解析或接口拒绝会保持阻塞。跟随默认模型也不改变项目权限、预算或用户暂停。';

/** 本机用户配置命令：双版本、持久幂等、历史、事件和新评估候选同事务。 */
export function configureRoleModelPreference(store:Store,principalId:string,raw:unknown,now:number,assertAuthorized:()=>void){
 const input=parseRoleModelPreferenceCommand(raw);
 return store.transaction(db=>{
  const authorization:unknown=assertAuthorized();if(authorization&&typeof (authorization as {then?:unknown}).then==='function'){void Promise.resolve(authorization).catch(()=>undefined);throw new Error('ASYNC_MODEL_AUTHORIZATION_FORBIDDEN');}
  if(!db.prepare('SELECT 1 FROM roles WHERE project_id=? AND id=?').get(input.projectId,input.roleId))throw new Error('ROLE_NOT_FOUND');
  const reservation=reserveRoleModelPreferenceCommand(db,principalId,randomUUID(),input,now);
  if(reservation.replay){
   const history=db.prepare('SELECT revision,role_revision,requested_json,resolved_json FROM role_model_revisions WHERE command_id=? AND project_id=? AND role_id=?').get(reservation.commandId,input.projectId,input.roleId);
   if(!history)throw new Error('MODEL_RECEIPT_INCOMPLETE');
   return {roleId:input.roleId,revision:Number(history.role_revision),modelRevision:Number(history.revision),modelRequested:history.requested_json?JSON.parse(String(history.requested_json)):null,modelResolved:history.resolved_json?JSON.parse(String(history.resolved_json)):null,effectiveNote,receipt:reservation.receipt};
  }
  const requested=input.resetToDefault===true?null:{raw:input.modelRequested!,recordedAt:now};
  const modelId=input.modelId||null,reasoningLevel=input.reasoningLevel||null;
  const resolved=input.resetToDefault===true||(!modelId&&!reasoningLevel)?null:{modelId,reasoningLevel,basis:'user-specified',resolvedAt:now};
  const saved=setRoleModelPreferenceWithin(db,input.projectId,input.roleId,requested,resolved,now,{expectedRevision:input.expectedRevision,expectedModelRevision:input.expectedModelRevision,commandId:reservation.commandId,sourcePrincipalId:principalId});
  const taskIds=db.prepare("SELECT id FROM tasks WHERE project_id=? AND role_id=? AND state IN ('draft','ready')").all(input.projectId,input.roleId).map(t=>String(t.id));
  enqueueWorkflowCandidatesWithin(db,input.projectId,reservation.commandId,now,taskIds,true);
  const sequence=Number(db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM events WHERE project_id=?').get(input.projectId)?.n);
  const receipt=commitCommandReceipt(db,principalId,reservation.commandId,{requestId:input.requestId,projectId:input.projectId,commandId:reservation.commandId,status:'completed',receiptUrl:`/api/v1/commands/${reservation.commandId}/receipt`,entityIds:[{localRef:input.roleId,entityType:'role',id:input.roleId,revision:saved.revision,version:null}],lastEventSequence:sequence,error:null});
  return {roleId:input.roleId,...saved,modelRequested:requested,modelResolved:resolved,effectiveNote,receipt};
 });
}

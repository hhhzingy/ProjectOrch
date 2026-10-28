import {createHash} from 'node:crypto';
import type {Store} from '@projectorch/persistence';
import {canonicalJson} from '@projectorch/persistence/outbox';
import {sendMessageWithin} from '@projectorch/domain/messages';
import {authorizeAgentAction} from '../auth/policy-check.js';
import type {AgentPrincipal} from '../auth/agent-credential.js';
import {readProjectPolicy} from '../auth/project-policy.js';
import {assertMessageSenderAuthorized} from './message-authorization.js';

/** 计划变化后只通知原角色读取并自己确认；不替角色写startup_ack。每绑定/版本/任务集只排队一次。 */
export function enqueueStartupNoticeWithin(store:Store,input:{projectId:string;taskId:string;commandId:string;now:number;principalForBinding:(id:string)=>AgentPrincipal;trustedLocalUserId?:string}):boolean{
 const db=store.db;if(!db.isTransaction)throw Error('WORKFLOW_TRANSACTION_REQUIRED');
 const row=db.prepare(`SELECT b.id binding_id,b.epoch,r.id role_id,r.revision role_revision,p.plan_revision,p.policy_revision,p.user_paused FROM tasks t JOIN roles r ON r.id=t.role_id AND r.project_id=t.project_id JOIN role_bindings b ON b.role_id=r.id AND b.project_id=r.project_id AND b.ended_at IS NULL JOIN projects p ON p.id=r.project_id WHERE t.id=? AND t.project_id=? AND r.desired_state='enabled' AND r.binding_state='ready'`).get(input.taskId,input.projectId);
 if(!row||row.user_paused===1||readProjectPolicy(db,input.projectId).nativeMode!=='verified_only'||db.prepare("SELECT 1 FROM goal_holds WHERE project_id=? AND state IN ('pending','awaiting_user')").get(input.projectId))return false;
 const principal=input.principalForBinding(String(row.binding_id));
 const allowed=(action:string,path?:string,kind:'read'|'write'='read')=>authorizeAgentAction(store,principal,undefined,{action,targetProjectId:input.projectId,kind,...(path?{path}:{})},input.now).allowed;
 if(principal.bindingId!==row.binding_id||principal.roleId!==row.role_id||!allowed('project.read')||!allowed('policy.read')||!allowed('role.read',`roles/${String(row.role_id)}`)||!allowed('role.startup_ack',undefined,'write')||!allowed('task.read',`tasks/${input.taskId}`))return false;
 const taskSpecRevisions=db.prepare("SELECT id,spec_revision FROM tasks WHERE project_id=? AND role_id=? AND state NOT IN ('accepted','cancelled') ORDER BY id").all(input.projectId,String(row.role_id)).filter(t=>allowed('task.read',`tasks/${String(t.id)}`)).map(t=>({taskId:String(t.id),specRevision:Number(t.spec_revision)}));
 const snapshot={bindingId:row.binding_id,bindingEpoch:row.epoch,roleRevision:row.role_revision,policyRevision:row.policy_revision,planRevision:row.plan_revision,taskSpecRevisions};
 const id='startup-notice-'+createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
 if(db.prepare('SELECT 1 FROM messages WHERE id=?').get(id))return false;
 const body=`版本确认通知（程序排队，不代表你已握手或任务已执行）：${canonicalJson(snapshot)}。请在本原生会话读取projectorch_project_snapshot、projectorch_policy_read、projectorch_role_read（本人）以及上述本人任务的projectorch_task_read，实际核对最新职责/计划/策略/规格。然后用projectorch_role_startup_ack提交requestId、protocolVersion=2、policyRevision、planRevision、roleRevision、taskSpecRevisions（taskId/specRevision）；role/binding身份由连接固定。预告水位不能代替当前读取，版本改变须按真实值核对。仅完成版本确认，不在本消息轮领取/执行任务，不提交业务结果；程序随后正常派发。失败如实结束，不循环催办/扩权/解除暂停。`;
 db.exec('SAVEPOINT startup_notice');
 try{sendMessageWithin(db,{id,projectId:input.projectId,commandId:input.commandId,toRoleId:String(row.role_id),kind:'information',body},input.now);assertMessageSenderAuthorized(store,id,input.now,input.trustedLocalUserId);db.exec('RELEASE startup_notice');return true;}
 catch{db.exec('ROLLBACK TO startup_notice; RELEASE startup_notice');return false;}
}

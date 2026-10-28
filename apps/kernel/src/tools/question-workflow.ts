import {randomUUID} from 'node:crypto';
import type {Store} from '@projectorch/persistence';
import {parseContract,type ContractRegistry} from '@projectorch/contracts';
import type {AgentPrincipal} from '../auth/agent-credential.js';
import {readProjectPolicy} from '../auth/project-policy.js';
import {sendMessageWithin} from '@projectorch/domain/messages';

type Db=Store['db'];
type Payload<K>=Extract<ContractRegistry['command'],{type:K}>['payload'];
export function questionContract(db:Db,projectId:string,questionId:string){
 const q=db.prepare('SELECT * FROM questions WHERE id=? AND project_id=?').get(questionId,projectId);
 if(!q)throw Error('QUESTION_NOT_FOUND');
 if(!q.ask_command_id||!q.on_timeout)throw Error('QUESTION_LEGACY_REQUIRES_REPAIR');
 const answer=q.answer===null?null:JSON.parse(String(q.answer));
 if(answer!==null&&typeof answer!=='string')throw Error('QUESTION_LEGACY_REQUIRES_REPAIR');
 return parseContract('question',{id:String(q.id),projectId:String(q.project_id),revision:Number(q.revision),taskId:String(q.task_id),taskRevision:Number(q.task_revision),attemptId:String(q.attempt_id),bindingEpoch:Number(q.binding_epoch),prompt:String(q.prompt),answerer:q.answerer_kind==='user'?{kind:'user'}:{kind:'role',roleId:String(q.answerer_role_id)},deadline:new Date(Number(q.deadline)).toISOString(),onTimeout:q.on_timeout,state:q.state,answer});
}
function currentContext(db:Db,q:Record<string,unknown>){
 return db.prepare(`SELECT a.state AS attempt_state,a.native_execution_id,b.role_id,t.state AS task_state,t.revision AS entity_revision
 FROM attempts a JOIN role_bindings b ON b.id=a.binding_id AND b.project_id=a.project_id AND b.epoch=a.binding_epoch AND b.ended_at IS NULL
 JOIN tasks t ON t.id=a.task_id AND t.project_id=a.project_id AND t.role_id=b.role_id AND t.spec_revision=a.task_revision
 WHERE a.id=? AND a.project_id=? AND a.task_id=? AND a.task_revision=? AND a.binding_id=? AND a.binding_epoch=?
 AND t.state NOT IN ('cancelled','accepted')
 AND NOT EXISTS(SELECT 1 FROM attempts newer WHERE newer.project_id=a.project_id AND newer.task_id=a.task_id AND newer.rowid>a.rowid)`)
 .get(String(q.attempt_id),String(q.project_id),String(q.task_id),Number(q.task_revision),String(q.binding_id),Number(q.binding_epoch));
}
export function askQuestionWithin(store:Store,principal:AgentPrincipal,payload:Payload<'question.ask'>,commandId:string,executionId:string|undefined,now:number,canNotify:boolean){
 const db=store.db;if(!db.isTransaction)throw Error('QUESTION_TRANSACTION_REQUIRED');
 const deadline=Date.parse(payload.deadline);if(!Number.isSafeInteger(deadline)||deadline<=now)throw Error('QUESTION_DEADLINE_EXPIRED');
 if(payload.bindingEpoch!==principal.bindingEpoch||!executionId)throw Error('QUESTION_EXECUTION_NOT_CURRENT');
 const attempt=db.prepare(`SELECT 1 FROM attempts a JOIN tasks t ON t.id=a.task_id AND t.project_id=a.project_id AND t.role_id=? AND t.spec_revision=a.task_revision
 WHERE a.id=? AND a.project_id=? AND a.task_id=? AND a.task_revision=? AND a.binding_id=? AND a.binding_epoch=? AND a.native_execution_id=? AND a.state='running' AND t.state IN ('active','waiting')`).get(principal.roleId,payload.attemptId,principal.projectId,payload.taskId,payload.taskRevision,principal.bindingId,principal.bindingEpoch,executionId);
 if(!attempt)throw Error('QUESTION_EXECUTION_NOT_CURRENT');
 if(payload.answerer.kind==='role'&&!db.prepare('SELECT 1 FROM roles WHERE id=? AND project_id=?').get(payload.answerer.roleId,principal.projectId))throw Error('QUESTION_ANSWERER_NOT_FOUND');
 const policy=readProjectPolicy(db,principal.projectId),count=Number(db.prepare('SELECT COUNT(*) AS n FROM questions WHERE project_id=? AND attempt_id=?').get(principal.projectId,payload.attemptId)?.n);
 if(count>=policy.limits.maxManagementRounds)throw Error('QUESTION_ROUND_LIMIT_EXCEEDED');
 const id='question-'+randomUUID();
 db.prepare("INSERT INTO questions(id,project_id,task_id,task_revision,attempt_id,binding_id,binding_epoch,answerer_kind,answerer_role_id,prompt,answer,deadline,state,ask_command_id,on_timeout) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,'open',?,?)").run(id,principal.projectId,payload.taskId,payload.taskRevision,payload.attemptId,principal.bindingId,principal.bindingEpoch,payload.answerer.kind,payload.answerer.kind==='role'?payload.answerer.roleId:null,payload.prompt,deadline,commandId,payload.onTimeout);
 if(canNotify&&payload.answerer.kind==='role')sendMessageWithin(db,{id:'question-notice-'+randomUUID(),projectId:principal.projectId,commandId,toRoleId:payload.answerer.roleId,taskId:payload.taskId,kind:'question_notice',body:'业务问题通知：'+JSON.stringify({questionId:id,taskId:payload.taskId,prompt:payload.prompt})+'。请用question.read核对，再以指定角色调用question.answer；通知不是原生审批或用户授权。'},now);
 return questionContract(db,principal.projectId,id);
}
/** 被指定主体回答；只保存业务答案，不伪造原生停止、恢复或任务通过。 */
export function answerQuestionWithin(store:Store,principal:{kind:'authenticated_user'}|{kind:'bound_agent';roleId:string},projectId:string,payload:Payload<'question.answer'>,commandId:string,now:number,canNotify:boolean){
 const db=store.db;if(!db.isTransaction)throw Error('QUESTION_TRANSACTION_REQUIRED');
 const q=db.prepare('SELECT * FROM questions WHERE id=? AND project_id=?').get(payload.questionId,projectId);
 if(!q)throw Error('QUESTION_NOT_FOUND');
 questionContract(db,projectId,payload.questionId);
 if(q.answerer_kind==='user'?principal.kind!=='authenticated_user':principal.kind!=='bound_agent'||principal.roleId!==q.answerer_role_id)throw Error('QUESTION_NOT_ADDRESSEE');
 if(q.revision!==payload.expectedRevision)throw Error('QUESTION_REVISION_CONFLICT');
 if(q.state!=='open')throw Error('QUESTION_NOT_OPEN');
 if(Number(q.deadline)<=now)throw Error('QUESTION_DEADLINE_EXPIRED');
 db.prepare("UPDATE questions SET answer=?,state='answered',revision=revision+1,answer_command_id=?,answered_at=? WHERE id=? AND project_id=? AND revision=? AND state='open'").run(JSON.stringify(payload.answer),commandId,now,payload.questionId,projectId,payload.expectedRevision);
 // 答案可由正在运行的原角色读取；缺少已验证steering时不启动独立消息轮抢占该会话。
 void canNotify;
 return questionContract(db,projectId,payload.questionId);
}
export function questionContext(db:Db,question:Record<string,unknown>){return currentContext(db,question);}

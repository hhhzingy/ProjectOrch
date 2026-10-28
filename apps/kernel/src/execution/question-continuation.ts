import {randomUUID} from 'node:crypto';
import type {Store} from '@projectorch/persistence';
import {raiseIssueWithin} from '@projectorch/domain/issues';
import {questionContext} from '../tools/question-workflow.js';
import {enqueueWorkflowCandidatesWithin} from './workflow-intents.js';

/** 只处理有固定合同来源的问题；业务等待和原生终态分开，不借答复/超时释放unknown。 */
export function advanceQuestionWorkflow(store:Store,now:number,limit=64){
 if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(limit)||limit<1||limit>256)throw Error('INVALID_QUESTION_PUMP');
 return store.transaction(db=>{
  let resolved=0,resumed=0,expired=0,stale=0;
  const emit=(q:Record<string,unknown>,type:string,commandId:string,body:unknown)=>db.prepare('INSERT INTO events(id,project_id,type,entity_id,entity_revision,causation_id,body_json,occurred_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),String(q.project_id),type,String(q.id),Number(db.prepare('SELECT revision FROM questions WHERE id=?').get(String(q.id))?.revision),commandId,JSON.stringify(body),now);
  const questions=db.prepare(`SELECT q.* FROM questions q WHERE q.ask_command_id IS NOT NULL AND (
   (q.state='open' AND (q.deadline<=? OR EXISTS(SELECT 1 FROM waits w WHERE w.project_id=q.project_id AND w.attempt_id=q.attempt_id AND w.state='waiting' AND w.deadline<=? AND json_extract(w.target_json,'$.kind')='question' AND json_extract(w.target_json,'$.questionId')=q.id)))
   OR (q.state='answered' AND EXISTS(SELECT 1 FROM waits w
    JOIN tasks t ON t.id=w.task_id AND t.project_id=w.project_id
    JOIN attempts a ON a.id=w.attempt_id AND a.project_id=w.project_id
    JOIN projects p ON p.id=w.project_id
    LEFT JOIN roles r ON r.id=t.role_id AND r.project_id=t.project_id
    WHERE w.project_id=q.project_id AND w.attempt_id=q.attempt_id
    AND ((w.state='waiting' AND a.state<>'unknown') OR (w.state='resolved' AND t.state='waiting'
      AND a.state NOT IN ('running','dispatching','waiting_input','unknown') AND p.user_paused=0 AND r.desired_state='enabled'
      AND NOT EXISTS(SELECT 1 FROM goal_holds h WHERE h.project_id=p.id AND h.state IN ('pending','awaiting_user'))))
    AND json_extract(w.target_json,'$.kind')='question' AND json_extract(w.target_json,'$.questionId')=q.id)))
   ORDER BY CASE q.state WHEN 'open' THEN 0 ELSE 1 END,q.deadline,q.id LIMIT ?`).all(now,now,limit);
  for(const q of questions){
   const context=questionContext(db,q),projectId=String(q.project_id),commandId=String(q.answer_command_id??q.ask_command_id);
   const waits=db.prepare("SELECT * FROM waits WHERE project_id=? AND attempt_id=? AND binding_id=? AND binding_epoch=? AND task_revision=? AND state IN ('waiting','resolved') AND json_extract(target_json,'$.kind')='question' AND json_extract(target_json,'$.questionId')=?").all(projectId,String(q.attempt_id),String(q.binding_id),Number(q.binding_epoch),Number(q.task_revision),String(q.id));
   // 旧规格/换绑/新attempt后只使旧等待过期，不重开任何新任务。
   if(!context||['failed','interrupted'].includes(String(context.attempt_state))){
    for(const wait of waits){const change=db.prepare("UPDATE waits SET state='stale' WHERE id=? AND state IN ('waiting','resolved')").run(String(wait.id));stale+=Number(change.changes);}
    if(q.state==='open'){db.prepare("UPDATE questions SET state='cancelled',revision=revision+1 WHERE id=? AND state='open'").run(String(q.id));emit(q,'question.stale',commandId,{reason:'context_changed'});}continue;
   }
   if(q.state==='open'){
    db.prepare("UPDATE questions SET state='expired',revision=revision+1 WHERE id=? AND state='open'").run(String(q.id));expired++;
    for(const wait of waits)db.prepare("UPDATE waits SET state='expired' WHERE id=? AND state='waiting'").run(String(wait.id));
    if(q.on_timeout==='raise_issue')raiseIssueWithin(db,{id:'question-timeout-'+randomUUID(),projectId,taskId:String(q.task_id),ownerRoleId:String(context.role_id),fingerprint:'question-timeout:'+String(q.id),evidence:{questionId:q.id,taskSpecRevision:q.task_revision,reason:'deadline_expired'}},now);
    else if(q.on_timeout==='cancel_attempt'){
     if(['running','dispatching','waiting_input','unknown'].includes(String(context.attempt_state)))db.prepare("INSERT INTO native_control_requests(id,project_id,attempt_id,binding_id,binding_epoch,expected_native_execution_id,task_spec_revision,kind,state,created_at) VALUES(?,?,?,?,?,?,?,'stop','pending',?) ON CONFLICT(attempt_id,task_spec_revision,kind) DO NOTHING").run(randomUUID(),projectId,String(q.attempt_id),String(q.binding_id),Number(q.binding_epoch),context.native_execution_id??null,Number(q.task_revision),now);
     // 原生轮已结束时只能阻塞业务，不能伪报一次已停止确认。
     if(context.task_state==='waiting')db.prepare("UPDATE tasks SET state='blocked',revision=revision+1 WHERE id=? AND project_id=? AND state='waiting'").run(String(q.task_id),projectId);
    }
    emit(q,'question.expired',commandId,{onTimeout:q.on_timeout,nativeTerminal:'not_asserted'});continue;
   }
   if(context.attempt_state==='unknown')continue;
   for(const wait of waits){
    const target=JSON.parse(String(wait.target_json));
    if(target.questionRevision!==Number(q.revision)-1){db.prepare("UPDATE waits SET state='stale' WHERE id=? AND state IN ('waiting','resolved')").run(String(wait.id));stale++;continue;}
    const change=db.prepare("UPDATE waits SET state='resolved' WHERE id=? AND state='waiting'").run(String(wait.id));resolved+=Number(change.changes);
   }
   const project=db.prepare('SELECT user_paused FROM projects WHERE id=?').get(projectId);
   const role=db.prepare('SELECT desired_state FROM roles WHERE id=? AND project_id=?').get(String(context.role_id),projectId);
   if(context.attempt_state!=='succeeded'||context.task_state!=='waiting'||project?.user_paused||role?.desired_state!=='enabled'||db.prepare("SELECT 1 FROM goal_holds WHERE project_id=? AND state IN ('pending','awaiting_user')").get(projectId))continue;
   if(db.prepare("SELECT 1 FROM waits WHERE project_id=? AND attempt_id=? AND state IN ('waiting','stale','expired','cancelled')").get(projectId,String(q.attempt_id)))continue;
   if(!waits.some(w=>w.state==='resolved'||JSON.parse(String(w.target_json)).questionRevision===Number(q.revision)-1))continue;
   const changed=db.prepare("UPDATE tasks SET state='ready',revision=revision+1 WHERE id=? AND project_id=? AND state='waiting' AND revision=?").run(String(q.task_id),projectId,Number(context.entity_revision));
   if(changed.changes){enqueueWorkflowCandidatesWithin(db,projectId,commandId,now,[String(q.task_id)]);emit(q,'question.continuation_ready',commandId,{taskId:q.task_id,fromAttempt:q.attempt_id,bindingId:q.binding_id,bindingEpoch:q.binding_epoch});resumed++;}
  }
  return {resolved,resumed,expired,stale};
 });
}

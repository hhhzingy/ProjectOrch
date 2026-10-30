import type {Store} from '@projectorch/persistence';

const reasons:Readonly<Record<string,string>>={MODEL_SELECTION_UNRESOLVED:'模型请求尚未解析',MODEL_SELECTION_UNAVAILABLE:'官方模型选择未通过',COST_ENFORCEMENT_UNAVAILABLE:'费用上限尚无官方执行证明',DISPATCH_CONCURRENCY_EXCEEDED:'并发容量已占用（含未知工厂/消息）',DISPATCH_ATTEMPTS_EXCEEDED:'尝试预算已达到',WORKSPACE_CONFLICT:'工作目录被未决执行占用',STARTUP_REQUIRED:'当前版本启动握手未完成',STARTUP_TASK_SPEC_REQUIRED:'握手缺少当前任务规格',TASK_START_CONDITIONS_UNMET:'前置条件或规格影响未满足',NATIVE_EXECUTION_DISABLED:'项目原生执行未启用',NATIVE_CAPABILITY_UNVERIFIED:'当前适配器缺少所需能力',PATH_ENFORCEMENT_UNAVAILABLE:'要求的路径强隔离不可执行',DISPATCH_HELD:'目标变更等待用户决定',WORKFLOW_PREPARATION_FAILED:'准备失败，需要查看固定诊断',DISPATCH_FORBIDDEN:'当前角色或项目授权未通过'};

/** 监督投影只读；旧候选的原因必须匹配当前任务双版本，不触发派发或修复。 */
export function roleSupervisionState(store:Store,projectId:string,roleId:string){
 const db=store.db,project=db.prepare('SELECT user_paused,policy_json FROM projects WHERE id=?').get(projectId),role=db.prepare('SELECT desired_state,binding_state,model_requested_json,model_resolved_json FROM roles WHERE id=? AND project_id=?').get(roleId,projectId);
 if(!project||!role)throw Error('SUPERVISION_ROLE_NOT_FOUND');
 const policy=JSON.parse(String(project.policy_json));
 const active=db.prepare("SELECT a.task_id AS taskId,a.state AS state FROM attempts a JOIN role_bindings b ON b.id=a.binding_id AND b.project_id=a.project_id WHERE a.project_id=? AND b.role_id=? AND a.state IN ('dispatching','running','waiting_input','unknown') ORDER BY CASE a.state WHEN 'unknown' THEN 0 ELSE 1 END,a.started_at,a.id LIMIT 1").get(projectId,roleId);
 const reviews=Number(db.prepare(`SELECT COUNT(DISTINCT t.id) AS n FROM tasks t, json_each(t.acceptance_json) rule WHERE t.project_id=? AND t.state='review' AND json_extract(rule.value,'$.mode')='designated_reviewer' AND json_extract(rule.value,'$.reviewerRoleId')=? AND EXISTS(SELECT 1 FROM results r JOIN attempts a ON a.id=r.attempt_id AND a.project_id=r.project_id WHERE r.project_id=t.project_id AND r.task_id=t.id AND r.task_revision=t.spec_revision AND r.eligibility='current' AND a.state='succeeded')`).get(projectId,roleId)?.n??0);
 let waitingReason:string|null=null,nextAction='无待执行任务',decisionBy:string|null=null;
 if(active){waitingReason=active.state==='unknown'?'未知执行待核对':active.state==='waiting_input'?'执行等待输入':'执行中';nextAction=active.state==='unknown'?'只读核对原执行，不重发':'观察当前原生轮次';decisionBy='内核/原生会话';}
 else if(project.user_paused){waitingReason='用户暂停项目';nextAction='等待用户恢复';decisionBy='用户';}
 else if(db.prepare("SELECT 1 FROM goal_holds WHERE project_id=? AND state IN ('pending','awaiting_user')").get(projectId)){waitingReason='目标变更等待用户决定';nextAction='处理待决目标';decisionBy='用户';}
 else if(role.desired_state!=='enabled'){waitingReason='角色未启用';nextAction='等待用户或已授权管理者';decisionBy='用户/管理角色';}
 else if(policy.nativeMode!=='verified_only'){waitingReason='项目原生执行未启用';nextAction='保持手动管理';decisionBy='用户';}
 else if(role.binding_state!=='ready'){waitingReason='原生绑定未就绪';nextAction='接纳/核验并完成原绑定握手';decisionBy='受信工厂/内核';}
 else if(policy.limits?.costCeiling!==null&&policy.limits?.costCeiling!==undefined){waitingReason='费用上限尚无官方执行证明';nextAction='等待受支持能力或用户调整限制';decisionBy='用户';}
 else if(role.model_requested_json&&!role.model_resolved_json){waitingReason='模型请求尚未解析';nextAction='明确可支持模型或跟随默认';decisionBy='用户/受信配置';}
 else if(reviews){waitingReason='有已完成执行的成果待本角色复核';nextAction=`复核成果（${reviews}项）`;decisionBy=roleId;}
 else if(db.prepare("SELECT 1 FROM tasks WHERE project_id=? AND role_id=? AND state IN ('draft','ready')").get(projectId,roleId)){
  const evaluation=db.prepare(`SELECT e.code,e.decision FROM workflow_evaluations e JOIN outbox o ON o.id=e.outbox_id JOIN tasks t ON t.id=e.task_id AND t.project_id=e.project_id WHERE e.project_id=? AND t.role_id=? AND t.state IN ('draft','ready') AND json_extract(o.payload_json,'$.taskRevision')=t.revision AND json_extract(o.payload_json,'$.specRevision')=t.spec_revision ORDER BY e.checked_at DESC,e.outbox_id LIMIT 1`).get(projectId,roleId);
  if(evaluation&&['blocked','exhausted'].includes(String(evaluation.decision))){waitingReason=reasons[String(evaluation.code)]??'准入尚未通过，查看工作流诊断';nextAction=evaluation.decision==='exhausted'?'处理准备失败后重新评估':'等待阻塞解除并重新评估';decisionBy='内核/负责角色';}
  else{nextAction='等待准入评估';decisionBy='内核';}
 }
 return {currentTask:active?String(active.taskId):null,attemptState:active?String(active.state):null,waitingReason,nextAction,decisionBy,pendingReviews:reviews};
}

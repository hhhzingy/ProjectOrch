import type {Store} from '@projectorch/persistence';

/** 持久评估次数轮转：先项目，再管理/执行类别；单项目海量待办不挤掉其他项目。
 * 管理分类取当前档案change.apply授权，不使用任务ID或模型自报角色。这里只排序，不授予权限/槽位。 */
export function selectFairWorkflowCandidate(db:Store['db'],now:number){
 return db.prepare(`
 WITH classified AS (
  SELECT o.id,o.command_id,o.payload_json,o.next_attempt_at,c.project_id,c.state AS command_state,
   CASE WHEN EXISTS(
    SELECT 1 FROM json_each(CASE WHEN json_valid(p.policy_json) THEN p.policy_json ELSE '{}' END,'$.profiles') profile,
     json_each(profile.value,'$.actions') action
    WHERE json_extract(profile.value,'$.id')=r.permission_profile
     AND json_extract(profile.value,'$.revision')=r.permission_profile_revision
     AND action.value='change.apply'
   ) THEN 1 ELSE 0 END AS management
  FROM outbox o JOIN commands c ON c.id=o.command_id
  JOIN projects p ON p.id=c.project_id
  LEFT JOIN tasks t ON t.id=json_extract(o.payload_json,'$.taskId') AND t.project_id=c.project_id
  LEFT JOIN roles r ON r.id=t.role_id AND r.project_id=t.project_id
  WHERE json_extract(o.payload_json,'$.event')='workflow.evaluate'
 ), served AS (
  SELECT c.project_id,c.management,SUM(e.check_count) AS n
  FROM workflow_evaluations e JOIN classified c ON c.id=e.outbox_id GROUP BY c.project_id,c.management
 ), ranked AS (
  SELECT c.*,COALESCE((SELECT SUM(n) FROM served s WHERE s.project_id=c.project_id),0) AS project_served,
   COALESCE((SELECT n FROM served s WHERE s.project_id=c.project_id AND s.management=c.management),0) AS class_served
  FROM classified c JOIN outbox o ON o.id=c.id WHERE o.state='pending' AND c.next_attempt_at<=?
 ) SELECT id,command_id,payload_json,project_id,command_state FROM ranked
 ORDER BY project_served,class_served,management DESC,next_attempt_at,id LIMIT 1
 `).get(now);
}

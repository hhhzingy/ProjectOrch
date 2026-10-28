// 仅用于组件回归的合成执行/裁决事实；不连接原生Harness，不作为真实验收证据。
import { createRole } from '../../packages/domain/dist/roles/index.js';
import { submitResult, decideAcceptance } from '../../packages/domain/dist/results/index.js';

export function seedDependencyResult(store, taskId, { projectId = 'p1', outputs = [], accepted = true, suffix = 'first' } = {}) {
  const key = `dependency-${projectId}`;
  if (!store.db.prepare('SELECT 1 FROM roles WHERE id=?').get(key)) {
    createRole(store, { id: key, projectId, name: 'synthetic dependency executor', charter: '组件测试', permissionProfileId: 'worker' }, 100);
    store.transaction(db => {
      db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES(?,'synthetic','host','test',?)").run(key, key);
      db.prepare('INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES(?,?,?,?,1,100)').run(key, projectId, key, key);
    });
  }
  const revision = Number(store.db.prepare('SELECT spec_revision FROM tasks WHERE id=? AND project_id=?').get(taskId, projectId).spec_revision);
  const id = `${key}-${taskId}-${revision}-${suffix}`;
  store.transaction(db => db.prepare("INSERT INTO attempts(id,project_id,task_id,task_revision,binding_id,binding_epoch,state,started_at,ended_at) VALUES(?,?,?,?,?,1,'succeeded',110,120)").run(id, projectId, taskId, revision, key));
  const result = submitResult(store, { id, projectId, taskId, taskRevision: revision, attemptId: id, outcome: 'succeeded', outputs, summary: 'synthetic result' }, 121);
  if (accepted) {
    decideAcceptance(store, { id: `accept-${id}`, projectId, resultId: id, decision: 'accept', reviewerPrincipalId: 'synthetic-user', evidence: { syntheticCheck: true }, rule: { mode: 'user' }, principal: { id: 'synthetic-user', kind: 'authenticated_user' } }, 122);
    // 生命周期接线另行验收；本测试同时保留真实裁决事实，不能仅改标签冒充验收。
    store.transaction(db => db.prepare("UPDATE tasks SET state='accepted',revision=revision+1 WHERE id=? AND project_id=?").run(taskId, projectId));
  }
  return result;
}

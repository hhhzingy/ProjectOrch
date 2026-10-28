/** A051：角色创建外部部分失败（bootstrap回执丢失）→恢复provisioning、检查已创建身份、
 * 只有绑定核验后调度、暂停/停用协调与待办转交。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { bootstrapRole, readBootstrapState, completeStartupAck } from '../../../packages/domain/dist/bootstrap/index.js';
import { escalateUnavailableRoleCases, raiseIssue } from '../../../packages/domain/dist/issues/index.js';
import { evaluateDispatch } from '../../../packages/domain/dist/dispatch-guard/index.js';
import { establishFirstBinding } from '../../../packages/domain/dist/native-binding/index.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-a051-', () => { for (const s of stores.splice(0)) { try { s.close(); } catch { /* 已关闭 */ } } });
  const store = openStore(path.join(dir, 'state.sqlite'));
  stores.push(store);
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: 'E:/synthetic/a051', objective: 'o' }, 100);
  return { store };
}

test('A051：回执丢失后恢复provisioning不重复创建；绑定核验前调度拒绝；暂停协调与待办转交', t => {
  const { store } = fixture(t);
  // bootstrap成功但回执丢失：重放同requestId幂等恢复
  const boot = bootstrapRole(store, { projectId: 'p1', localRef: 'r-rec', name: 'worker', charter: 'c', permissionProfileId: 'worker', permissionProfileRevision: 1, expectedPolicyRevision: 0, principalId: 'user-1', requestId: 'boot-1' }, 110);
  assert.equal(boot.replay, false);
  const recovered = bootstrapRole(store, { projectId: 'p1', localRef: 'r-rec', name: 'worker', charter: 'c', permissionProfileId: 'worker', permissionProfileRevision: 1, expectedPolicyRevision: 0, principalId: 'user-1', requestId: 'boot-1' }, 115);
  assert.equal(recovered.replay, true, '回执丢失重放恢复');
  assert.equal(recovered.role.id, 'r-rec', '同一角色不重复创建');
  // 检查已创建身份：provisioning状态可查询
  const state = readBootstrapState(store, 'p1');
  assert.equal(state.state, 'provisioning');
  assert.equal(state.roleId, 'r-rec');
  // 未绑定核验前调度拒绝（STARTUP_REQUIRED/STALE_BINDING）
  const denied = evaluateDispatch(store, { projectId: 'p1', roleId: 'r-rec', bindingEpoch: 1, taskId: 't', taskRevision: 1 });
  assert.equal(denied.allowed, false);
  assert.ok(denied.denials.some(d => d.code === 'STARTUP_REQUIRED' || d.code === 'STALE_BINDING'), '只有绑定核验后调度');
  // 绑定+握手后才可调度（STARTUP_REQUIRED消失）
  store.transaction(db => db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s1','synthetic','host','profile','native-1')").run());
  const binding = establishFirstBinding(store, { bindingId: 'b1', projectId: 'p1', roleId: 'r-rec', sessionId: 's1' }, 120);
  assert.equal(binding.epoch, 1);
  completeStartupAck(store, { projectId: 'p1', roleId: 'r-rec', bindingEpoch: 1, protocolVersion: 2, policyRevision: 0, planRevision: 0, roleRevision: store.db.prepare("SELECT revision FROM roles WHERE id='r-rec'").get().revision, taskSpecRevisions: [] }, 130);
  const after = evaluateDispatch(store, { projectId: 'p1', roleId: 'r-rec', bindingEpoch: 1, taskId: 't', taskRevision: 1 });
  assert.equal(after.denials.some(d => d.code === 'STARTUP_REQUIRED'), false, '握手后不再要求STARTUP');
});

test('A051：角色暂停/停用协调——承办事项升级转交；意图不替代真实运行（binding原样）', t => {
  const { store } = fixture(t);
  bootstrapRole(store, { projectId: 'p1', localRef: 'r-busy', name: 'busy', charter: 'c', permissionProfileId: 'worker', permissionProfileRevision: 1, expectedPolicyRevision: 0, principalId: 'user-1', requestId: 'boot-2' }, 110);
  raiseIssue(store, { id: 'c-owned', projectId: 'p1', taskId: null, ownerRoleId: 'r-busy', fingerprint: 'fp-busy', evidence: { detail: '进行中异常' } }, 115);
  // 角色暂停（意图）→承办事项沿有限路径升级转交
  store.db.prepare("UPDATE roles SET desired_state='paused' WHERE id='r-busy'").run();
  const escalation = escalateUnavailableRoleCases(store, { projectId: 'p1', roleId: 'r-busy' }, 120);
  assert.equal(escalation.escalated.length, 1, '待办明确转交（升级）');
  // 意图不替代真实运行：binding_state原样（unbound→未绑定即未真实运行）
  const role = store.db.prepare("SELECT desired_state,binding_state FROM roles WHERE id='r-busy'").get();
  assert.equal(role.desired_state, 'paused');
  assert.equal(role.binding_state, 'unbound', '状态字段不伪造真实运行状态');
});

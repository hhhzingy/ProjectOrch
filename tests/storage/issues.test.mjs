import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../packages/persistence/dist/index.js';
import { createProject } from '../../packages/domain/dist/projects/index.js';
import { raiseIssue, assignIssue, escalateIssue, resolveIssue, progressIssue, readIssue, listOpenIssues, escalateUnavailableRoleCases } from '../../packages/domain/dist/issues/index.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-issues-', () => { for (const s of stores) s.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const open = () => { const s = openStore(filename); stores.push(s); return s; };
  const store = open();
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: 'E:/synthetic/issues', objective: 'o' }, 100);
  store.transaction(db => db.prepare("INSERT INTO roles(id,project_id,name,charter,permission_profile,desired_state,binding_state) VALUES('r-manager','p1','manager','c','worker','enabled','unbound')").run());
  return { store, open };
}

test('raise合并语义：同指纹未决case合并追加证据，新指纹新建（A048准备）', t => {
  const { store, open } = fixture(t);
  const first = raiseIssue(store, { id: 'c1', projectId: 'p1', taskId: null, ownerRoleId: null, fingerprint: 'task-x:timeout', evidence: { detail: '第一次超时' } }, 110);
  assert.equal(first.merged, false);
  assert.equal(first.caseView.state, 'open');
  const second = raiseIssue(store, { id: 'c2', projectId: 'p1', fingerprint: 'task-x:timeout', evidence: { detail: '第二次超时' } }, 111);
  assert.equal(second.merged, true, '同指纹未决合并');
  assert.equal(second.caseView.id, 'c1', '合并到既有case');
  const read = readIssue(store, 'p1', 'c1');
  assert.equal(read.evidence.length, 2, '证据追加');
  assert.equal(listOpenIssues(store, 'p1').length, 1, '合并后不重复计数');
  resolveIssue(store, 'p1', 'c1', read.revision, { resolution: '已恢复' }, 112);
  const third = raiseIssue(store, { id: 'c3', projectId: 'p1', fingerprint: 'task-x:timeout', evidence: { detail: '解决后再现' } }, 113);
  assert.equal(third.merged, false, '已决case不参与合并，再现新建');
  store.close();
  const reopened = open();
  assert.equal(readIssue(reopened, 'p1', 'c1').evidence.length, 3, '重启后证据持久');
});

test('状态机与乐观并发：open→assigned→deciding→escalated；revision冲突拒绝', t => {
  const { store } = fixture(t);
  raiseIssue(store, { id: 'c10', projectId: 'p1', fingerprint: 'fp-10', evidence: {} }, 110);
  const assigned = assignIssue(store, 'p1', 'c10', 'r-manager', 1, 111);
  assert.equal(assigned.state, 'assigned');
  assert.equal(assigned.ownerRoleId, 'r-manager');
  assert.throws(() => assignIssue(store, 'p1', 'c10', 'r-other', 1, 112), /CASE_REVISION_CONFLICT|CASE_TRANSITION_REJECTED/, '陈旧revision或重复assign拒绝');
  const deciding = progressIssue(store, 'p1', 'c10', 'deciding', 2, { analysis: '已定位' }, 113);
  assert.equal(deciding.state, 'deciding');
  const escalated = escalateIssue(store, 'p1', 'c10', 3, { reason: '超出处理者权限' }, 114);
  assert.equal(escalated.state, 'escalated');
  assert.equal(listOpenIssues(store, 'p1').length, 0, 'escalated不占未决清单');
  assert.throws(() => resolveIssue(store, 'p1', 'c10', 4, { x: 1 }, 115), /CASE_TRANSITION_REJECTED/, 'escalated终态');
  assert.equal(readIssue(store, 'p1', 'c10').evidence.length, 3, '升级与过程证据持久');
});

test('解决路径与校验：monitoring→resolved；非法转移与缺失拒绝', t => {
  const { store } = fixture(t);
  raiseIssue(store, { id: 'c20', projectId: 'p1', fingerprint: 'fp-20', evidence: {} }, 110);
  assignIssue(store, 'p1', 'c20', 'r-manager', 1, 111);
  progressIssue(store, 'p1', 'c20', 'monitoring', 2, { fix: '已部署观察' }, 112);
  const resolved = resolveIssue(store, 'p1', 'c20', 3, { verified: true }, 113);
  assert.equal(resolved.state, 'resolved');
  assert.throws(() => progressIssue(store, 'p1', 'c20', 'applying', 4, {}, 114), /CASE_TRANSITION_REJECTED|REVISION/);
  assert.throws(() => resolveIssue(store, 'p1', 'c-missing', 1, {}, 115), /CASE_NOT_FOUND/);
  assert.throws(() => raiseIssue(store, { id: 'c21', projectId: 'p-other', fingerprint: 'f', evidence: {} }, 116), /CASE_PROJECT_NOT_FOUND/, '项目隔离');
  assert.equal(listOpenIssues(store, 'p1').length, 0);
});

test('A048：角色不可用时承办事项沿有限路径升级（不跳级）；合并成可追踪事项', t => {
  const { store, open } = fixture(t);
  // 多次报告：同指纹合并成可追踪事项
  const first = raiseIssue(store, { id: 'c-esc', projectId: 'p1', taskId: null, ownerRoleId: 'r-manager', fingerprint: 'fp-esc', evidence: { detail: '第一次' } }, 110);
  assert.equal(first.merged, false);
  const merged = raiseIssue(store, { id: 'c-esc2', projectId: 'p1', taskId: null, ownerRoleId: 'r-manager', fingerprint: 'fp-esc', evidence: { detail: '第二次' } }, 111);
  assert.equal(merged.merged, true);
  // 指定管理责任（revision以库中当前为准——合并追加证据会推进版本）
  const curRev = store.db.prepare("SELECT revision FROM cases WHERE id='c-esc'").get().revision;
  assignIssue(store, 'p1', 'c-esc', 'r-manager', curRev, 112);
  // 模拟角色不可用（desired_state→paused）后沿有限路径升级
  store.db.prepare("UPDATE roles SET desired_state='paused' WHERE id='r-manager'").run();
  const result = escalateUnavailableRoleCases(store, { projectId: 'p1', roleId: 'r-manager' }, 120);
  assert.deepEqual(result.escalated, ['c-esc'], 'open走assigned→deciding→escalated有限路径');
  const view = readIssue(store, 'p1', 'c-esc');
  assert.equal(view.state, 'escalated');
  const lastEvidence = view.evidence[view.evidence.length - 1];
  assert.equal(lastEvidence.evidence.reason, 'owner-role-unavailable', '升级证据记录不可用原因');
  // 证据保留（合并的两次报告仍在）
  assert.ok(view.evidence.length >= 3, '合并证据+升级证据保留');
  // 升级路径有限：escalated为终态，不可再转移
  assert.throws(() => progressIssue(store, 'p1', 'c-esc', 'applying', view.revision, {}, 130), /CASE_TRANSITION_REJECTED/);
  // 不可用后新报告仍聚合到升级后事项的指纹路径（新建走正常流转）
  const reopen = raiseIssue(store, { id: 'c-new', projectId: 'p1', taskId: null, ownerRoleId: 'r-manager', fingerprint: 'fp-esc', evidence: { detail: '升级后再报' } }, 140);
  assert.equal(reopen.merged, false, '已升级指纹不再合并，新建走正常流转');
  void open;
});

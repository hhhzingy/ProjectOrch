import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { createTask } from '../../../packages/domain/dist/tasks/index.js';
import { registerWorkspace } from '../../../packages/domain/dist/workspaces/index.js';
import { bootstrapRole, completeStartupAck } from '../../../packages/domain/dist/bootstrap/index.js';
import { evaluateDispatch, reserveDispatch, reconcileAttempt } from '../../../packages/domain/dist/dispatch-guard/index.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-claim-', () => { for (const s of stores.splice(0)) { try { s.close(); } catch { /* 已关闭 */ } } });
  fs.mkdirSync(path.join(dir,'ws1'));
  const filename = path.join(dir, 'state.sqlite');
  const store = openStore(filename);
  stores.push(store);
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: dir, objective: 'o' }, 100);
  bootstrapRole(store, { projectId: 'p1', localRef: 'r-w', name: 'worker', charter: 'c', permissionProfileId: 'worker', permissionProfileRevision: 1, expectedPolicyRevision: 0, principalId: 'user-1', requestId: 'boot-1' }, 110);
  store.transaction(db => db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s1','synthetic','host','profile','native-1')").run());
  store.transaction(db => db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b1','p1','r-w','s1',3,120)").run());
  completeStartupAck(store, { projectId: 'p1', roleId: 'r-w', bindingEpoch: 3, protocolVersion: 2, policyRevision: 0, planRevision: 0, roleRevision: store.db.prepare("SELECT revision FROM roles WHERE id='r-w'").get().revision, taskSpecRevisions: [] }, 130);
  createTask(store, { id: 't-1', projectId: 'p1', goal: 'g' }, 140);
  registerWorkspace(store, { id: 'ws-1', projectId: 'p1', canonicalPath: path.join(dir,'ws1'), enforcement: 'enforced' }, 150);
  return { store, base: { projectId: 'p1', roleId: 'r-w', bindingEpoch: 3, taskId: 't-1', taskRevision: 1 } };
}

test('A041：原子认领——并发认领只有一个当前尝试；重试不覆盖旧尝试；历史保留', t => {
  const { store, base } = fixture(t);
  const first = reserveDispatch(store, { ...base, attemptId: 'at-1', workspaceId: 'ws-1' }, 160);
  assert.equal(first.attemptId, 'at-1');
  // 并发认领（同一任务第二次准入）→拒绝：一个当前负责人/尝试
  const second = evaluateDispatch(store, base);
  assert.equal(second.allowed, false);
  assert.ok(second.denials.some(d => d.code === 'UNKNOWN_EXECUTION'));
  assert.throws(() => reserveDispatch(store, { ...base, attemptId: 'at-2', workspaceId: 'ws-1' }, 165), /DISPATCH_DENIED:UNKNOWN_EXECUTION/);
  // 归档完成后重试：新attempt新id，旧尝试历史保留
  store.db.prepare("UPDATE attempts SET state='succeeded' WHERE id='at-1'").run();
  store.db.prepare("UPDATE workspace_reservations SET state='released' WHERE id='res-at-1'").run();
  const retry = reserveDispatch(store, { ...base, attemptId: 'at-3', workspaceId: 'ws-1' }, 170);
  assert.equal(retry.attemptId, 'at-3');
  assert.equal(retry.reservationFence, 2, 'fence单调不覆盖');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id='t-1'").get().n, 2, '历史保留');
  assert.equal(store.db.prepare("SELECT state FROM attempts WHERE id='at-1'").get().state, 'succeeded', '旧尝试不被覆盖');
});

test('A041：unknown不自动释放也不视为空闲；核对后才接替（超时时间推进不改变unknown）', t => {
  const { store, base } = fixture(t);
  reserveDispatch(store, { ...base, attemptId: 'at-1', workspaceId: 'ws-1' }, 160);
  store.db.prepare("UPDATE attempts SET state='unknown' WHERE id='at-1'").run();
  // 大幅推进时间：unknown不被超时自动释放
  const blocked = evaluateDispatch(store, base);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.denials.some(d => d.code === 'UNKNOWN_EXECUTION'));
  // 泛对象不能证明终态，也不能被序列化写进原生executionId。
  assert.throws(() => reconcileAttempt(store, { projectId: 'p1', attemptId: 'at-1', outcome: 'failed', nativeReceipt: { probe: 'external-check', matched: true } }, 500), /TRUSTED_EXECUTION_RECONCILIATION_REQUIRED/);
  assert.equal(reconcileAttempt(store, { projectId: 'p1', attemptId: 'at-1', outcome: 'unknown', nativeReceipt: {} }, 501).state, 'unknown');
  assert.equal(evaluateDispatch(store, base).allowed, false);
  assert.equal(store.db.prepare("SELECT native_execution_id FROM attempts WHERE id='at-1'").get().native_execution_id, null);
  assert.equal(store.db.prepare("SELECT state FROM workspace_reservations WHERE id='res-at-1'").get().state, 'reserved');
  // 非unknown状态核对显式拒绝；缺失尝试拒绝
  store.db.prepare("UPDATE attempts SET state='failed' WHERE id='at-1'").run();
  assert.throws(() => reconcileAttempt(store, { projectId: 'p1', attemptId: 'at-1', outcome: 'succeeded', nativeReceipt: {} }, 510), /ATTEMPT_NOT_UNKNOWN/);
  assert.throws(() => reconcileAttempt(store, { projectId: 'p1', attemptId: 'missing', outcome: 'failed', nativeReceipt: {} }, 510), /ATTEMPT_NOT_FOUND/);
});

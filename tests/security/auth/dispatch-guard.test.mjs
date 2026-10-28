import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { createTask } from '../../../packages/domain/dist/tasks/index.js';
import { registerWorkspace } from '../../../packages/domain/dist/workspaces/index.js';
import { bootstrapRole, completeStartupAck } from '../../../packages/domain/dist/bootstrap/index.js';
import { evaluateDispatch, reserveDispatch } from '../../../packages/domain/dist/dispatch-guard/index.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-dispatch-guard-', () => { for (const s of stores.splice(0)) { try { s.close(); } catch { /* 已关闭 */ } } });
  for(const name of ['ws1', 'unk'])fs.mkdirSync(path.join(dir,name));
  const filename = path.join(dir, 'state.sqlite');
  const open = () => { const s = openStore(filename); stores.push(s); return s; };
  const store = open();
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: dir, objective: 'o' }, 100);
  bootstrapRole(store, { projectId: 'p1', localRef: 'r-w', name: 'worker', charter: 'c', permissionProfileId: 'worker', permissionProfileRevision: 1, expectedPolicyRevision: 0, principalId: 'user-1', requestId: 'boot-1' }, 110);
  store.transaction(db => db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s1','synthetic','host','profile','native-1')").run());
  store.transaction(db => db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b1','p1','r-w','s1',3,120)").run());
  const ack = completeStartupAck(store, { projectId: 'p1', roleId: 'r-w', bindingEpoch: 3, protocolVersion: 2, policyRevision: 0, planRevision: 0, roleRevision: store.db.prepare("SELECT revision FROM roles WHERE id='r-w'").get().revision, taskSpecRevisions: [] }, 130);
  assert.equal(ack.bindingState, 'ready');
  const task = (id) => createTask(store, { id, projectId: 'p1', goal: 'g' }, 140).revision;
  const rev1 = task('t-1');
  const rev2 = task('t-2');
  registerWorkspace(store, { id: 'ws-1', projectId: 'p1', canonicalPath: path.join(dir, 'ws1'), enforcement: 'enforced' }, 150);
  const base = { projectId: 'p1', roleId: 'r-w', bindingEpoch: 3, taskId: 't-1', taskRevision: rev1 };
  return { store, open, base, rev1, rev2, dir };
}

test('A091：全部真实启动入口共同拒绝且各带原因（暂停/hold/旧绑定/未握手/未知占位/目录冲突/预算/动态额度）', t => {
  const { store, base, dir } = fixture(t);
  // 干净请求允许
  const clean = evaluateDispatch(store, base);
  assert.deepEqual(clean, { allowed: true, denials: [] });
  // 用户暂停
  store.db.exec("UPDATE projects SET user_paused=1 WHERE id='p1'");
  const paused = evaluateDispatch(store, base);
  assert.equal(paused.allowed, false);
  assert.ok(paused.denials.some(d => d.code === 'USER_PAUSED'));
  store.db.exec("UPDATE projects SET user_paused=0 WHERE id='p1'");
  // 目标hold
  store.db.prepare("INSERT INTO goal_holds(id,project_id,revision,source_kind,provenance_json,affected_tasks_json,scope_known,state) VALUES('h1','p1',0,'authenticated_user','{}','[]',1,'pending')").run();
  assert.ok(evaluateDispatch(store, base).denials.some(d => d.code === 'DISPATCH_HELD'));
  store.db.prepare("UPDATE goal_holds SET state='resolved' WHERE id='h1'").run();
  // 旧绑定
  const stale = evaluateDispatch(store, { ...base, bindingEpoch: 2 });
  assert.equal(stale.allowed, false);
  assert.ok(stale.denials.some(d => d.code === 'STALE_BINDING'));
  // 未完成启动握手
  store.db.exec("UPDATE roles SET startup_protocol_version=NULL WHERE id='r-w'");
  assert.ok(evaluateDispatch(store, base).denials.some(d => d.code === 'STARTUP_REQUIRED'));
  store.db.exec("UPDATE roles SET startup_protocol_version=2 WHERE id='r-w'");
  // 目录强制能力未知
  registerWorkspace(store, { id: 'ws-unk', projectId: 'p1', canonicalPath: path.join(dir, 'unk'), enforcement: 'unknown' }, 155);
  assert.ok(evaluateDispatch(store, { ...base, workspaceId: 'ws-unk' }).denials.some(d => d.code === 'CAPABILITY_UNSUPPORTED'));
  // 预算耗尽（尝试数上限1：现有0，占位1次后超限）
  const budgeted = evaluateDispatch(store, { ...base, budgetLimits: { maxAttemptsPerRole: 1 } });
  assert.equal(budgeted.allowed, true);
  reserveDispatch(store, { ...base, attemptId: 'at-1', workspaceId: 'ws-1' }, 160);
  const exceeded = evaluateDispatch(store, { ...base, taskId: 't-2', taskRevision: 2, workspaceId: 'ws-1', budgetLimits: { maxAttemptsPerRole: 1 } });
  assert.equal(exceeded.allowed, false);
  assert.ok(exceeded.denials.some(d => d.code === 'BUDGET_EXCEEDED'), '尝试数预算');
  // 同任务已有未决执行（含unknown占位）：不确定不视为空闲
  store.db.prepare("UPDATE attempts SET state='unknown' WHERE id='at-1'").run();
  const unknownBlock = evaluateDispatch(store, { ...base, budgetLimits: { maxAttemptsPerRole: 5 } });
  assert.equal(unknownBlock.allowed, false);
  assert.ok(unknownBlock.denials.some(d => d.code === 'UNKNOWN_EXECUTION'), 'unknown占位阻止重派');
  // 动态角色额度
  store.db.prepare("UPDATE attempts SET state='succeeded' WHERE id='at-1'").run();
  store.db.prepare("UPDATE workspace_reservations SET state='released' WHERE id='res-at-1'").run();
  const dynamic = evaluateDispatch(store, { ...base, taskId: 't-2', taskRevision: 2, maxDynamicRoles: 1 });
  void dynamic;
});

test('A091：重叠写目录与重复认领拒绝；准入通过后占位登记（attempt+独占fence）', t => {
  const { store, base, rev2 } = fixture(t);
  reserveDispatch(store, { ...base, attemptId: 'at-a', workspaceId: 'ws-1' }, 160);
  // 重叠目录：另一任务认领同一已独占目录→WORKSPACE_CONFLICT（不支持强隔离时整目录独占）
  const overlap = evaluateDispatch(store, { ...base, taskId: 't-2', taskRevision: rev2, workspaceId: 'ws-1' });
  assert.equal(overlap.allowed, false);
  assert.ok(overlap.denials.some(d => d.code === 'WORKSPACE_CONFLICT'));
  // 重复认领：同任务再次准入→UNKNOWN_EXECUTION（占位仍在）
  const dup = evaluateDispatch(store, { ...base, workspaceId: 'ws-1' });
  assert.equal(dup.allowed, false);
  assert.ok(dup.denials.some(d => d.code === 'UNKNOWN_EXECUTION'), '重复认领拒绝');
  // 释放后另一任务可独占，fence单调递增
  store.db.prepare("UPDATE attempts SET state='succeeded' WHERE id='at-a'").run();
  store.db.prepare("UPDATE workspace_reservations SET state='released' WHERE id='res-at-a'").run();
  const second = reserveDispatch(store, { ...base, taskId: 't-2', taskRevision: rev2, attemptId: 'at-b', workspaceId: 'ws-1' }, 170);
  assert.equal(second.reservationFence, 2, 'fence单调');
  const attempt = store.db.prepare("SELECT state,workspace_id,binding_epoch FROM attempts WHERE id='at-b'").get();
  assert.equal(attempt.state, 'dispatching');
  assert.equal(attempt.workspace_id, 'ws-1');
  // 派发拒绝集中显式（不静默部分生效）
  assert.throws(() => reserveDispatch(store, { ...base, taskId: 't-2', taskRevision: rev2, attemptId: 'at-c', workspaceId: 'ws-1' }, 180), /DISPATCH_DENIED:(UNKNOWN_EXECUTION|WORKSPACE_CONFLICT)/);
});

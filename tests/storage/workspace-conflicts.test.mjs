import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import { openStore } from '../../packages/persistence/dist/index.js';
import { createProject } from '../../packages/domain/dist/projects/index.js';
import { createRole } from '../../packages/domain/dist/roles/index.js';
import { createTask } from '../../packages/domain/dist/tasks/index.js';
import { registerWorkspace, markExternalModification, acknowledgeBaseline, readWorkspace } from '../../packages/domain/dist/workspaces/index.js';
import { evaluateDispatch, reserveDispatch } from '../../packages/domain/dist/dispatch-guard/index.js';
import { bootstrapRole, completeStartupAck } from '../../packages/domain/dist/bootstrap/index.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-a057-', () => { for (const s of stores.splice(0)) { try { s.close(); } catch { /* 已关闭 */ } } });
  for(const name of ['e', 'a', 'u', 'x'])fs.mkdirSync(path.join(dir,name));
  const filename = path.join(dir, 'state.sqlite');
  const store = openStore(filename);
  stores.push(store);
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: dir, objective: 'o' }, 100);
  bootstrapRole(store, { projectId: 'p1', localRef: 'r-w', name: 'worker', charter: 'c', permissionProfileId: 'worker', permissionProfileRevision: 1, expectedPolicyRevision: 0, principalId: 'user-1', requestId: 'boot-1' }, 110);
  store.transaction(db => db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s1','synthetic','host','profile','native-1')").run());
  store.transaction(db => db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b1','p1','r-w','s1',1,120)").run());
  completeStartupAck(store, { projectId: 'p1', roleId: 'r-w', bindingEpoch: 1, protocolVersion: 2, policyRevision: 0, planRevision: 0, roleRevision: store.db.prepare("SELECT revision FROM roles WHERE id='r-w'").get().revision, taskSpecRevisions: [] }, 130);
  const rev = id => createTask(store, { id, projectId: 'p1', goal: 'g' }, 140).revision;
  const rev1 = rev('t-1');
  const rev2 = rev('t-2');
  return { store, rev1, rev2, dir };
}

test('A057：并发派发冲突按策略排队（不破坏、释放后可重试）；不可强制限制时如实声明', t => {
  const { store, rev1, rev2, dir } = fixture(t);
  registerWorkspace(store, { id: 'ws-e', projectId: 'p1', canonicalPath: path.join(dir, 'e'), enforcement: 'enforced' }, 150);
  registerWorkspace(store, { id: 'ws-a', projectId: 'p1', canonicalPath: path.join(dir, 'a'), enforcement: 'advisory' }, 151);
  registerWorkspace(store, { id: 'ws-u', projectId: 'p1', canonicalPath: path.join(dir, 'u'), enforcement: 'unknown' }, 152);
  // 并发派发：t-1独占后t-2同目录→WORKSPACE_CONFLICT排队（不破坏占位）；释放后可重试
  reserveDispatch(store, { projectId: 'p1', roleId: 'r-w', bindingEpoch: 1, taskId: 't-1', taskRevision: rev1, workspaceId: 'ws-e', attemptId: 'at-1' }, 160);
  const conflict = evaluateDispatch(store, { projectId: 'p1', roleId: 'r-w', bindingEpoch: 1, taskId: 't-2', taskRevision: rev2, workspaceId: 'ws-e' });
  assert.ok(conflict.denials.some(d => d.code === 'WORKSPACE_CONFLICT'), '冲突按策略排队');
  assert.ok(store.db.prepare("SELECT 1 FROM workspace_reservations WHERE workspace_id='ws-e' AND state='reserved' AND task_id='t-1'").get(), '占位不被破坏（独占登记保留）');
  // 隔离能力如实声明：advisory≠隔离（视图暴露enforcement）；unknown强制能力不派发
  assert.equal(readWorkspace(store, 'p1', 'ws-a').enforcement, 'advisory', 'advisory=明确约定而非隔离');
  const unknownCap = evaluateDispatch(store, { projectId: 'p1', roleId: 'r-w', bindingEpoch: 1, taskId: 't-2', taskRevision: rev2, workspaceId: 'ws-u' });
  assert.ok(unknownCap.denials.some(d => d.code === 'CAPABILITY_UNSUPPORTED'));
});

test('A057：手动外部修改→派发排队待基线核对；重新核对后恢复可用', t => {
  const { store, rev1, rev2, dir } = fixture(t);
  registerWorkspace(store, { id: 'ws-x', projectId: 'p1', canonicalPath: path.join(dir, 'x'), enforcement: 'enforced' }, 150);
  reserveDispatch(store, { projectId: 'p1', roleId: 'r-w', bindingEpoch: 1, taskId: 't-1', taskRevision: rev1, workspaceId: 'ws-x', attemptId: 'at-1' }, 160);
  store.db.prepare("UPDATE attempts SET state='succeeded' WHERE id='at-1'").run();
  store.db.prepare("UPDATE workspace_reservations SET state='released' WHERE id='res-at-1'").run();
  // 手动外部修改：观察记录（不可变）+空间置unknown→后续派发排队
  const marked = markExternalModification(store, { projectId: 'p1', workspaceId: 'ws-x', observation: { reason: 'manual edit', detectedBy: 'baseline-diff' } }, 170);
  assert.equal(marked.state, 'unknown');
  const queued = evaluateDispatch(store, { projectId: 'p1', roleId: 'r-w', bindingEpoch: 1, taskId: 't-2', taskRevision: rev2, workspaceId: 'ws-x' });
  assert.equal(queued.allowed, false);
  assert.ok(queued.denials.some(d => d.code === 'WORKSPACE_CONFLICT' && d.detail.includes('基线')), '外部修改后按策略排队');
  assert.ok(store.db.prepare("SELECT 1 FROM source_observations WHERE payload_json LIKE '%external_modification%'").get(), '不可变观察已记录');
  // 重新核对基线→available→派发恢复
  const ack = acknowledgeBaseline(store, { projectId: 'p1', workspaceId: 'ws-x', baselineSha256: 'b'.repeat(64) }, 180);
  assert.equal(ack.state, 'available');
  const resumed = evaluateDispatch(store, { projectId: 'p1', roleId: 'r-w', bindingEpoch: 1, taskId: 't-2', taskRevision: rev2, workspaceId: 'ws-x' });
  assert.equal(resumed.allowed, true, '基线核对后恢复');
  assert.throws(() => acknowledgeBaseline(store, { projectId: 'p1', workspaceId: 'ws-x', baselineSha256: 'c'.repeat(64) }, 190), /WORKSPACE_NOT_UNCERTAIN/, '非unknown态不可重复核对');
});

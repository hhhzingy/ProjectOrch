import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { createRole } from '../../../packages/domain/dist/roles/index.js';
import { reconcileDelivery } from '../../../apps/kernel/dist/commands/delivery-reconcile.js';
import { listUncertainOutbox } from '../../../packages/persistence/dist/outbox/index.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-reconcile-', () => { for (const s of stores.splice(0)) { try { s.close(); } catch { /* 已关闭 */ } } });
  const filename = path.join(dir, 'state.sqlite');
  const store = openStore(filename);
  stores.push(store);
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: 'E:/synthetic/reconcile', objective: 'o' }, 100);
  createRole(store, { id: 'r-w', projectId: 'p1', name: 'worker', charter: 'c', permissionProfileId: 'worker' }, 101);
  const seedUncertain = (id, operationKey, payloadText) => store.transaction(db => {
    db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES(?,?,?,?,?,'project.pause','{}','completed',100)").run(`cmd-${id}`, 'p1', 'u', `rq-${id}`, '0'.repeat(64));
    db.prepare("INSERT INTO outbox(id,command_id,operation_key,payload_json,state,next_attempt_at,lease_epoch,lease_until,attempts) VALUES(?,?,?,?,'uncertain',100,7,NULL,1)").run(id, `cmd-${id}`, operationKey, JSON.stringify({ text: payloadText }));
  });
  return { store, seedUncertain };
}

test('A038：断连后恢复——可核实时收敛（applied→delivered；not_applied→重排可再派发）', t => {
  const { store, seedUncertain } = fixture(t);
  seedUncertain('op1', 'k-applied', '相同文本');
  seedUncertain('op2', 'k-notapplied', '相同文本');
  const probes = { 'k-applied': 'applied', 'k-notapplied': 'not_applied' };
  const result = reconcileDelivery(store, { probe: op => probes[op.operationKey] ?? 'unknown', issueProjectId: 'p1', issueOwnerRoleId: 'r-w' }, { now: 300, retryDelayMs: 0 });
  assert.equal(result.delivered, 1);
  assert.equal(result.requeued, 1);
  assert.equal(store.db.prepare("SELECT state FROM outbox WHERE id='op1'").get().state, 'delivered');
  assert.equal(store.db.prepare("SELECT state FROM outbox WHERE id='op2'").get().state, 'pending', '未应用重排后可再派发（重发决策由上层）');
});

test('A038：不可核实时保持uncertain不盲重发，并按指纹建立/合并事项；仅文本相同不构成同次消息', t => {
  const { store, seedUncertain } = fixture(t);
  // 两条不同操作（不同operationKey）携带相同文本：身份以operationKey为准
  seedUncertain('op3', 'k-x1', '相同文本');
  seedUncertain('op4', 'k-x2', '相同文本');
  const round1 = reconcileDelivery(store, { probe: () => 'unknown', issueProjectId: 'p1', issueOwnerRoleId: 'r-w' }, { now: 300, retryDelayMs: 0 });
  assert.equal(round1.stayedUncertain, 2, '不可核实保持uncertain');
  assert.equal(round1.issuesRaised, 2, '按操作身份分别建案');
  assert.equal(listUncertainOutbox(store, 10).length, 2, '不盲重发（仍uncertain，不回pending）');
  // 再轮询：同指纹合并（不重复建新案）
  const round2 = reconcileDelivery(store, { probe: () => 'unknown', issueProjectId: 'p1', issueOwnerRoleId: 'r-w' }, { now: 320, retryDelayMs: 0 });
  assert.equal(round2.stayedUncertain, 2);
  assert.equal(round2.issuesRaised, 0, '同指纹合并不重复建案');
  const cases = store.db.prepare("SELECT id,fingerprint,evidence_json FROM cases WHERE project_id='p1' ORDER BY id").all();
  assert.equal(cases.length, 2);
  const byX1 = store.db.prepare("SELECT fingerprint,evidence_json FROM cases WHERE fingerprint='delivery-unverifiable:k-x1'").get();
  const byX2 = store.db.prepare("SELECT fingerprint,evidence_json FROM cases WHERE fingerprint='delivery-unverifiable:k-x2'").get();
  assert.ok(byX1 && byX2, '指纹绑定操作身份而非文本');
  const evidence = JSON.parse(byX1.evidence_json);
  assert.ok(evidence.length >= 2, '合并证据保留各轮探测记录');
});

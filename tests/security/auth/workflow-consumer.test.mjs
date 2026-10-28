import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openStore, defaultMigrations } from '../../../packages/persistence/dist/index.js';
import { enqueueOutbox } from '../../../packages/persistence/dist/outbox/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { ExecutionCoordinator } from '../../../apps/kernel/dist/execution/coordinator.js';
import { WorkflowConsumer } from '../../../apps/kernel/dist/execution/workflow-consumer.js';
import { enqueueWorkflowCandidatesWithin } from '../../../apps/kernel/dist/execution/workflow-intents.js';
import { pumpOutbox } from '../../../apps/kernel/dist/commands/outbox-worker.js';
import { startKernel } from '../../../apps/kernel/dist/lifecycle/kernel-runtime.js';
import { applyChangesetForUser } from '../../../apps/kernel/dist/commands/user-changesets.js';
import { executionFixture } from './execution-fixture.mjs';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, options = {}) {
  const f = executionFixture(t); let clock = 300; f.services.now = () => clock;
  const consumer = new WorkflowConsumer(f.store, f.coordinator, { workspaceForTask: () => 'workspace', retryDelayMs: 1, ...options });
  const seed = (commandId = 'command') => f.store.db.prepare("INSERT OR IGNORE INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES(?,'p','synthetic-user',?,?,'test','{}','completed',200)").run(commandId, commandId, 'a'.repeat(64));
  const queue = (taskIds = ['task'], commandId = 'command') => f.store.transaction(db => { seed(commandId); return enqueueWorkflowCandidatesWithin(db, 'p', commandId, clock, taskIds); });
  const raw = payload => f.store.transaction(db => { seed(); enqueueOutbox(db, { id: 'raw', commandId: 'command', operationKey: 'raw', payload, nextAttemptAt: clock }); });
  const evaluation = () => f.store.db.prepare('SELECT * FROM workflow_evaluations ORDER BY outbox_id').get();
  const outbox = () => f.store.db.prepare("SELECT * FROM outbox WHERE json_extract(payload_json,'$.event')='workflow.evaluate'").get();
  return Object.assign(f, { consumer, queue, raw, evaluation, outbox, advance: () => { clock++; }, setClock: v => { clock = v; } });
}

test('版本候选→事务准备回执→提交后原生调用；幂等来源保留，内部回执不声称已经执行', async t => {
  const f = fixture(t); assert.equal(f.queue(), 1); assert.equal(f.queue(['task'], 'second-command'), 0);
  const out = f.outbox(); assert.equal(out.command_id, 'command');
  assert.deepEqual(JSON.parse(out.payload_json), { schemaVersion: 2, event: 'workflow.evaluate', projectId: 'p', taskId: 'task', taskRevision: 1, specRevision: 1 });
  assert.deepEqual(f.consumer.pump(), { prepared: 1, blocked: 0, discarded: 0, exhausted: 0 });
  assert.equal(f.calls, 0, '尚未进入原生run微任务');
  const receipt = JSON.parse(f.outbox().native_receipt_json);
  assert.equal(receipt.scope, 'workflow_preparation'); assert.equal(receipt.nativeExecution, 'not_asserted'); assert.equal(receipt.dispatchId, f.evaluation().dispatch_id);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, 1);
  await tick(); assert.equal(f.calls, 1);
  f.finish(); await tick(); assert.equal(f.row(receipt.dispatchId).phase, 'succeeded');
  assert.equal(f.consumer.pump().prepared, 0); assert.equal(f.calls, 1); await f.consumer.stop();
});

test('外部Outbox投递器不领取内部workflow候选，其他消息照常投递', t => {
  const f = fixture(t); f.queue();
  f.store.transaction(db => enqueueOutbox(db, { id: 'external', commandId: 'command', operationKey: 'external', payload: { event: 'message.deliver' }, nextAttemptAt: 300 }));
  const delivered = [];
  const result = pumpOutbox(f.store, { deliver: lease => { delivered.push(lease.id); return 'delivered'; } }, { now: () => 300 });
  assert.deepEqual(delivered, ['external']); assert.equal(result.delivered, 1); assert.equal(f.outbox().state, 'pending'); assert.equal(f.calls, 0);
});

test('用户真实变更管线同事务产生当前版本候选，重放不重复，失败变更不产生意图', t => {
  const f = fixture(t);
  const input = { schemaVersion: 2, requestId: 'new-task', projectId: 'p', expectedPlanRevision: 0, reason: '明确安排任务', operations: [{ type: 'task.create', localRef: 'created', assigneeRoleId: 'worker', spec: { goal: '新增任务', inputArtifacts: [], outputRequirements: [{ name: 'report', kind: 'report', description: '报告' }], acceptance: [{ ruleId: 'user-review', mode: 'user', description: '用户验收' }], dependencies: [] } }] };
  const receipt = applyChangesetForUser(f.store, 'synthetic-user', input, 300); assert.equal(receipt.status, 'completed');
  const row = f.store.db.prepare("SELECT command_id,payload_json FROM outbox WHERE json_extract(payload_json,'$.taskId')='created'").get();
  assert.equal(row.command_id, receipt.commandId); assert.equal(JSON.parse(row.payload_json).taskRevision, 1); assert.equal(JSON.parse(row.payload_json).specRevision, 1);
  assert.equal(applyChangesetForUser(f.store, 'synthetic-user', input, 301).commandId, receipt.commandId);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE json_extract(payload_json,'$.taskId')='created'").get().n, 1);
  const failed = applyChangesetForUser(f.store, 'synthetic-user', { ...input, requestId: 'bad', expectedPlanRevision: 0 }, 302); assert.equal(failed.status, 'failed');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE command_id=?').get(failed.commandId).n, 0); assert.equal(f.calls, 0);
});

test('旧的uncertain候选阻塞新候选，不能借新操作键绕过原生不确定边界', t => {
  const f = fixture(t); f.queue();
  f.store.transaction(db => { enqueueOutbox(db, { id: 'legacy', commandId: 'command', operationKey: 'legacy', payload: { event: 'workflow.evaluate', projectId: 'p', taskId: 'task' }, nextAttemptAt: 300 }); db.prepare("UPDATE outbox SET state='uncertain' WHERE id='legacy'").run(); });
  assert.equal(f.consumer.pump().blocked, 1); assert.equal(f.evaluation().code, 'WORKFLOW_UNCERTAIN_CANDIDATE');
  assert.equal(f.calls, 0); assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, 0);
});

test('暂停为持久阻塞、无模型尝试/外部重试消耗；重复检查不刷屏，解除后正常准备', async t => {
  const f = fixture(t); f.queue(); f.store.db.exec("UPDATE projects SET user_paused=1 WHERE id='p'");
  assert.equal(f.consumer.pump().blocked, 1); assert.equal(f.evaluation().code, 'DISPATCH_FORBIDDEN');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, 0); assert.equal(f.outbox().attempts, 0);
  f.advance(); assert.equal(f.consumer.pump().blocked, 1); assert.equal(f.evaluation().check_count, 2);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='workflow.blocked'").get().n, 1);
  f.store.db.exec("UPDATE projects SET user_paused=0 WHERE id='p'"); f.advance(); assert.equal(f.consumer.pump().prepared, 1);
  await tick(); f.finish(); await tick(); assert.equal(f.calls, 1); await f.consumer.stop();
});

test('缺版本、跨项目、错误规格/实体版本、已取消和来源命令失败均丢弃且零外发', t => {
  for (const scenario of ['old', 'project', 'spec', 'revision', 'cancelled', 'command']) {
    const f = fixture(t); const payload = { schemaVersion: 2, event: 'workflow.evaluate', projectId: 'p', taskId: 'task', taskRevision: 1, specRevision: 1 };
    if (scenario === 'old') { delete payload.schemaVersion; delete payload.taskRevision; }
    if (scenario === 'project') payload.projectId = 'other-project';
    if (scenario === 'spec') payload.specRevision = 2;
    if (scenario === 'revision') payload.taskRevision = 2;
    if (scenario === 'cancelled') f.store.db.exec("UPDATE tasks SET state='cancelled' WHERE id='task'");
    f.raw(payload); if (scenario === 'command') f.store.db.exec("UPDATE commands SET state='failed'");
    assert.equal(f.consumer.pump().discarded, 1, scenario); assert.equal(f.evaluation().decision, 'discarded');
    assert.equal(f.calls, 0); assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, 0);
    assert.equal(JSON.parse(f.outbox().native_receipt_json).nativeExecution, 'not_asserted');
  }
});

test('准备后候选结算写失败整册回滚，不留下预约、尝试或部分评估', async t => {
  const f = fixture(t); f.queue();
  f.store.db.exec("CREATE TRIGGER synthetic_candidate_settle_failure BEFORE UPDATE OF state ON outbox WHEN NEW.state='delivered' BEGIN SELECT RAISE(ABORT,'synthetic_settle_failure'); END");
  assert.throws(() => f.consumer.pump(), /synthetic_settle_failure/);
  assert.equal(f.outbox().state, 'pending'); assert.equal(f.evaluation(), undefined);
  for (const table of ['attempts', 'workspace_reservations', 'execution_dispatches']) assert.equal(f.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  assert.equal(f.calls, 0); f.store.db.exec('DROP TRIGGER synthetic_candidate_settle_failure');
  assert.equal(f.consumer.pump().prepared, 1); await tick(); f.finish(); await tick(); await f.consumer.stop();
});

test('双连接竞争写锁时不产生副作用，锁释放后只有一个消费者准备并发送', async t => {
  const f = fixture(t); f.queue(); const secondStore = openStore(f.filename, { busyTimeoutMs: 25 }); f.stores.push(secondStore);
  const second = new WorkflowConsumer(secondStore, new ExecutionCoordinator(secondStore, f.services), { workspaceForTask: () => 'workspace' });
  f.store.db.exec('BEGIN IMMEDIATE');
  try { assert.throws(() => second.pump(), /locked/); assert.equal(f.calls, 0); } finally { f.store.db.exec('ROLLBACK'); }
  assert.equal(second.pump().prepared, 1); assert.equal(f.consumer.pump().prepared, 0);
  await tick(); assert.equal(f.calls, 1); f.finish(); await tick();
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM execution_dispatches').get().n, 1);
  await second.stop(); await f.consumer.stop();
});

test('不支持的能力持续保留阻塞；未预期错误有界耗尽，错误正文不进入持久记录', async t => {
  const blocked = fixture(t); blocked.queue(); blocked.prove({ textInput: 'verified' });
  assert.equal(blocked.consumer.pump().blocked, 1); assert.equal(blocked.evaluation().code, 'NATIVE_CAPABILITY_UNVERIFIED'); assert.equal(blocked.calls, 0);
  await blocked.consumer.stop();
  const f = fixture(t, { maxUnexpectedFailures: 2, workspaceForTask: () => { throw new Error('PRIVATE_TOKEN_MUST_NOT_PERSIST'); } }); f.queue();
  assert.equal(f.consumer.pump().blocked, 1); f.advance(); assert.equal(f.consumer.pump().exhausted, 1);
  assert.equal(f.evaluation().failure_count, 2); assert.equal(f.outbox().state, 'exhausted'); assert.equal(f.calls, 0);
  assert.doesNotMatch(JSON.stringify(f.store.db.prepare('SELECT * FROM workflow_evaluations').all()) + JSON.stringify(f.store.db.prepare('SELECT body_json FROM events').all()) + String(f.outbox().native_receipt_json), /PRIVATE_TOKEN/);
});

test('准备已提交但尚未开始时换协调器，保守恢复unknown且不重发', async t => {
  const f = fixture(t); f.queue(); f.consumer.pump();
  const nextCoordinator = new ExecutionCoordinator(f.store, f.services); const next = new WorkflowConsumer(f.store, nextCoordinator, { workspaceForTask: () => 'workspace' });
  assert.equal(next.recover(), 1); await tick(); assert.equal(f.calls, 0);
  const id = f.evaluation().dispatch_id; assert.equal(f.row(id).phase, 'unknown'); assert.equal(next.pump().prepared, 0);
  await f.consumer.stop(); await next.stop();
});

test('停止在途消费者保存unknown且及时完成，不等待模型也不取消/释放原生工作', async t => {
  const f = fixture(t); f.queue(); f.consumer.pump(); await tick();
  const id = f.evaluation().dispatch_id; assert.equal(f.row(id).phase, 'running');
  await f.consumer.stop(); assert.equal(f.row(id).phase, 'unknown'); assert.equal(f.reservation().state, 'unknown'); assert.equal(f.consumer.snapshot().inFlight, 0);
  f.store.close(); f.finish(); await tick(); // 迟到原生结果在关闭后不能访问数据库。
  assert.throws(() => f.consumer.pump(), /WORKFLOW_OWNER_LOST/);
});

test('内核装配消费者后实际轮询准备/调用，停止不挂起，默认启动不消费模型意图', async t => {
  let runtime; t.after(async () => { await runtime?.stop(); });
  const f = fixture(t); f.queue();
  runtime = await startKernel({ filename: f.filename, principalId: 'synthetic-user', now: () => 300, workflowPollMs: 10,
    workflowFactory: (store, context) => new WorkflowConsumer(store, new ExecutionCoordinator(store, { ...f.services, ...context }), { workspaceForTask: () => 'workspace' }) });
  for (let i = 0; i < 30 && f.calls === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.calls, 1); assert.equal(runtime.workflowStatus().enabled, true); assert.equal(runtime.workflowStatus().healthy, true);
  await runtime.stop(); const store = openStore(f.filename); f.stores.push(store);
  assert.equal(store.db.prepare('SELECT phase FROM execution_dispatches').get().phase, 'unknown'); f.finish(); await tick();
  runtime = await startKernel({ filename: f.filename, principalId: 'synthetic-user', now: () => 300, outboxPollMs: 10, outbox: { deliver: () => { throw new Error('must not receive internal intent'); } } });
  assert.equal(runtime.workflowStatus().enabled, false); await runtime.stop();
});

test('非法工厂、异步工厂/恢复拒绝且释放启动锁，错误pump只记录固定健康错误不重跑', async t => {
  let runtime; t.after(async () => { await runtime?.stop(); }); const f = fixture(t); let calls = 0;
  await assert.rejects(() => startKernel({ filename: f.filename, principalId: 'u', workflowFactory: async () => ({}) }), /SYNC_WORKFLOW_FACTORY_REQUIRED/);
  await assert.rejects(() => startKernel({ filename: f.filename, principalId: 'u', workflowFactory: () => Promise.reject(new Error('factory rejected')) }), /INVALID_WORKFLOW_RUNTIME/);
  await assert.rejects(() => startKernel({ filename: f.filename, principalId: 'u', workflowFactory: () => ({ recover: () => Promise.reject(new Error('recover rejected')), pump() {}, stop: async () => {} }) }), /INVALID_WORKFLOW_RECOVERY/);
  runtime = await startKernel({ filename: f.filename, principalId: 'u', workflowPollMs: 10, workflowFactory: () => ({ recover: () => 0, pump: () => { calls++; throw new Error('private error'); }, stop: async () => {} }) });
  for (let i = 0; i < 30 && calls === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls, 1);
  assert.equal(runtime.workflowStatus().lastError, 'WORKFLOW_PUMP_FAILED'); assert.equal(runtime.workflowStatus().healthy, false);
});

test('迁移011→012保留项目并建立评估表，旧无版本候选不猜填升级', t => {
  const stores = []; const dir = temporaryDirectory(t, 'projectorch-workflow-migrate-', () => { for (const s of stores) s.close(); }); const filename = path.join(dir, 'state.sqlite');
  const old = openStore(filename, { migrations: defaultMigrations().slice(0, 11) }); stores.push(old);
  createProject(old, { id: 'p', name: 'p', hostId: 'h', canonicalRoot: dir, objective: '保留' }, 100); old.close();
  const current = openStore(filename, { migrations: defaultMigrations().slice(0, 12) }); stores.push(current);
  assert.equal(current.db.prepare("SELECT objective FROM projects WHERE id='p'").get().objective, '保留');
  assert.equal(current.db.prepare('SELECT COUNT(*) AS n FROM workflow_evaluations').get().n, 0);
  assert.equal(current.db.prepare('PRAGMA user_version').get().user_version, 12);
});

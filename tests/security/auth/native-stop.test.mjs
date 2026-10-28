import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { executionFixture } from './execution-fixture.mjs';
import { ExecutionCoordinator } from '../../../apps/kernel/dist/execution/coordinator.js';
import { WorkflowConsumer } from '../../../apps/kernel/dist/execution/workflow-consumer.js';
import { reviseTaskSpec } from '../../../packages/domain/dist/plan-revisions/index.js';

// 组件测试；会话、能力和停止适配器全部合成，不调用官方软件或模型。
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  const f = executionFixture(t); let calls = 0; let action;
  f.prove({ textInput: 'verified', resume: 'verified', historyRead: 'verified', roleTools: 'verified', nativeCancel: 'verified' });
  f.driver.requestStop = input => { calls++; return action ? action(input) : { result: Promise.resolve({ ...input, accepted: true }) }; };
  const request = (attemptId, expected = 'native-turn', id = 'stop') => {
    f.store.db.prepare("INSERT INTO native_control_requests(id,project_id,attempt_id,binding_id,binding_epoch,expected_native_execution_id,task_spec_revision,kind,state,created_at) VALUES(?,'p',?,'binding',1,?,2,'stop','pending',300)").run(id, attemptId, expected); return id;
  };
  return Object.assign(f, { request, state: (id = 'stop') => f.store.db.prepare('SELECT state FROM native_control_requests WHERE id=?').get(id)?.state,
    stopCalls: () => calls, onStop: fn => { action = fn; } });
}

test('停止投递边界先提交，同请求并发只发一次，接受回执不冒充终态', async t => {
  const f = fixture(t), id = f.prepare(), run = f.coordinator.run(id); await tick(); f.request(id);
  f.onStop(input => {
    assert.deepEqual(input, { session: f.session, executionId: 'native-turn' });
    assert.equal(f.state(), 'requested');
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='native.stop.prepared'").get().n, 1);
    return { result: Promise.resolve({ ...input, accepted: true }) };
  });
  assert.deepEqual(await Promise.all([f.coordinator.requestStop('stop'), f.coordinator.requestStop('stop')]), ['requested', 'requested']);
  assert.equal(f.stopCalls(), 1); assert.equal(f.row(id).phase, 'running'); assert.equal(f.reservation().state, 'reserved');
  assert.equal(await f.coordinator.requestStop('stop'), 'requested'); assert.equal(f.stopCalls(), 1);
  f.finish({ status: 'interrupted' }); assert.equal(await run, 'interrupted');
  assert.equal(f.state(), 'confirmed'); assert.equal(f.reservation().state, 'released');
});

test('未启动预约可安全取消且不外发；自然完成也记录精确终态而非伪报interrupted', async t => {
  for (const running of [false, true]) {
    const f = fixture(t), id = f.prepare();
    if (!running) {
      f.request(id, null); assert.equal(await f.coordinator.requestStop('stop'), 'confirmed');
      assert.equal(await f.coordinator.run(id), 'cancelled'); assert.equal(f.calls, 0); assert.equal(f.stopCalls(), 0);
    } else {
      const run = f.coordinator.run(id); await tick(); f.request(id); f.finish(); assert.equal(await run, 'succeeded');
      assert.equal(f.state(), 'confirmed'); assert.equal(await f.coordinator.requestStop('stop'), 'confirmed'); assert.equal(f.stopCalls(), 0);
    }
    assert.equal(f.reservation().state, 'released');
  }
});

test('错执行ID、会话、driver owner、版本、绑定或未验证能力拒绝，不停止当前其他轮', async t => {
  for (const scenario of ['id', 'session', 'driver', 'identity', 'binding', 'unsupported', 'method', 'async']) {
    const f = fixture(t), id = f.prepare(), run = f.coordinator.run(id); await tick(); f.request(id, scenario === 'id' ? 'other' : 'native-turn');
    if (scenario === 'session') f.driver.session = { ...f.session, nativeConversationId: 'other' };
    if (scenario === 'driver') f.driver.ownerKey = 'other';
    if (scenario === 'identity') f.changeIdentity();
    if (scenario === 'binding') f.store.db.exec('UPDATE role_bindings SET ended_at=300');
    if (scenario === 'unsupported') f.prove({ nativeCancel: 'unsupported' });
    if (scenario === 'method') delete f.driver.requestStop;
    if (scenario === 'async') f.driver.requestStop = async () => { throw new Error('must not invoke'); };
    assert.equal(await f.coordinator.requestStop('stop'), 'rejected', scenario); assert.equal(f.stopCalls(), 0, scenario);
    assert.equal(f.row(id).phase, 'running'); assert.equal(f.reservation().state, 'reserved');
    f.finish(); await run;
  }
});

test('停止回执错误、拒绝、异常或畸形均uncertain且不重投，后续可信终态仍可确认', async t => {
  for (const scenario of ['session', 'id', 'refused', 'reject', 'throw', 'invalid']) {
    const f = fixture(t), id = f.prepare(), run = f.coordinator.run(id); await tick(); f.request(id);
    f.onStop(input => {
      if (scenario === 'throw') throw new Error('after send');
      if (scenario === 'invalid') return {};
      if (scenario === 'reject') return { result: Promise.reject(new Error('disconnected')) };
      return { result: Promise.resolve({ ...input, ...(scenario === 'session' ? { session: { ...f.session, nativeConversationId: 'other' } } : scenario === 'id' ? { executionId: 'other' } : {}), accepted: scenario !== 'refused' }) };
    });
    assert.equal(await f.coordinator.requestStop('stop'), 'uncertain', scenario);
    assert.equal(await f.coordinator.requestStop('stop'), 'uncertain'); assert.equal(f.stopCalls(), 1);
    assert.equal(f.reservation().state, 'reserved'); f.finish({ status: 'interrupted' }); await run;
    assert.equal(f.state(), 'confirmed');
  }
});

test('内核关闭不等待悬挂停止回执，不取消原生任务；重启保留uncertain不重发', async t => {
  const f = fixture(t), id = f.prepare(), run = f.coordinator.run(id); await tick(); f.request(id);
  f.onStop(() => ({ result: new Promise(() => {}) }));
  const stop = f.coordinator.requestStop('stop'); await tick();
  await f.coordinator.detach(); assert.equal(await stop, 'owner_lost'); assert.equal(await run, 'owner_lost');
  assert.equal(f.row(id).phase, 'unknown');
  assert.equal(f.state(), 'uncertain'); assert.equal(f.reservation().state, 'unknown');
  const next = new ExecutionCoordinator(f.store, f.services); next.recover(); assert.equal(next.consumeStopRequests(), 0); assert.equal(f.stopCalls(), 1);
});

test('所有权丢失和恢复后旧回执不得改变新owner记录，requested恢复为uncertain', async t => {
  const f = fixture(t), id = f.prepare(), run = f.coordinator.run(id); await tick(); f.request(id); let receipt;
  f.onStop(() => ({ result: new Promise(resolve => { receipt = resolve; }) }));
  const stop = f.coordinator.requestStop('stop'); await tick();
  const next = new ExecutionCoordinator(f.store, f.services); assert.equal(next.recover(), 1); assert.equal(f.state(), 'uncertain');
  const events = f.store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
  receipt({ session: f.session, executionId: 'native-turn', accepted: true }); assert.equal(await stop, 'owner_lost');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, events);
  f.finish(); assert.equal(await run, 'owner_lost'); assert.equal(next.consumeStopRequests(), 0); assert.equal(f.stopCalls(), 1);
});

test('工作流心跳消费真实规格修订的请求；暂停不阻止已授权用户停止，裁决不自动发生', async t => {
  const f = fixture(t), id = f.prepare(), run = f.coordinator.run(id); await tick();
  const row = f.store.db.prepare("SELECT * FROM tasks WHERE id='task'").get();
  const impact = reviseTaskSpec(f.store, { projectId: 'p', taskId: 'task', expectedRevision: row.revision, expectedSpecRevision: row.spec_revision,
    spec: { goal: '修订任务', inputArtifacts: [], outputRequirements: JSON.parse(row.outputs_json), acceptance: JSON.parse(row.acceptance_json), dependencies: [] }, affectedTaskIds: [], inFlightPolicy: 'request_stop', outputReuse: 'none', reason: '用户改变需求' }, 301);
  assert.deepEqual(impact.stopRequestedAttemptIds, [id]);
  f.store.db.exec("UPDATE projects SET user_paused=1 WHERE id='p'");
  const consumer = new WorkflowConsumer(f.store, f.coordinator, { workspaceForTask: () => 'workspace' });
  consumer.pump(); consumer.pump(); await tick(); assert.equal(f.stopCalls(), 1);
  assert.equal(f.store.db.prepare('SELECT state FROM native_control_requests').get().state, 'requested');
  f.finish({ status: 'interrupted' }); await run;
  assert.equal(f.store.db.prepare('SELECT state FROM native_control_requests').get().state, 'confirmed');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM acceptances').get().n, 0); await consumer.stop();
});

test('停止边界恢复不发送：持久requested但尚无回执视为uncertain；legacy无dispatch明确拒绝', async t => {
  const f = fixture(t), id = f.prepare(), run = f.coordinator.run(id); await tick(); f.request(id);
  f.store.db.exec("UPDATE native_control_requests SET state='requested'");
  const next = new ExecutionCoordinator(f.store, f.services); next.recover(); assert.equal(f.state(), 'uncertain'); assert.equal(next.consumeStopRequests(), 0);
  f.finish(); await run; assert.equal(f.stopCalls(), 0);
  f.store.db.exec("INSERT INTO attempts(id,project_id,task_id,task_revision,binding_id,binding_epoch,state,started_at) VALUES('legacy','p','next',1,'binding',1,'unknown',300)");
  f.request('legacy', null, 'legacy-stop'); assert.equal(await next.requestStop('legacy-stop'), 'rejected'); assert.equal(f.stopCalls(), 0);
});

test('停止回执超时保持uncertain且占位不释放，迟到接受回执不能洗成确认', async t => {
  const f = fixture(t), id = f.prepare(), run = f.coordinator.run(id); await tick(); f.request(id); let receipt;
  f.onStop(() => ({ result: new Promise(resolve => { receipt = resolve; }) }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stop = f.coordinator.requestStop('stop'); await tick(); t.mock.timers.tick(10000);
  assert.equal(await stop, 'uncertain'); assert.equal(f.reservation().state, 'reserved');
  receipt({ session: f.session, executionId: 'native-turn', accepted: true }); await tick(); assert.equal(f.state(), 'uncertain');
  f.finish(); await run; assert.equal(f.state(), 'confirmed');
});

test('多次规格修订生成不同请求也不重复停止同一原生执行，已有uncertain不能借新ID重发', async t => {
  const f = fixture(t), id = f.prepare(), run = f.coordinator.run(id); await tick(); f.request(id);
  assert.equal(await f.coordinator.requestStop('stop'), 'requested');
  f.store.db.prepare("INSERT INTO native_control_requests SELECT 'second',project_id,attempt_id,binding_id,binding_epoch,expected_native_execution_id,3,kind,'pending',301 FROM native_control_requests WHERE id='stop'").run();
  assert.equal(await f.coordinator.requestStop('second'), 'uncertain'); assert.equal(f.stopCalls(), 1);
  f.store.db.exec("UPDATE native_control_requests SET state='uncertain' WHERE id='stop'");
  f.store.db.prepare("INSERT INTO native_control_requests SELECT 'third',project_id,attempt_id,binding_id,binding_epoch,expected_native_execution_id,4,kind,'pending',302 FROM native_control_requests WHERE id='stop'").run();
  assert.equal(await f.coordinator.requestStop('third'), 'uncertain'); assert.equal(f.stopCalls(), 1);
  f.finish(); await run;
  assert.deepEqual(f.store.db.prepare('SELECT DISTINCT state FROM native_control_requests').all().map(row => row.state), ['confirmed']);
});

test('准备停止后到外发前的绑定/版本/目录栅栏漂移再次拒绝，不能仅凭第一道检查发送', async t => {
  for (const scenario of ['binding', 'identity', 'fence']) {
    const f = fixture(t), id = f.prepare(), run = f.coordinator.run(id); await tick(); f.request(id); let checks = 0;
    f.driver.assertOwner = () => {
      if (++checks !== 1) return;
      if (scenario === 'binding') f.store.db.exec('UPDATE role_bindings SET ended_at=300');
      if (scenario === 'identity') { f.changeIdentity(); f.prove({ nativeCancel: 'verified' }); }
      if (scenario === 'fence') f.store.db.exec('UPDATE workspace_reservations SET fence=fence+1');
    };
    assert.equal(await f.coordinator.requestStop('stop'), 'uncertain', scenario); assert.equal(f.stopCalls(), 0, scenario);
    assert.notEqual(f.reservation().state, 'released'); f.finish(); await run;
  }
});

test('实际子进程停止投递产生副作用后崩溃，requested已提交，恢复不重发不释放', t => {
  const f = fixture(t); f.store.close();
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./execution-crash-worker.mjs', import.meta.url)), f.filename, 'stop'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(child.error, undefined); assert.equal(child.stdout.trim(), 'CRASH_POINT:after-stop-side-effect');
  assert.ok(child.signal || child.status !== 0); assert.doesNotMatch(child.stderr, /Error:|SyntaxError/);
  const store = openStore(f.filename); f.stores.push(store);
  assert.equal(store.db.prepare('SELECT state FROM native_control_requests').get().state, 'requested');
  assert.equal(fs.readFileSync(path.join(f.dir, 'workspace', 'synthetic-stop-effect.txt'), 'utf8'), 'one stop effect');
  const next = new ExecutionCoordinator(store, f.services); assert.equal(next.recover(), 1);
  assert.equal(store.db.prepare('SELECT state FROM native_control_requests').get().state, 'uncertain');
  assert.equal(store.db.prepare('SELECT state FROM workspace_reservations').get().state, 'unknown');
  assert.equal(next.consumeStopRequests(), 0); assert.equal(f.stopCalls(), 0);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  t.diagnostic(`real-stop-process-crash; exit=${child.status}; signal=${child.signal}`);
});

test('关闭时事务guard拒绝旧owner写入，仍终止等待，不因保存uncertain失败而挂起', async t => {
  const f = fixture(t), id = f.prepare(), run = f.coordinator.run(id); await tick(); f.request(id);
  f.onStop(() => ({ result: new Promise(() => {}) }));
  const stop = f.coordinator.requestStop('stop'); await tick();
  f.store.installTransactionGuard(() => { throw new Error('KERNEL_NOT_OWNER'); });
  await assert.rejects(f.coordinator.detach(), /KERNEL_NOT_OWNER/);
  assert.equal(await stop, 'owner_lost'); assert.equal(await run, 'owner_lost');
  assert.equal(f.state(), 'requested'); assert.equal(f.row(id).phase, 'running'); assert.equal(f.reservation().state, 'reserved');
  assert.equal(f.coordinator.inFlight, 0); await assert.rejects(f.coordinator.requestStop('stop'), /OWNER_LOST/);
});

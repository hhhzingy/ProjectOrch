import test from 'node:test';
import assert from 'node:assert/strict';
import { executionFixture } from './execution-fixture.mjs';
import { ExecutionCoordinator } from '../../../apps/kernel/dist/execution/coordinator.js';

// 会话、能力和历史观察均为合成，不调用官方原生或模型。
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) {
  const f = executionFixture(t), id = f.prepare(), run = f.coordinator.run(id); await tick();
  f.finish({ status: 'unknown', terminalConfirmed: false }); assert.equal(await run, 'unknown');
  let calls = 0, observe;
  f.driver.inspectExecution = input => { calls++; return { result: observe ? observe(input) : Promise.resolve({ ...input, status: 'completed', terminalConfirmed: true }) }; };
  return Object.assign(f, { id, reads: () => calls, onInspect: fn => { observe = fn; } });
}

test('精确权威终态同事务核对unknown尝试、停止请求和目录；不创建新会话/执行或自动验收', async t => {
  for (const [status, expected] of [['completed', 'succeeded'], ['failed', 'failed'], ['interrupted', 'interrupted']]) {
    const f = await fixture(t);
    f.store.db.prepare("INSERT INTO native_control_requests(id,project_id,attempt_id,binding_id,binding_epoch,expected_native_execution_id,task_spec_revision,kind,state,created_at) VALUES('stop','p',?,'binding',1,'native-turn',2,'stop','uncertain',300)").run(f.id);
    f.onInspect(input => { assert.deepEqual(input, { session: f.session, executionId: 'native-turn' }); return Promise.resolve({ ...input, status, terminalConfirmed: true }); });
    assert.equal(await f.coordinator.reconcile(f.id), expected);
    assert.equal(f.row(f.id).phase, expected); assert.equal(f.reservation().state, 'released');
    const attempt = f.store.db.prepare('SELECT * FROM attempts WHERE id=?').get(f.id);
    assert.equal(attempt.state, expected); assert.equal(attempt.native_execution_id, 'native-turn'); assert.equal(attempt.ended_at, 300);
    assert.equal(f.store.db.prepare('SELECT state FROM native_control_requests').get().state, 'confirmed');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM acceptances').get().n, 0);
    assert.equal(f.calls, 1); assert.equal(f.reads(), 1);
    assert.equal(await f.coordinator.reconcile(f.id), expected); assert.equal(f.reads(), 1);
  }
});

test('受信只读恢复驱动允许新进程owner观察，终态与旧租约确认后才释放；确认失败仍unknown',async t=>{
 for(const rejected of [false,true]){
   const f=await fixture(t);let confirmations=0;
   f.driver.ownerKey='new-trusted-observer';f.driver.supportsReadOnlyRecovery=true;
   f.driver.confirmRecoveredTerminal=outcome=>{confirmations++;assert.equal(outcome.executionId,'native-turn');if(rejected)throw new Error('NATIVE_OWNER_STILL_ALIVE');};
   assert.equal(await f.coordinator.reconcile(f.id),rejected?'unknown':'succeeded');
   assert.equal(confirmations,1);assert.equal(f.reservation().state,rejected?'unknown':'released');assert.equal(f.calls,1);
 }
});

test('同实例并发核对只读一次，读期间不解锁，原生ID与未知占位保持', async t => {
  const f = await fixture(t); let receipt;
  f.onInspect(() => new Promise(resolve => { receipt = resolve; }));
  const a = f.coordinator.reconcile(f.id), b = f.coordinator.reconcile(f.id); await tick();
  assert.equal(f.reads(), 1); assert.equal(f.reservation().state, 'unknown'); assert.throws(() => f.coordinator.close(), /IN_FLIGHT/);
  receipt({ session: f.session, executionId: 'native-turn', status: 'completed', terminalConfirmed: true });
  assert.deepEqual(await Promise.all([a, b]), ['succeeded', 'succeeded']); assert.equal(f.calls, 1);
});

test('错会话/配置档/执行ID、非终态、未确认、异常和畸形观察都不能解锁或猜补ID', async t => {
  for (const scenario of ['session', 'profile', 'id', 'unknown', 'unconfirmed', 'reject', 'null', 'invalid-handle']) {
    const f = await fixture(t);
    if (scenario === 'invalid-handle') f.driver.inspectExecution = () => ({});
    else f.onInspect(input => {
      if (scenario === 'reject') return Promise.reject(new Error('secret native error not recorded'));
      if (scenario === 'null') return Promise.resolve(null);
      return Promise.resolve({ ...input, status: scenario === 'unknown' ? 'unknown' : 'completed', terminalConfirmed: scenario !== 'unconfirmed',
        ...(scenario === 'session' ? { session: { ...f.session, nativeConversationId: 'other' } } : scenario === 'profile' ? { session: { ...f.session, profileId: 'other' } } : scenario === 'id' ? { executionId: 'other' } : {}) });
    });
    assert.equal(await f.coordinator.reconcile(f.id), 'unknown', scenario);
    assert.equal(f.reservation().state, 'unknown'); assert.equal(f.row(f.id).native_execution_id, 'native-turn');
    assert.equal(f.store.db.prepare('SELECT native_execution_id FROM attempts').get().native_execution_id, 'native-turn');
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE body_json LIKE '%secret native error%'").get().n, 0);
  }
});

test('未验证历史能力、换版本/driver owner/绑定会话、路径和预约漂移在读取前拒绝', async t => {
  for (const scenario of ['capability', 'identity', 'owner', 'session', 'workspace', 'fence', 'released', 'attempt', 'missing-id', 'method', 'async']) {
    const f = await fixture(t);
    if (scenario === 'capability') f.prove({ historyRead: 'unsupported' });
    if (scenario === 'identity') f.changeIdentity();
    if (scenario === 'owner') f.driver.ownerKey = 'new-unproven-owner';
    if (scenario === 'session') f.store.db.exec("UPDATE sessions SET native_conversation_id='other'");
    if (scenario === 'workspace') f.driver.workspaceRoot = f.dir;
    if (scenario === 'fence') f.store.db.exec('UPDATE workspace_reservations SET fence=fence+1');
    if (scenario === 'released') f.store.db.exec("UPDATE workspace_reservations SET state='released'");
    if (scenario === 'attempt') f.store.db.exec("UPDATE attempts SET native_execution_id='other'");
    if (scenario === 'missing-id') f.store.db.exec('UPDATE execution_dispatches SET native_execution_id=NULL');
    if (scenario === 'method') delete f.driver.inspectExecution;
    if (scenario === 'async') f.driver.inspectExecution = async () => { throw new Error('must not read'); };
    assert.equal(await f.coordinator.reconcile(f.id), 'unknown', scenario); assert.equal(f.reads(), 0, scenario);
    assert.equal(f.row(f.id).phase, 'unknown'); assert.equal(f.calls, 1);
  }
});

test('等待历史期间的绑定/能力/driver/目录/栅栏漂移再次拒绝，不能靠旧观察解锁', async t => {
  for (const scenario of ['session', 'capability', 'driver', 'workspace', 'fence', 'attempt']) {
    const f = await fixture(t); let receipt;
    f.onInspect(() => new Promise(resolve => { receipt = resolve; }));
    const read = f.coordinator.reconcile(f.id); await tick();
    if (scenario === 'session') f.driver.session = { ...f.session, nativeConversationId: 'other' };
    if (scenario === 'capability') f.prove({ historyRead: 'unsupported' });
    if (scenario === 'driver') f.services.driverForBinding = () => ({ ...f.driver });
    if (scenario === 'workspace') f.store.db.exec('UPDATE workspaces SET revision=revision+1');
    if (scenario === 'fence') f.store.db.exec('UPDATE workspace_reservations SET fence=fence+1');
    if (scenario === 'attempt') f.store.db.exec("UPDATE attempts SET native_execution_id='other'");
    receipt({ session: f.session, executionId: 'native-turn', status: 'completed', terminalConfirmed: true });
    assert.equal(await read, 'unknown', scenario); assert.notEqual(f.reservation().state, 'released'); assert.equal(f.calls, 1);
  }
});

test('unknown记录跨内核接管仍推进栅栏，旧核对迟到不能改新owner；接管者可精确只读核对', async t => {
  const f = await fixture(t); let receipt;
  f.onInspect(() => new Promise(resolve => { receipt = resolve; }));
  const old = f.coordinator.reconcile(f.id); await tick();
  const next = new ExecutionCoordinator(f.store, f.services); assert.equal(next.recover(), 1); assert.equal(next.recover(), 0);
  assert.equal(f.row(f.id).fence, 2); assert.equal(f.row(f.id).native_execution_id, 'native-turn');
  receipt({ session: f.session, executionId: 'native-turn', status: 'completed', terminalConfirmed: true });
  assert.equal(await old, 'owner_lost'); assert.equal(f.row(f.id).phase, 'unknown');
  f.onInspect(input => Promise.resolve({ ...input, status: 'interrupted', terminalConfirmed: true }));
  assert.equal(await next.reconcile(f.id), 'interrupted'); assert.equal(f.reservation().state, 'released'); assert.equal(f.calls, 1);
});

test('观察超时/关闭不等待悬挂历史、不释放占位；迟到成功不可再结算', async t => {
  for (const close of [false, true]) {
    const f = await fixture(t); let receipt;
    f.onInspect(() => new Promise(resolve => { receipt = resolve; }));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const read = f.coordinator.reconcile(f.id); await tick();
    if (close) { await f.coordinator.detach(); assert.equal(await read, 'owner_lost'); }
    else { t.mock.timers.tick(10000); assert.equal(await read, 'unknown'); }
    receipt({ session: f.session, executionId: 'native-turn', status: 'completed', terminalConfirmed: true }); await tick();
    assert.equal(f.row(f.id).phase, 'unknown'); assert.equal(f.reservation().state, 'unknown');
    t.mock.timers.reset();
  }
});

test('终态保存或审计失败整册回滚，保留unknown执行/停止请求/目录，后续可重新只读核对', async t => {
  const f = await fixture(t);
  f.store.db.prepare("INSERT INTO native_control_requests(id,project_id,attempt_id,binding_id,binding_epoch,expected_native_execution_id,task_spec_revision,kind,state,created_at) VALUES('stop','p',?,'binding',1,'native-turn',2,'stop','uncertain',300)").run(f.id);
  f.store.db.exec("CREATE TRIGGER fail_reconcile BEFORE INSERT ON events WHEN NEW.type='execution.reconciled' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  assert.equal(await f.coordinator.reconcile(f.id), 'unknown');
  assert.equal(f.reservation().state, 'unknown'); assert.equal(f.store.db.prepare('SELECT state FROM native_control_requests').get().state, 'uncertain');
  assert.equal(f.store.db.prepare('SELECT state FROM attempts').get().state, 'unknown');
  f.store.db.exec('DROP TRIGGER fail_reconcile'); assert.equal(await f.coordinator.reconcile(f.id), 'succeeded');
  assert.equal(f.reads(), 2); assert.equal(f.calls, 1); assert.equal(f.store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('尝试或派发的条件更新被数据库拒绝时，不提交部分释放或伪造终态', async t => {
  for (const table of ['attempts', 'execution_dispatches']) {
    const f = await fixture(t);
    f.store.db.exec(`CREATE TRIGGER ignore_terminal BEFORE UPDATE ON ${table} WHEN OLD.${table === 'attempts' ? 'state' : 'phase'}='unknown' BEGIN SELECT RAISE(IGNORE); END`);
    assert.equal(await f.coordinator.reconcile(f.id), 'unknown');
    assert.equal(f.reservation().state, 'unknown'); assert.equal(f.row(f.id).phase, 'unknown');
    assert.equal(f.store.db.prepare('SELECT state FROM attempts').get().state, 'unknown');
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='execution.reconciled'").get().n, 0);
  }
});

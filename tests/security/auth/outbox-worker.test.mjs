import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { enqueueOutbox, claimOutbox, settleOutbox, recoverExpiredOutbox } from '../../../packages/persistence/dist/outbox/index.js';
import { pumpOutbox } from '../../../apps/kernel/dist/commands/outbox-worker.js';
import { createCommandRunner } from '../../../apps/kernel/dist/commands/index.js';
import { lifecycleCommandServices } from '../../../apps/kernel/dist/commands/lifecycle-services.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-outbox-worker-', () => { for (const s of stores) s.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const open = () => { const s = openStore(filename); stores.push(s); return s; };
  const store = open();
  createProject(store, { id: 'p1', name: 'synthetic', hostId: 'host', canonicalRoot: 'E:/synthetic/outbox', objective: 'o' }, 100);
  return { store, open };
}
function enqueuePause(store, commandId, operationKey) {
  store.transaction(db => db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES(?,?,?,?,?,?,?,'completed',100)").run(commandId, 'p1', 'synthetic-user', `req-${commandId}`, '0'.repeat(64), 'project.pause', '{}'));
  store.transaction(db => enqueueOutbox(db, { id: `op-${commandId}`, commandId, operationKey, payload: { event: 'project.paused' }, nextAttemptAt: 100 }));
}

test('投递成功结算delivered；失败按backoff重排后成功；不确定结算uncertain', t => {
  const { store } = fixture(t);
  enqueuePause(store, 'c1', 'k1');
  let calls = 0;
  const deliveries = [];
  const clock = { now: 1000 };
  const result1 = pumpOutbox(store, { deliver: lease => { calls += 1; deliveries.push({ key: lease.operationKey, attempts: lease.attempts }); return calls < 2 ? 'not_delivered' : 'delivered'; } }, { now: () => clock.now, backoffMs: 500, leaseMs: 10_000 });
  assert.deepEqual({ ...result1, recoveredExpired: result1.recoveredExpired }, { delivered: 0, uncertain: 0, retried: 1, exhausted: 0, recoveredExpired: 0 });
  clock.now = 1200; // backoff未到（下次可投=1500）
  assert.equal(pumpOutbox(store, { deliver: () => 'delivered' }, { now: () => clock.now }).delivered, 0, 'backoff期内不得重投');
  clock.now = 1600; // 已过backoff
  const result2 = pumpOutbox(store, { deliver: lease => { deliveries.push({ key: lease.operationKey, attempts: lease.attempts }); return 'delivered'; } }, { now: () => clock.now });
  assert.equal(result2.delivered, 1);
  assert.equal(store.db.prepare("SELECT state FROM outbox WHERE operation_key='k1'").get().state, 'delivered');
  assert.deepEqual(deliveries.map(d => d.attempts), [1, 2], '重试后attempts递增');

  enqueuePause(store, 'c2', 'k2');
  const result3 = pumpOutbox(store, { deliver: () => 'uncertain' }, { now: () => 3000 });
  assert.equal(result3.uncertain, 1);
  assert.equal(store.db.prepare("SELECT state FROM outbox WHERE operation_key='k2'").get().state, 'uncertain');
});

test('maxAttempts后转exhausted终态；租约过期回收uncertain；跨重启恢复', t => {
  const { store, open } = fixture(t);
  enqueuePause(store, 'c3', 'k3');
  let clock = 5000;
  for (let i = 0; i < 5; i++) {
    pumpOutbox(store, { deliver: () => 'not_delivered' }, { now: () => clock, backoffMs: 100, maxAttempts: 3 });
    clock += 200;
  }
  assert.equal(store.db.prepare("SELECT state FROM outbox WHERE operation_key='k3'").get().state, 'exhausted');
  assert.equal(JSON.stringify(pumpOutbox(store, { deliver: () => 'delivered' }, { now: () => clock })), JSON.stringify({ delivered: 0, uncertain: 0, retried: 0, exhausted: 0, recoveredExpired: 0 }), 'exhausted不再被领取');

  enqueuePause(store, 'c4', 'k4');
  const lease = claimOutbox(store, 6000, 50);
  assert.ok(lease);
  clock = 6100;
  assert.equal(recoverExpiredOutbox(store, clock), 1, '过期租约回收为uncertain');
  assert.equal(store.db.prepare("SELECT state FROM outbox WHERE operation_key='k4'").get().state, 'uncertain');
  assert.throws(() => settleOutbox(store, lease.id, lease.epoch, clock, 'delivered', { x: 1 }), /LEASE_LOST|LEASE/);

  store.close();
  const reopened = open();
  assert.equal(reopened.db.prepare("SELECT state FROM outbox WHERE operation_key='k3'").get().state, 'exhausted', '重启后exhausted持久');
  assert.equal(reopened.db.prepare("SELECT state FROM outbox WHERE operation_key='k4'").get().state, 'uncertain', '重启后uncertain持久');
});

test('与命令管线贯通：命令产生的Outbox操作被工作器真实投递', t => {
  const { store } = fixture(t);
  const runner = createCommandRunner(store, lifecycleCommandServices(() => 7000));
  runner('synthetic-local-user', { schemaVersion: 2, requestId: 'pipe-1', projectId: 'p1', type: 'project.pause', payload: { reason: 'outbox e2e', currentWorkPolicy: 'finish' } });
  const delivered = [];
  const result = pumpOutbox(store, { deliver: lease => { delivered.push(lease.operationKey); return 'delivered'; } }, { now: () => 7100 });
  assert.equal(result.delivered, 1);
  assert.match(delivered[0], /^project\.paused:p1:\d+$/);
  assert.equal(readProjectPaused(store), 1);
});
function readProjectPaused(store) {
  return Number(store.db.prepare('SELECT user_paused FROM projects WHERE id=\'p1\'').get().user_paused);
}

test('效果已发生后回执丢失或返回非法值：持久uncertain，重启/重复pump不得重发', t => {
  const f = fixture(t);
  enqueuePause(f.store, 'effect-then-error', 'effect-once');
  let effects = 0;
  const result = pumpOutbox(f.store, { deliver: () => { effects++; throw new Error('REPLY_LOST_AFTER_EFFECT'); } }, { now: () => 1000, backoffMs: 0 });
  assert.equal(result.uncertain, 1);
  assert.equal(result.retried, 0);
  assert.equal(f.store.db.prepare("SELECT state FROM outbox WHERE operation_key='effect-once'").get().state, 'uncertain');
  f.store.close();
  const reopened = f.open();
  pumpOutbox(reopened, { deliver: () => { effects++; return 'delivered'; } }, { now: () => 100_000 });
  assert.equal(effects, 1, '重启和时间推进均不能把unknown当作发送前失败');
  enqueuePause(reopened, 'invalid-result', 'invalid-result');
  assert.equal(pumpOutbox(reopened, { deliver: () => 'invented-result' }, { now: () => 100_001 }).uncertain, 1);
  assert.equal(reopened.db.prepare("SELECT state FROM outbox WHERE operation_key='invalid-result'").get().state, 'uncertain');
});

test('策略参数外发前拒绝；过期租约即使已知未执行也不能由旧owner重排', t => {
  const { store } = fixture(t);
  enqueuePause(store, 'policy', 'policy');
  let calls = 0;
  const services = { deliver: () => { calls++; return 'delivered'; } };
  for (const options of [{ maxAttempts: 0 }, { maxPerPump: 0 }, { backoffMs: -1 }, { leaseMs: 0 }]) {
    assert.throws(() => pumpOutbox(store, services, { now: () => 1000, ...options }), /INVALID_/);
  }
  assert.equal(calls, 0);
  let now = 1000;
  assert.throws(() => pumpOutbox(store, { deliver: () => { now = 1002; return 'not_delivered'; } }, { now: () => now, leaseMs: 1 }), /OUTBOX_LEASE_LOST/);
  assert.equal(store.db.prepare("SELECT state FROM outbox WHERE operation_key='policy'").get().state, 'dispatching');
  assert.equal(recoverExpiredOutbox(store, now), 1);
  assert.equal(store.db.prepare("SELECT state FROM outbox WHERE operation_key='policy'").get().state, 'uncertain');
});

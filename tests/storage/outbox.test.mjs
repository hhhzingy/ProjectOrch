import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../packages/persistence/dist/index.js';
import { canonicalJson, claimOutbox, enqueueOutbox, recoverExpiredOutbox, settleOutbox } from '../../packages/persistence/dist/outbox/index.js';

const worker = fileURLToPath(new URL('./outbox-worker.mjs', import.meta.url));
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projectorch-outbox-'));
  const filename = path.join(dir, 'state.sqlite');
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    const resolved = fs.realpathSync(dir);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('projectorch-outbox-'));
    fs.rmSync(resolved, { recursive: true });
  });
  const open = () => { const s = openStore(filename); stores.push(s); return s; };
  const store = open();
  store.transaction(db => {
    db.exec("INSERT INTO projects(id,name,host_id,canonical_root,objective,created_at) VALUES('p1','synthetic','test-host','synthetic/outbox','test',0)");
    db.exec("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('c1','p1','synthetic-principal','req1','synthetic-digest','synthetic','{}','stored',0)");
    db.exec("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('c2','p1','synthetic-principal','req2','synthetic-digest','synthetic','{}','stored',0)");
  });
  return { dir, filename, store, open };
}
const operation = (overrides = {}) => ({ id: 'o1', commandId: 'c1', operationKey: 'c1:send-1', payload: { kind: 'synthetic', data: { b: 2, a: 1 } }, nextAttemptAt: 100, ...overrides });
const row = store => store.db.prepare('SELECT * FROM outbox WHERE id=?').get('o1');

test('严格JSON规范化拒绝有损输入、访问器、循环及超限，不改变对象', () => {
  const value = { z: [1, 'a', null], a: { y: true, b: 0 } };
  const before = structuredClone(value);
  assert.equal(canonicalJson(value), '{"a":{"b":0,"y":true},"z":[1,"a",null]}');
  assert.deepEqual(value, before);
  const cyclic = {}; cyclic.self = cyclic;
  let getterCalled = false;
  const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { getterCalled = true; return 'secret'; } });
  const sparse = []; sparse.length = 1;
  const extraArray = []; extraArray.extra = 1;
  for (const bad of [undefined, NaN, Infinity, 1n, new Date(), () => 0, { x: undefined }, { x: Symbol('x') }, cyclic, getter, sparse, extraArray, { [Symbol('x')]: 1 }, Object.defineProperty({}, 'x', { value: 1 }), { toJSON: () => 1 }]) assert.throws(() => canonicalJson(bad));
  assert.equal(getterCalled, false);
  assert.throws(() => canonicalJson('中'.repeat(400_000)), /JSON_TOO_LARGE/);
  let deep = null; for (let i = 0; i < 34; i++) deep = { deep };
  assert.throws(() => canonicalJson(deep), /JSON_TOO_DEEP/);
});

test('Outbox事务内幂等入队，同键异载荷或异命令拒绝且不改变原记录', t => {
  const { store } = fixture(t);
  assert.throws(() => enqueueOutbox(store.db, operation()), /TRANSACTION_REQUIRED/);
  assert.equal(store.transaction(db => enqueueOutbox(db, operation())), 'o1');
  assert.equal(store.transaction(db => enqueueOutbox(db, operation({ id: 'ignored-new-id', nextAttemptAt: 999, payload: { data: { a: 1, b: 2 }, kind: 'synthetic' } }))), 'o1');
  const before = row(store);
  for (const overrides of [{ payload: { changed: true } }, { commandId: 'c2' }]) assert.throws(() => store.transaction(db => enqueueOutbox(db, operation(overrides))), /IDEMPOTENCY_CONFLICT/);
  assert.deepEqual(row(store), before);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 1);
});

test('状态、事件与Outbox共同回滚，成功提交后重开保留', t => {
  const f = fixture(t);
  const write = db => {
    db.exec("UPDATE projects SET revision=revision+1 WHERE id='p1'");
    db.exec("INSERT INTO events(id,project_id,type,entity_id,entity_revision,body_json,occurred_at) VALUES('e1','p1','synthetic','p1',1,'{}',0)");
    enqueueOutbox(db, operation());
  };
  assert.throws(() => f.store.transaction(db => { write(db); throw new Error('INJECTED_ABORT'); }), /INJECTED_ABORT/);
  assert.equal(row(f.store), undefined);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT revision FROM projects').get().revision, 0);
  f.store.transaction(write);
  f.store.close();
  const reopened = f.open();
  assert.equal(row(reopened).state, 'pending');
  assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
  assert.equal(reopened.db.prepare('SELECT revision FROM projects').get().revision, 1);
});

test('领取只选到期pending；过期不自动重发，旧租约无法回写', t => {
  const { store } = fixture(t);
  store.transaction(db => enqueueOutbox(db, operation()));
  assert.equal(claimOutbox(store, 99, 10), null);
  const lease = claimOutbox(store, 100, 10);
  assert.equal(lease.id, 'o1'); assert.equal(lease.epoch, 1); assert.equal(lease.attempts, 1);
  lease.payload.data.a = 999;
  assert.equal(JSON.parse(row(store).payload_json).data.a, 1);
  assert.equal(claimOutbox(store, 101, 10), null);
  assert.throws(() => settleOutbox(store, 'o1', 2, 105, 'delivered', {}), /LEASE_LOST/);
  assert.throws(() => settleOutbox(store, 'o1', 1, 110, 'delivered', {}), /LEASE_LOST/);
  assert.equal(recoverExpiredOutbox(store, 109), 0);
  assert.equal(recoverExpiredOutbox(store, 110), 1);
  assert.equal(row(store).state, 'uncertain'); assert.equal(row(store).lease_epoch, 2);
  assert.equal(recoverExpiredOutbox(store, 111), 0);
  assert.equal(claimOutbox(store, 111, 10), null);
  assert.throws(() => settleOutbox(store, 'o1', 1, 105, 'delivered', {}), /LEASE_LOST/);
});

test('明确回执保存后不可重复完成，未知结果保持uncertain且重开不重派', t => {
  for (const outcome of ['delivered', 'uncertain']) {
    const f = fixture(t);
    f.store.transaction(db => enqueueOutbox(db, operation()));
    const lease = claimOutbox(f.store, 100, 10);
    settleOutbox(f.store, lease.id, lease.epoch, 101, outcome, { provenance: 'synthetic', nativeCommandId: 'test-operation' });
    const before = row(f.store);
    assert.equal(before.state, outcome);
    assert.equal(before.lease_until, null);
    assert.throws(() => settleOutbox(f.store, lease.id, lease.epoch, 102, outcome, {}), /LEASE_LOST/);
    assert.deepEqual(row(f.store), before);
    f.store.close();
    const reopened = f.open();
    assert.equal(row(reopened).state, outcome);
    assert.equal(claimOutbox(reopened, 200, 10), null);
  }
});

test('非法参数在数据库修改前拒绝，取消及exhausted均不领取', t => {
  const { store } = fixture(t);
  store.transaction(db => enqueueOutbox(db, operation()));
  for (const args of [[-1, 10], [0, 0], [0, 300001], [Number.MAX_SAFE_INTEGER, 1], [0, 1.5]]) assert.throws(() => claimOutbox(store, ...args));
  for (const now of [-1, NaN, Infinity]) assert.throws(() => recoverExpiredOutbox(store, now));
  assert.throws(() => settleOutbox(store, 'o1', 0, 100, 'delivered', {}), /INVALID_LEASE_EPOCH/);
  assert.throws(() => settleOutbox(store, 'o1', 1, 100, 'pending', {}), /INVALID_OUTBOX_OUTCOME/);
  assert.throws(() => settleOutbox(store, 'o1', 1, 100, 'delivered', null), /INVALID_NATIVE_RECEIPT/);
  assert.equal(row(store).state, 'pending'); assert.equal(row(store).lease_epoch, 0);
  for (const status of ['cancelled', 'exhausted']) {
    store.db.prepare('UPDATE outbox SET state=? WHERE id=?').run(status, 'o1');
    assert.equal(claimOutbox(store, 100, 10), null);
  }
});

function competitor(t, filename) {
  const child = fork(worker, [filename, 'compete'], { execPath: process.execPath, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; let result; let failure;
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const ready = new Promise((resolve, reject) => {
    child.on('message', message => {
      if (message.ready) resolve();
      if (Object.hasOwn(message, 'result')) result = message.result;
      if (message.error) failure = message.error;
    });
    child.on('error', reject);
    child.on('exit', code => { if (code !== 0) reject(new Error(`${code}: ${stderr}`)); });
  });
  const finished = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => code === 0 && !failure ? resolve(result) : reject(new Error(failure ?? `${code}: ${stderr}`)));
  });
  // 在等待ready期间也处理失败，避免测试进程产生未处理拒绝。
  void finished.catch(() => undefined);
  return { ready, finished, go() { child.send('go'); } };
}

test('真实两个工作进程同时竞争，仅一方获得有效租约', { timeout: 25000 }, async t => {
  const f = fixture(t);
  f.store.transaction(db => enqueueOutbox(db, operation()));
  f.store.close();
  const workers = [competitor(t, f.filename), competitor(t, f.filename)];
  await Promise.all(workers.map(w => w.ready));
  for (const w of workers) w.go();
  const results = await Promise.all(workers.map(w => w.finished));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.find(Boolean).epoch, 1);
  const reopened = f.open();
  assert.equal(row(reopened).attempts, 1); assert.equal(row(reopened).state, 'dispatching');
});

test('领取提交后真实强制终止，重启将过期操作转未知而不重新发送', t => {
  const f = fixture(t);
  f.store.transaction(db => enqueueOutbox(db, operation()));
  f.store.close();
  const marker = path.join(f.dir, 'claim-committed.json');
  const crash = spawnSync(process.execPath, [worker, f.filename, 'crash', marker], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  assert.equal(crash.error, undefined);
  assert.notEqual(crash.status, 0);
  const committed = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(committed.id, 'o1'); assert.equal(committed.epoch, 1);
  const reopened = f.open();
  assert.equal(row(reopened).state, 'dispatching');
  assert.equal(claimOutbox(reopened, 111, 10), null);
  assert.equal(recoverExpiredOutbox(reopened, 111), 1);
  assert.equal(row(reopened).state, 'uncertain');
  assert.equal(claimOutbox(reopened, 112, 10), null);
  assert.equal(reopened.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

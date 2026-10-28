import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../packages/persistence/dist/index.js';
import { reserveCommand, commitCommandReceipt } from '../../packages/persistence/dist/commands/index.js';
import { applySyntheticCommand, request } from './journal-fixture.mjs';
import { createCommandRunner } from '../../apps/kernel/dist/commands/index.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projectorch-journal-'));
  const filename = path.join(dir, 'state.sqlite');
  const stores = [];
  t.after(() => {
    for (const s of stores) s.close();
    const resolved = fs.realpathSync(dir);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('projectorch-journal-'));
    fs.rmSync(resolved, { recursive: true });
  });
  const open = () => { const s = openStore(filename); stores.push(s); return s; };
  const store = open();
  store.transaction(db => {
    for (const id of ['p1', 'p2']) db.prepare('INSERT INTO projects(id,name,host_id,canonical_root,objective,created_at) VALUES(?,?,\'test-host\',?,\'synthetic\',0)').run(id, id, `synthetic/${id}`);
  });
  return { dir, filename, store, open };
}
function counts(s) {
  return ['commands', 'events', 'outbox'].map(table => s.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
}

test('请求级重试返回原回执；键顺序不影响意图，重开也不重复状态事件Outbox', t => {
  const f = fixture(t);
  const first = applySyntheticCommand(f.store, 'actor-1', 'c1', request());
  assert.equal(first.replay, false);
  const reordered = { payload: { reason: 'synthetic', expectedRevision: 0 }, type: 'project.resume', projectId: 'p1', requestId: 'synthetic-request', schemaVersion: 2 };
  const replay = applySyntheticCommand(f.store, 'actor-1', 'unused', reordered);
  assert.equal(replay.replay, true); assert.equal(replay.commandId, 'c1');
  assert.deepEqual(replay.receipt, first.receipt);
  assert.deepEqual(counts(f.store), [1, 1, 1]);
  assert.equal(f.store.db.prepare("SELECT revision FROM projects WHERE id='p1'").get().revision, 1);
  replay.receipt.entityIds[0].id = 'changed-in-caller';
  f.store.close();
  const reopened = f.open();
  assert.deepEqual(applySyntheticCommand(reopened, 'actor-1', 'also-unused', request()).receipt, first.receipt);
  assert.deepEqual(counts(reopened), [1, 1, 1]);
});

test('同键异载荷或异项目冲突；不同主体的同键独立处理', t => {
  const { store } = fixture(t);
  applySyntheticCommand(store, 'actor-1', 'c1', request());
  for (const input of [request({ payload: { expectedRevision: 0, reason: 'changed' } }), request({ projectId: 'p2' })]) assert.throws(() => applySyntheticCommand(store, 'actor-1', 'c-other', input), /IDEMPOTENCY_CONFLICT/);
  assert.deepEqual(counts(store), [1, 1, 1]);
  const otherActor = applySyntheticCommand(store, 'actor-2', 'c2', request({ projectId: 'p2' }));
  assert.equal(otherActor.replay, false); assert.deepEqual(counts(store), [2, 2, 2]);
  assert.throws(() => store.transaction(db => commitCommandReceipt(db, 'actor-2', 'c1', otherActor.receipt)), /COMMAND_NOT_FOUND/);
});

test('事务在回执保存后失败则整体回滚；合成领域拒绝旧revision时不残留命令', t => {
  const { store } = fixture(t);
  assert.throws(() => applySyntheticCommand(store, 'actor-1', 'aborted', request(), true), /INJECTED_AFTER_RECEIPT/);
  assert.deepEqual(counts(store), [0, 0, 0]);
  assert.equal(store.db.prepare("SELECT revision FROM projects WHERE id='p1'").get().revision, 0);
  applySyntheticCommand(store, 'actor-1', 'c1', request());
  assert.throws(() => applySyntheticCommand(store, 'actor-1', 'stale', request({ requestId: 'new-request' })), /REVISION_CONFLICT/);
  assert.deepEqual(counts(store), [1, 1, 1]);
});

test('拒绝未入事务、正文自认主体、旧协议、非法参数和项目创建请求键冲突', t => {
  const { store } = fixture(t);
  assert.throws(() => reserveCommand(store.db, 'actor', 'c1', request(), 1), /TRANSACTION_REQUIRED/);
  assert.throws(() => commitCommandReceipt(store.db, 'actor', 'c1', {}), /TRANSACTION_REQUIRED/);
  for (const input of [request({ principalId: 'admin' }), request({ schemaVersion: 1 }), request({ payload: { expectedRevision: 0, reason: 'synthetic', sql: 'DELETE' } })]) assert.throws(() => store.transaction(db => reserveCommand(db, 'actor', 'c1', input, 1)));
  assert.throws(() => store.transaction(db => reserveCommand(db, '', 'c1', request(), 1)), /INVALID_COMMAND_TOKEN/);
  assert.throws(() => store.transaction(db => reserveCommand(db, 'actor', 'c1', request(), -1)), /INVALID_COMMAND_TIME/);
  store.db.exec("INSERT INTO global_requests(principal_id,request_id,request_hash,state,receipt_json) VALUES('actor','synthetic-request','synthetic','stored','{}')");
  assert.throws(() => store.transaction(db => reserveCommand(db, 'actor', 'c1', request(), 1)), /IDEMPOTENCY_CONFLICT/);
  assert.deepEqual(counts(store), [0, 0, 0]);
});

const receipt = (overrides = {}) => ({ requestId: 'synthetic-request', projectId: 'p1', commandId: 'c1', status: 'completed', receiptUrl: '/synthetic-not-live', entityIds: [], error: null, lastEventSequence: 0, ...overrides });
test('回执必须匹配命令、请求、项目、当前项目事件序号及固定Schema', t => {
  const { store } = fixture(t);
  store.transaction(db => {
    reserveCommand(db, 'actor', 'c1', request(), 1);
    for (const bad of [receipt({ requestId: 'other' }), receipt({ projectId: 'p2' }), receipt({ commandId: 'other' })]) assert.throws(() => commitCommandReceipt(db, 'actor', 'c1', bad), /TARGET_MISMATCH/);
    assert.throws(() => commitCommandReceipt(db, 'actor', 'c1', receipt({ lastEventSequence: 3 })), /SEQUENCE_MISMATCH/);
    assert.throws(() => commitCommandReceipt(db, 'actor', 'c1', receipt({ status: 'uncertain' })), /INITIAL_RECEIPT_STATE/);
    assert.throws(() => commitCommandReceipt(db, 'actor', 'c1', receipt({ status: 'failed' })));
    assert.throws(() => commitCommandReceipt(db, 'actor', 'c1', receipt({ admin: true })));
    const saved = commitCommandReceipt(db, 'actor', 'c1', receipt());
    assert.equal(saved.status, 'completed');
    assert.throws(() => commitCommandReceipt(db, 'actor', 'c1', receipt()), /ALREADY_FINISHED/);
    reserveCommand(db, 'actor', 'c2', request({ requestId: 'stored-request' }), 1);
    commitCommandReceipt(db, 'actor', 'c2', receipt({ commandId: 'c2', requestId: 'stored-request', status: 'stored' }));
    const storedReplay = reserveCommand(db, 'actor', 'unused', request({ requestId: 'stored-request' }), 1);
    assert.equal(storedReplay.replay, true);
    assert.equal(storedReplay.receipt.status, 'stored');
    assert.throws(() => commitCommandReceipt(db, 'actor', 'c2', receipt({ commandId: 'c2', requestId: 'stored-request', status: 'stored' })), /ALREADY_FINISHED/);
  });
});

test('已持久化不完整或损坏回执不能静默重新执行', t => {
  const { store } = fixture(t);
  store.transaction(db => reserveCommand(db, 'actor', 'c1', request(), 1));
  assert.throws(() => store.transaction(db => reserveCommand(db, 'actor', 'new-id', request(), 1)), /COMMAND_INCOMPLETE/);
  store.db.prepare('UPDATE commands SET receipt_json=? WHERE id=?').run(JSON.stringify(receipt()), 'c1');
  assert.throws(() => store.transaction(db => reserveCommand(db, 'actor', 'new-id', request(), 1)), /STATE_MISMATCH/);
  store.db.prepare('UPDATE commands SET state=?,receipt_json=? WHERE id=?').run('completed', JSON.stringify(receipt({ projectId: 'p2' })), 'c1');
  assert.throws(() => store.transaction(db => reserveCommand(db, 'actor', 'new-id', request(), 1)), /TARGET_MISMATCH/);
  assert.deepEqual(counts(store), [1, 0, 0]);
});

test('内部管线缺少权限默认拒绝，重试前也重新检查撤销后的权限', t => {
  const { store } = fixture(t);
  let allowed = true; let checks = 0; let applies = 0;
  const handlers = new Map([['project.resume', (_db, commandId, input) => {
    applies++;
    return receipt({ commandId, requestId: input.requestId, projectId: input.projectId });
  }]]);
  const run = createCommandRunner(store, { authorize: (_db, principal) => { checks++; return allowed && principal === 'actor'; }, handlers });
  handlers.clear(); // 初始化后外部修改注册表不能切换实际处理器。
  assert.throws(() => run('', request()), /UNAUTHENTICATED/);
  assert.throws(() => run('other', request()), /FORBIDDEN/);
  const first = run('actor', request());
  assert.deepEqual(run('actor', request()), first);
  const replayAfterHandlerRemoved = createCommandRunner(store, { authorize: () => true, handlers: new Map() });
  assert.deepEqual(replayAfterHandlerRemoved('actor', request()), first);
  allowed = false;
  assert.throws(() => run('actor', request()), /FORBIDDEN/);
  assert.equal(applies, 1); assert.equal(checks, 4);
  assert.deepEqual(counts(store), [1, 0, 0]);
});

test('未注册处理器、错误回执和异步函数在内部管线中明确拒绝', t => {
  const { store } = fixture(t);
  assert.throws(() => createCommandRunner(store, { handlers: new Map() }), /SYNC_AUTHORIZER_REQUIRED/);
  const unsupported = createCommandRunner(store, { authorize: () => true, handlers: new Map() });
  assert.throws(() => unsupported('actor', request()), /CAPABILITY_UNSUPPORTED/);
  const malformed = createCommandRunner(store, { authorize: () => true, handlers: new Map([['project.resume', () => receipt({ commandId: 'not-the-generated-command' })]]) });
  assert.throws(() => malformed('actor', request()), /TARGET_MISMATCH/);
  assert.throws(() => createCommandRunner(store, { authorize: async () => true, handlers: new Map() }), /SYNC_AUTHORIZER_REQUIRED/);
  assert.throws(() => createCommandRunner(store, { authorize: () => true, handlers: new Map([['project.resume', async () => ({})]]) }), /SYNC_COMMAND_HANDLER_REQUIRED/);
  assert.deepEqual(counts(store), [0, 0, 0]);
});

test('普通函数误返回Promise时回滚关闭，阻止迟到领域写入', async t => {
  const f = fixture(t);
  let lateError;
  const run = createCommandRunner(f.store, { authorize: () => true, handlers: new Map([['project.resume', (db) => {
    db.exec("UPDATE projects SET revision=99 WHERE id='p1'");
    return Promise.resolve().then(() => {
      try { db.exec("UPDATE projects SET revision=100 WHERE id='p1'"); } catch (error) { lateError = error.message; throw error; }
      return receipt();
    });
  }]]) });
  assert.throws(() => run('actor', request()), /ASYNC_TRANSACTION_FORBIDDEN/);
  await Promise.resolve();
  assert.match(lateError, /not open|closed/i);
  const reopened = f.open();
  assert.deepEqual(counts(reopened), [0, 0, 0]);
  assert.equal(reopened.db.prepare("SELECT revision FROM projects WHERE id='p1'").get().revision, 0);
});

test('权限检查误返回Promise不能被当作允许，也不会提交命令', async t => {
  const f = fixture(t);
  let called = false;
  const run = createCommandRunner(f.store, { authorize: () => Promise.resolve(true), handlers: new Map([['project.resume', () => { called = true; return receipt(); }]]) });
  assert.throws(() => run('actor', request()), /ASYNC_TRANSACTION_FORBIDDEN/);
  await Promise.resolve();
  assert.equal(called, false);
  assert.deepEqual(counts(f.open()), [0, 0, 0]);
});

function competitor(t, filename) {
  const child = fork(fileURLToPath(new URL('./journal-worker.mjs', import.meta.url)), [filename], { execPath: process.execPath, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let result; let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const ready = new Promise((resolve, reject) => {
    child.on('message', message => { if (message.ready) resolve(); if (message.result) result = message.result; if (message.error) stderr += message.error; });
    child.on('error', reject);
    child.on('exit', code => { if (code !== 0) reject(new Error(`${code}: ${stderr}`)); });
  });
  const finished = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => code === 0 && result ? resolve(result) : reject(new Error(`${code}: ${stderr}`)));
  });
  void finished.catch(() => undefined);
  return { ready, finished, go() { child.send('go'); } };
}
test('两个真实进程同时处理同一主体同一请求，只提交一组状态事件Outbox', { timeout: 25000 }, async t => {
  const f = fixture(t); f.store.close();
  const workers = [competitor(t, f.filename), competitor(t, f.filename)];
  await Promise.all(workers.map(w => w.ready));
  for (const w of workers) w.go();
  const results = await Promise.all(workers.map(w => w.finished));
  assert.equal(results.filter(r => r.replay).length, 1);
  assert.deepEqual(results[0].receipt, results[1].receipt);
  const reopened = f.open();
  assert.deepEqual(counts(reopened), [1, 1, 1]);
  assert.equal(reopened.db.prepare("SELECT revision FROM projects WHERE id='p1'").get().revision, 1);
});

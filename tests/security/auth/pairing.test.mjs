import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { issuePairingChallenge, consumePairingChallenge, pairingAttemptLimit } from '../../../apps/kernel/dist/auth/pairing.js';
import { localOrigin, assertPairingSource } from '../../../apps/kernel/dist/auth/local-source.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projectorch-pairing-'));
  const filename = path.join(dir, 'state.sqlite'); const stores = [];
  t.after(() => {
    for (const s of stores) s.close();
    const resolved = fs.realpathSync(dir);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('projectorch-pairing-'));
    fs.rmSync(resolved, { recursive: true });
  });
  const open = () => { const s = openStore(filename); stores.push(s); return s; };
  return { dir, filename, store: open(), open };
}
const input = challenge => ({ schemaVersion: 2, requestId: 'synthetic-pairing-request', challengeId: challenge.challengeId, oneTimeCode: challenge.oneTimeCode });
const headers = config => ['Host', config.authority, 'Origin', config.origin, 'Content-Type', 'application/json'];
const row = (store, challenge) => store.db.prepare('SELECT * FROM pairing_challenges WHERE id=?').get(challenge.challengeId);

test('监听来源仅接受精确回环Origin，拒绝歧义地址、凭据、路径和非回环配置', () => {
  for (const value of ['http://127.0.0.1:43210', 'http://localhost:43210', 'https://[::1]:43210']) {
    const config = localOrigin(value);
    assert.equal(Object.isFrozen(config), true);
    for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.doesNotThrow(() => assertPairingSource(config, peer, headers(config)));
  }
  for (const value of ['https://attacker.invalid', 'http://127.1:43210', 'http://2130706433:43210', 'http://127.0.0.1:0', 'http://localhost.:43210', 'http://user:pass@localhost:43210', 'http://localhost:43210/path', 'http://localhost:43210/', 'http://localhost:43210?x=1', 'http://localhost:43210#x', 'file:///localhost', 'null']) assert.throws(() => localOrigin(value), /INVALID_LOCAL_ORIGIN/);
});

test('非法Host/Origin/端口、重复头、非JSON表单及非回环连接均拒绝', () => {
  const config = localOrigin('http://127.0.0.1:43210');
  const valid = headers(config);
  const badHeaders = [[], ['Host', config.authority], ['Host', config.authority, 'Origin', 'null', 'Content-Type', 'application/json'], [...valid, 'Origin', config.origin], [...valid, 'HOST', config.authority], [...valid, 'Content-Type', 'application/json'], ['Host', '127.0.0.1:43211', 'Origin', config.origin, 'Content-Type', 'application/json'], ['Host', config.authority, 'Origin', 'https://attacker.invalid', 'Content-Type', 'application/json'], ['Host', config.authority, 'Origin', config.origin, 'Content-Type', 'text/plain'], ['Host', config.authority, 'Origin', config.origin, 'Content-Type', 'application/json;\r\ncharset=utf-8'], ['Host', config.authority, 'Origin', config.origin, 'Content-Type', 'application/json; charset=gbk'], [...valid, 'dangling']];
  for (const raw of badHeaders) assert.throws(() => assertPairingSource(config, '127.0.0.1', raw), e => e.message === 'PAIRING_SOURCE_REJECTED');
  for (const peer of [undefined, '192.168.1.1', '::ffff:192.168.1.1']) assert.throws(() => assertPairingSource(config, peer, valid), /SOURCE_REJECTED/);
  assert.doesNotThrow(() => assertPairingSource(config, '127.0.0.1', ['host', config.authority, 'origin', config.origin, 'content-type', 'Application/JSON; charset=UTF-8']));
});

test('真实回环HTTP传输的来源检查接受同源JSON并拒绝第三方与伪造Host', async () => {
  let config;
  const server = createServer((req, res) => {
    try { assertPairingSource(config, req.socket.remoteAddress, req.rawHeaders); res.statusCode = 204; }
    catch { res.statusCode = 403; }
    req.resume(); res.end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  config = localOrigin(`http://127.0.0.1:${port}`);
  const send = custom => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/synthetic-source-probe', method: 'POST', agent: false, headers: { Host: config.authority, Origin: config.origin, 'Content-Type': 'application/json', ...custom } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    req.once('error', reject); req.end('{}');
  });
  try {
    assert.equal(await send({}), 204);
    assert.equal(await send({ Origin: 'https://attacker.invalid' }), 403);
    assert.equal(await send({ Host: 'attacker.invalid' }), 403);
    assert.equal(await send({ 'Content-Type': 'application/x-www-form-urlencoded' }), 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('挑战使用随机秘密且磁盘只保留摘要；成功仅消费一次，不颁发身份', t => {
  const { store } = fixture(t);
  const challenge = issuePairingChallenge(store, 1000, 100);
  const other = issuePairingChallenge(store, 1000, 100);
  assert.notEqual(challenge.oneTimeCode, other.oneTimeCode);
  assert.match(challenge.oneTimeCode, /^[A-Za-z0-9_-]{43}$/);
  assert.match(row(store, challenge).code_hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(row(store, challenge)).includes(challenge.oneTimeCode), false);
  assert.equal(store.transaction(db => consumePairingChallenge(db, input(challenge), 1001)).accepted, true);
  assert.equal(row(store, challenge).consumed_at, 1001);
  assert.equal(store.transaction(db => consumePairingChallenge(db, input(challenge), 1002)).accepted, false);
});

test('失败计数跨重开持久化，锁定和到期均不能凭正确代码消费', t => {
  const f = fixture(t); const challenge = issuePairingChallenge(f.store, 1000, 100);
  const wrong = { ...input(challenge), oneTimeCode: 'synthetic-wrong-code' };
  for (let i = 0; i < pairingAttemptLimit - 1; i++) assert.equal(f.store.transaction(db => consumePairingChallenge(db, wrong, 1001)).accepted, false);
  f.store.close(); const reopened = f.open();
  assert.equal(row(reopened, challenge).failed_attempts, pairingAttemptLimit - 1);
  assert.equal(reopened.transaction(db => consumePairingChallenge(db, wrong, 1002)).accepted, false);
  assert.equal(row(reopened, challenge).failed_attempts, pairingAttemptLimit);
  assert.equal(reopened.transaction(db => consumePairingChallenge(db, input(challenge), 1003)).accepted, false);
  assert.equal(row(reopened, challenge).consumed_at, null);
  const expired = issuePairingChallenge(reopened, 2000, 10);
  assert.equal(reopened.transaction(db => consumePairingChallenge(db, input(expired), 2010)).accepted, false);
  assert.equal(row(reopened, expired).consumed_at, null);
});

test('后续会话建立事务失败可回滚挑战消费，不留半消费状态', t => {
  const { store } = fixture(t); const challenge = issuePairingChallenge(store, 1000, 100);
  assert.throws(() => store.transaction(db => {
    assert.equal(consumePairingChallenge(db, input(challenge), 1001).accepted, true);
    throw new Error('SYNTHETIC_SESSION_ISSUANCE_FAILURE');
  }), /ISSUANCE_FAILURE/);
  assert.equal(row(store, challenge).consumed_at, null);
  assert.equal(store.transaction(db => consumePairingChallenge(db, input(challenge), 1002)).accepted, true);
});

test('旧协议、自报管理员、畸形输入及未入事务调用不能消耗挑战', t => {
  const { store } = fixture(t); const challenge = issuePairingChallenge(store, 1000, 100);
  assert.throws(() => consumePairingChallenge(store.db, input(challenge), 1001), /TRANSACTION_REQUIRED/);
  for (const request of [{ ...input(challenge), schemaVersion: 1 }, { ...input(challenge), principalId: 'admin' }, { ...input(challenge), oneTimeCode: 123 }]) assert.throws(() => store.transaction(db => consumePairingChallenge(db, request, 1001)));
  for (const ttl of [0, 300001, 1.5]) assert.throws(() => issuePairingChallenge(store, 1000, ttl), /INVALID_PAIRING_TTL/);
  assert.throws(() => issuePairingChallenge(store, -1), /INVALID_PAIRING_TIME/);
  assert.equal(row(store, challenge).consumed_at, null);
  assert.equal(row(store, challenge).failed_attempts, 0);
  assert.equal(store.transaction(db => consumePairingChallenge(db, { ...input(challenge), challengeId: 'synthetic-missing' }, 1001)).accepted, false);
});

function competitor(t, filename, request) {
  const child = fork(fileURLToPath(new URL('./pairing-worker.mjs', import.meta.url)), [filename], { execPath: process.execPath, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let result;
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const ready = new Promise((resolve, reject) => {
    child.on('message', message => { if (message.ready) resolve(); if (Object.hasOwn(message, 'accepted')) result = message.accepted; });
    child.on('error', reject); child.on('exit', code => { if (code !== 0) reject(new Error('PAIRING_WORKER_FAILED')); });
  });
  const finished = new Promise((resolve, reject) => {
    child.on('error', reject); child.on('exit', code => code === 0 && typeof result === 'boolean' ? resolve(result) : reject(new Error('PAIRING_WORKER_FAILED')));
  });
  void finished.catch(() => undefined);
  return { ready, finished, go() { child.send({ request, now: 1001 }); } };
}
test('真实双进程竞争消费同一挑战，仅一方成功，秘密通过IPC而非命令行传递', { timeout: 25000 }, async t => {
  const f = fixture(t); const challenge = issuePairingChallenge(f.store, 1000, 100); f.store.close();
  const workers = [competitor(t, f.filename, input(challenge)), competitor(t, f.filename, input(challenge))];
  await Promise.all(workers.map(w => w.ready)); for (const w of workers) w.go();
  const results = await Promise.all(workers.map(w => w.finished));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(row(f.open(), challenge).consumed_at, 1001);
});

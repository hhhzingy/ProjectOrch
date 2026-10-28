import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { reconcileUncertainOutbox } from '../../../packages/persistence/dist/outbox/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { managementOverview } from '../../../packages/domain/dist/views/index.js';
import { issuePairingChallenge } from '../../../apps/kernel/dist/auth/pairing.js';
import { createCommandRunner } from '../../../apps/kernel/dist/commands/index.js';
import { lifecycleCommandServices, commandErrorStatus } from '../../../apps/kernel/dist/commands/lifecycle-services.js';
import { startKernel } from '../../../apps/kernel/dist/lifecycle/kernel-runtime.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

function request(port, method, target, headers, body = null) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path: target, headers }, response => {
      const chunks = [];
      response.on('data', c => chunks.push(c));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8'), setCookie: response.headers['set-cookie'] ?? [] }));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}
const pauseBody = requestId => JSON.stringify({ schemaVersion: 2, requestId, projectId: 'p1', type: 'project.pause', payload: { reason: 'runtime e2e', currentWorkPolicy: 'finish' } });

test('内核生命周期：启动→配对→命令→事件/Outbox投递→优雅停止→重启恢复水位与状态', async t => {
  const openStores = [];
  const dir = temporaryDirectory(t, 'projectorch-kernel-runtime-', () => { for (const close of openStores.splice(0)) close(); });
  const filename = path.join(dir, 'state.sqlite');
  const track = store => { openStores.push(() => { try { store.close(); } catch { /* 已关闭 */ } }); return store; };
  // 项目先行建立（项目创建属用户入口，非内核启动序列）
  const seed = track(openStore(filename));
  createProject(seed, { id: 'p1', name: 'synthetic', hostId: 'host', canonicalRoot: 'E:/synthetic/runtime', objective: 'o' }, 100);
  seed.close();

  // runner绑定常开的专用store（与内核store同一数据库文件，WAL并发）
  const runnerStore = track(openStore(filename));
  const runner = createCommandRunner(runnerStore, lifecycleCommandServices());
  let runtime = await startKernel({ filename, principalId: 'synthetic-local-user', commandRunner: (principalId, input) => runner(principalId, input), commandErrorStatus, outbox: { deliver: () => 'delivered' }, outboxPollMs: 200 });
  track(runtime.store);
  assert.equal(runtime.recovery.recoveredExpiredLeases, 0);
  assert.deepEqual(runtime.eventWatermarks(), []);

  const authority = `127.0.0.1:${runtime.gateway.port}`;
  const origin = `http://${authority}`;
  const challenge = issuePairingChallenge(runtime.store);
  const paired = await request(runtime.gateway.port, 'POST', '/api/v1/pairing', { Host: authority, Origin: origin, 'Content-Type': 'application/json' }, JSON.stringify({ schemaVersion: 2, requestId: 'pair', challengeId: challenge.challengeId, oneTimeCode: challenge.oneTimeCode }));
  const cookie = /projectorch_session=([^;]+)/.exec(paired.setCookie.find(c => c.startsWith('projectorch_session=')) ?? '')[1];
  const csrf = JSON.parse(paired.body).csrfToken;

  const posted = await request(runtime.gateway.port, 'POST', '/api/v1/commands', { Host: authority, Origin: origin, Cookie: `projectorch_session=${cookie}`, 'x-projectorch-csrf': csrf, 'Content-Type': 'application/json' }, pauseBody('rt-1'));
  assert.equal(posted.status, 200);
  assert.equal(JSON.parse(posted.body).lastEventSequence, 1);
  for (let i = 0; i < 30 && runtime.outboxTotals().delivered === 0; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(runtime.outboxTotals().delivered, 1, 'Outbox循环应完成投递');
  assert.deepEqual(runtime.eventWatermarks(), [{ projectId: 'p1', lastSequence: 1 }]);

  await runtime.stop();
  await assert.rejects(() => request(runtime.gateway.port, 'GET', '/api/v1/session', {}));

  let runtime2 = await startKernel({ filename, principalId: 'synthetic-local-user', commandRunner: (principalId, input) => runner(principalId, input), commandErrorStatus });
  track(runtime2.store);
  assert.deepEqual(runtime2.recovery.watermarks, [{ projectId: 'p1', lastSequence: 1 }], '重启恢复事件水位');
  assert.equal(runtime2.outboxTotals().delivered, 1, '重启后Outbox状态持久');
  await runtime2.stop();
});

test('恢复路径：过期租约在启动时回收为uncertain', async t => {
  const openStores = [];
  const dir = temporaryDirectory(t, 'projectorch-kernel-recover-', () => { for (const close of openStores.splice(0)) close(); });
  const filename = path.join(dir, 'state.sqlite');
  const seed = openStore(filename);
  createProject(seed, { id: 'p1', name: 's', hostId: 'h', canonicalRoot: 'E:/synthetic/recover', objective: 'o' }, 100);
  seed.transaction(db => db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('c9','p1','u','r9',?,'project.pause','{}','completed',100)").run('0'.repeat(64)));
  seed.transaction(db => db.prepare("INSERT INTO outbox(id,command_id,operation_key,payload_json,state,next_attempt_at,lease_epoch,lease_until,attempts) VALUES('op9','c9','k9','{}','dispatching',100,7,500,1)").run());
  seed.close();
  const runtime = await startKernel({ filename, principalId: 'synthetic-local-user' });
  openStores.push(() => { try { runtime.store.close(); } catch { /* 已关闭 */ } });
  assert.equal(runtime.recovery.recoveredExpiredLeases, 1, '启动即回收过期租约');
  assert.equal(runtime.outboxTotals().uncertain, 1);
  await runtime.stop();
});

test('单实例锁：活跃内核拒绝二次启动；优雅停止与过期心跳允许接管', async t => {
  const openStores = [];
  const dir = temporaryDirectory(t, 'projectorch-kernel-lock-', () => { for (const close of openStores.splice(0)) close(); });
  const filename = path.join(dir, 'state.sqlite');
  const seed = openStore(filename);
  createProject(seed, { id: 'p1', name: 's', hostId: 'h', canonicalRoot: 'E:/synthetic/lock', objective: 'o' }, 100);
  seed.close();
  let clock = 1_000;
  const now = () => clock;
  const first = await startKernel({ filename, principalId: 'u', now, lockLeaseMs: 30_000, outbox: { deliver: () => 'delivered' } });
  openStores.push(() => { try { first.store.close(); } catch { /* 已关闭 */ } });
  await assert.rejects(() => startKernel({ filename, principalId: 'u', now, lockLeaseMs: 30_000 }), /KERNEL_ALREADY_RUNNING/, '活跃租约拒绝重复启动内核');
  await first.stop();
  const again = await startKernel({ filename, principalId: 'u', now, lockLeaseMs: 30_000 });
  openStores.push(() => { try { again.store.close(); } catch { /* 已关闭 */ } });
  await again.stop();
  clock = 100_000;
  const crashed = await startKernel({ filename, principalId: 'u', now, lockLeaseMs: 30_000 });
  openStores.push(() => { try { crashed.store.close(); } catch { /* 已关闭 */ } });
  clock += 30_001; // 模拟持有进程死亡：心跳停止续期直至超过租约
  const takeover = await startKernel({ filename, principalId: 'u', now, lockLeaseMs: 30_000 });
  openStores.push(() => { try { takeover.store.close(); } catch { /* 已关闭 */ } });
  await crashed.stop();
  await takeover.stop();
});

test('崩溃恢复：未知执行转为uncertain后不自动重派，只读总览如实反映', async t => {
  const openStores = [];
  const dir = temporaryDirectory(t, 'projectorch-kernel-noredispatch-', () => { for (const close of openStores.splice(0)) close(); });
  const filename = path.join(dir, 'state.sqlite');
  const seed = openStore(filename);
  createProject(seed, { id: 'p1', name: 's', hostId: 'h', canonicalRoot: 'E:/synthetic/nrd', objective: 'o' }, 100);
  seed.transaction(db => db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('c9','p1','u','r9',?,'project.pause','{}','completed',100)").run('0'.repeat(64)));
  seed.transaction(db => db.prepare("INSERT INTO outbox(id,command_id,operation_key,payload_json,state,next_attempt_at,lease_epoch,lease_until,attempts) VALUES('op9','c9','k9','{}','dispatching',100,7,500,1)").run());
  seed.close();
  const delivered = [];
  const runtime = await startKernel({ filename, principalId: 'u', outbox: { deliver: lease => { delivered.push(lease.id); return 'delivered'; } }, outboxPollMs: 50 });
  openStores.push(() => { try { runtime.store.close(); } catch { /* 已关闭 */ } });
  assert.equal(runtime.recovery.recoveredExpiredLeases, 1, '崩溃遗留租约启动即回收');
  assert.equal(runtime.outboxTotals().uncertain, 1);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(delivered, [], '未知执行不得自动重派');
  assert.equal(managementOverview(runtime.store, 'p1').deliveryUncertain, 1, '只读总览如实反映不确定');
  reconcileUncertainOutbox(runtime.store, 'op9', 'not_applied', { probe: 'manual-check' }, Date.now(), 0);
  for (let i = 0; i < 30 && runtime.outboxTotals().delivered === 0; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(runtime.outboxTotals().delivered, 1, '显式核对未应用后按重排真实派发');
  assert.deepEqual(delivered, ['op9']);
  await runtime.stop();
});

test('接管后旧内核拒绝HTTP和事务，停止旧实例不释放新锁，过期owner不自复活', async t => {
  const runtimes = [];
  t.after(async () => { for (const runtime of runtimes) await runtime.stop(); });
  const dir = temporaryDirectory(t, 'projectorch-kernel-fence-', () => {});
  let clock = 1_000; const now = () => clock; const filename = path.join(dir, 'state.sqlite');
  let deliveries = 0;
  const first = await startKernel({ filename, principalId: 'u', now, lockLeaseMs: 1_000, outboxPollMs: 10, outbox: { deliver: () => { deliveries++; return 'delivered'; } } }); runtimes.push(first);
  first.store.transaction(db => {
    createSeed(db);
    db.prepare("INSERT INTO outbox(id,command_id,operation_key,payload_json,state,next_attempt_at) VALUES('op','cmd','key','{}','pending',5000)").run();
  });
  clock = 2_001;
  const second = await startKernel({ filename, principalId: 'u', now, lockLeaseMs: 1_000 }); runtimes.push(second);
  assert.equal(first.isOwner(), false); assert.equal(second.isOwner(), true);
  let writes = 0;
  assert.throws(() => first.store.transaction(() => { writes++; }), /KERNEL_OWNER_LOST/);
  assert.equal(writes, 0, '事务guard在业务回调前拒绝');
  assert.throws(() => first.store.installTransactionGuard(() => {}), /INVALID_TRANSACTION_GUARD/);
  const reply = await request(first.gateway.port, 'GET', '/api/v1/session', { Host: `127.0.0.1:${first.gateway.port}` });
  assert.equal(reply.status, 503); assert.equal(JSON.parse(reply.body).error, 'KERNEL_NOT_OWNER');
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(deliveries, 0);
  const holder = second.store.db.prepare('SELECT holder FROM kernel_lock').get().holder;
  await first.stop();
  assert.equal(second.store.db.prepare('SELECT holder FROM kernel_lock').get().holder, holder);
  assert.equal(second.isOwner(), true);
  await second.stop();

  function createSeed(db) {
    db.prepare("INSERT INTO projects(id,name,host_id,canonical_root,objective,policy_revision,plan_revision,hold_revision,user_paused,policy_json,created_at) VALUES('p','p','h','E:/synthetic/fence','o',0,0,0,0,'{}',100)").run();
    db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('cmd','p','u','r',?,'project.pause','{}','completed',100)").run('0'.repeat(64));
  }
});

test('请求体读取期间丢锁，旧请求不得调用命令处理器', async t => {
  const runtimes = [];
  t.after(async () => { for (const runtime of runtimes) await runtime.stop(); });
  const dir = temporaryDirectory(t, 'projectorch-kernel-body-fence-', () => {});
  let clock = 1_000, calls = 0; const now = () => clock; const filename = path.join(dir, 'state.sqlite');
  const first = await startKernel({ filename, principalId: 'u', now, lockLeaseMs: 1_000, commandRunner: () => { calls++; return {}; } }); runtimes.push(first);
  const authority = `127.0.0.1:${first.gateway.port}`, origin = `http://${authority}`;
  const challenge = issuePairingChallenge(first.store, clock);
  const paired = await request(first.gateway.port, 'POST', '/api/v1/pairing', { Host: authority, Origin: origin, 'Content-Type': 'application/json' }, JSON.stringify({ schemaVersion: 2, requestId: 'pair', challengeId: challenge.challengeId, oneTimeCode: challenge.oneTimeCode }));
  assert.equal(paired.status, 200);
  const cookie = paired.setCookie.find(c => c.startsWith('projectorch_session=')).split(';')[0];
  const csrf = JSON.parse(paired.body).csrfToken;
  let pending;
  const response = new Promise((resolve, reject) => {
    pending = httpRequest({ host: '127.0.0.1', port: first.gateway.port, path: '/api/v1/commands', method: 'POST', headers: { Host: authority, Origin: origin, Cookie: cookie, 'x-projectorch-csrf': csrf, 'Content-Type': 'application/json' } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    pending.on('error', reject); pending.write('{');
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  clock = 2_001; const second = await startKernel({ filename, principalId: 'u', now, lockLeaseMs: 1_000 }); runtimes.push(second);
  pending.end('}'); const reply = await response;
  assert.equal(reply.status, 503); assert.equal(calls, 0);
});

test('停止拒绝未收齐请求，关闭期间保持锁到HTTP关闭，重复stop等待同一清理', async t => {
  const runtimes = [];
  t.after(async () => { for (const runtime of runtimes) await runtime.stop(); });
  const dir = temporaryDirectory(t, 'projectorch-kernel-stop-fence-', () => {});
  const filename = path.join(dir, 'state.sqlite');
  const first = await startKernel({ filename, principalId: 'u' }); runtimes.push(first);
  const oldHolder = first.store.db.prepare('SELECT holder FROM kernel_lock').get().holder;
  let holderWhenClosed;
  first.gateway.server.once('close', () => { holderWhenClosed = first.store.db.prepare('SELECT holder FROM kernel_lock').get().holder; });
  const pending = httpRequest({ host: '127.0.0.1', port: first.gateway.port, path: '/api/v1/pairing', method: 'POST', headers: { Host: `127.0.0.1:${first.gateway.port}`, Origin: `http://127.0.0.1:${first.gateway.port}`, 'Content-Type': 'application/json' } });
  const disconnected = new Promise(resolve => { pending.on('error', resolve); pending.on('close', resolve); });
  pending.write('{'); await new Promise(resolve => setTimeout(resolve, 20));
  const one = first.stop(), two = first.stop(); assert.equal(one, two); assert.equal(first.isOwner(), false);
  await Promise.all([one, two, disconnected]); assert.equal(holderWhenClosed, oldHolder);
  const second = await startKernel({ filename, principalId: 'u' }); runtimes.push(second); assert.equal(second.isOwner(), true);
});

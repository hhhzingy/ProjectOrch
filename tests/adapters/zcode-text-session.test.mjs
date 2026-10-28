import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ZCodeTextSession } from '../../apps/kernel/dist/native/zcode-text-session.js';
import { temporaryDirectory } from './temporary-directory.mjs';
const ref = { harnessId: 'zcode', hostId: 'synthetic-host', profileId: 'synthetic-profile', nativeConversationId: 'synthetic-native-session' };
const options = { executable: process.execPath, bundle: fileURLToPath(new URL('./zcode-cli-worker.mjs', import.meta.url)), cwd: fileURLToPath(new URL('../../', import.meta.url)), env: {}, timeoutMs: 1000 };
function directory(t) { return temporaryDirectory(t, 'projectorch-zcode-owner-'); }
test('受管会话跨实例持久排他，连续轮次固定原生ID，关闭后可重新接管', async t => {
  const dir = directory(t); const first = new ZCodeTextSession(dir, ref, options);
  assert.throws(() => new ZCodeTextSession(dir, ref, options), /NATIVE_OWNER_OCCUPIED/);
  assert.equal((await first.execute('synthetic-one')).result.sessionId, ref.nativeConversationId);
  assert.equal((await first.execute('synthetic-two')).result.sessionId, ref.nativeConversationId);
  first.close(); assert.equal(first.phase, 'closed');
  await assert.rejects(first.execute('synthetic-late'), /SESSION_OWNER_CLOSED/);
  const second = new ZCodeTextSession(dir, ref, options); second.close();
});
test('运行中不能释放，unknown继续持有占位，重建owner不能绕过', async t => {
  const dir = directory(t); const owner = new ZCodeTextSession(dir, ref, { ...options, timeoutMs: 200 });
  const run = owner.execute('silent');
  assert.throws(() => owner.close(), /SESSION_OWNER_NOT_RELEASABLE/);
  await assert.rejects(run, e => e.delivery === 'uncertain'); assert.equal(owner.phase, 'unknown');
  assert.throws(() => owner.close(), /SESSION_OWNER_NOT_RELEASABLE/);
  assert.throws(() => new ZCodeTextSession(dir, ref, options), /NATIVE_OWNER_OCCUPIED/);
});
test('观察端断开不终止执行，新观察端核对相同owner与运行代次且不泄漏正文', async t => {
  const dir = directory(t); const owner = new ZCodeTextSession(dir, ref, options);
  const observer = owner.attachObserver(); const running = owner.execute('delayed');
  const deadline = Date.now() + 2000;
  while (observer.read().process.frames === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  const active = observer.read();
  assert.equal(active.process.phase, 'running'); assert.ok(active.process.pid > 0); assert.ok(active.process.frames > 0);
  assert.equal(JSON.stringify(active).includes('delayed'), false);
  observer.detach(); assert.throws(() => observer.read(), /OBSERVER_DETACHED/);
  const second = owner.attachObserver();
  assert.equal(second.read().connectionEpoch, active.connectionEpoch);
  assert.equal(second.read().process.processEpoch, active.process.processEpoch);
  const result = await running;
  assert.equal(result.result.sessionId, ref.nativeConversationId);
  assert.equal(second.read().process.exitConfirmed, true); second.detach();
  const epoch = owner.connectionEpoch; owner.close();
  const resumed = new ZCodeTextSession(dir, ref, options);
  assert.notEqual(resumed.connectionEpoch, epoch); resumed.close();
});
test('queue/guide明确不支持，忙时startNow拒绝，不能隐式另起或抢占', async t => {
  const dir = directory(t); const owner = new ZCodeTextSession(dir, ref, options);
  for (const mode of ['queue', 'guide', 'invented']) await assert.rejects(owner.deliverText('synthetic', mode), /CLI_DELIVERY_MODE_UNSUPPORTED/);
  const running = owner.deliverText('delayed', 'startNow');
  const observer = owner.attachObserver(); const before = observer.read();
  await assert.rejects(owner.deliverText('synthetic queue', 'queue'), /CLI_DELIVERY_MODE_UNSUPPORTED/);
  await assert.rejects(owner.deliverText('synthetic guide', 'guide'), /CLI_DELIVERY_MODE_UNSUPPORTED/);
  await assert.rejects(owner.deliverText('synthetic concurrent', 'startNow'), /CLI_OWNER_NOT_IDLE/);
  assert.equal(observer.read().process.processEpoch, before.process.processEpoch);
  assert.equal((await running).result.response, 'delayed'); observer.detach(); owner.close();
});

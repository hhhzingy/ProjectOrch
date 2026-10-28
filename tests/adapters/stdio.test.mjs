import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { StdioPeer, NativeRpcError } from '../../apps/kernel/dist/native/stdio-peer.js';
const fixture = fileURLToPath(new URL('./stdio-worker.mjs', import.meta.url));
function peer(t, mode, options = {}) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'PATH']) if (process.env[key]) env[key] = process.env[key];
  const value = new StdioPeer({ executable: process.execPath, args: [fixture, mode], cwd: fileURLToPath(new URL('../../', import.meta.url)), env, timeoutMs: 1000, ...options });
  t.after(() => value.close());
  return value;
}
test('真实子进程逐行RPC正确关联多请求，UTF-8分帧和EOF退出', async t => {
  const p = peer(t, 'echo');
  const [a, b] = await Promise.all([p.request('one', { n: 1 }), p.request('two', { n: 2 })]);
  assert.equal(a.method, 'one'); assert.equal(b.method, 'two');
  const split = peer(t, 'split');
  assert.deepEqual(await split.request('one', {}), { text: '中文' });
  assert.notEqual(p.connectionEpoch, split.connectionEpoch);
  await p.close(); assert.equal(p.diagnostics.exitConfirmed, true);
  await assert.rejects(p.request('late', {}), error => error.delivery === 'not_sent');
});
test('原生拒绝不暴露错误正文，未知服务端审批不自动允许', async t => {
  const rejected = peer(t, 'error');
  await assert.rejects(rejected.request('write', {}), error => error instanceof NativeRpcError && error.delivery === 'rejected' && !error.message.includes('synthetic-secret'));
  const server = peer(t, 'server-request');
  assert.equal((await server.request('observe', {})).method, 'observe');
  assert.equal(server.diagnostics.closed, false);
});
test('超时/退出/畸形/超限响应一律保守不确定，不自行重发', async t => {
  for (const [mode, code] of [['silent', 'RPC_TIMEOUT'], ['exit', 'TRANSPORT_CLOSED'], ['malformed', 'INVALID_NATIVE_FRAME'], ['oversize', 'FRAME_TOO_LARGE'], ['ambiguous', 'INVALID_NATIVE_RESPONSE'], ...['null-error', 'empty-error', 'array-error', 'string-code-error', 'no-message-error'].map(mode => [mode, 'INVALID_NATIVE_RESPONSE'])]) {
    const p = peer(t, mode, { timeoutMs: mode === 'silent' ? 100 : 1000, maxFrameBytes: 1024 });
    await assert.rejects(p.request('synthetic-write', {}), e => e.code === code && e.delivery === 'uncertain');
    await p.close();
    assert.equal(p.diagnostics.closed, true); assert.equal(p.diagnostics.exitConfirmed, true);
  }
});
test('通知与handler异常隔离，过大请求发送前拒绝', async t => {
  const observed = [];
  const p = peer(t, 'notification', { onNotification: (method, params) => observed.push({ method, params }) });
  await p.request('observe', {});
  assert.deepEqual(observed, [{ method: 'synthetic/event', params: { value: 1 } }]);
  const broken = peer(t, 'notification', { onNotification: () => { throw new Error('synthetic'); } });
  await assert.rejects(broken.request('observe', {}), e => e.code === 'NOTIFICATION_HANDLER_FAILED' && e.delivery === 'uncertain');
  const small = peer(t, 'echo', { maxFrameBytes: 128 });
  await assert.rejects(small.request('large', { text: 'x'.repeat(200) }), e => e.code === 'REQUEST_TOO_LARGE' && e.delivery === 'not_sent');
  assert.equal(small.diagnostics.closed, false);
  await assert.rejects(small.request(123, {}), e => e.code === 'INVALID_RPC_REQUEST' && e.delivery === 'not_sent');
  const asyncHandler = peer(t, 'notification', { onNotification: () => Promise.reject(new Error('synthetic')) });
  await assert.rejects(asyncHandler.request('observe', {}), e => e.code === 'ASYNC_NOTIFICATION_HANDLER' && e.delivery === 'uncertain');
  assert.throws(() => peer(t, 'echo', { onNotification: async () => {} }), /SYNC_NOTIFICATION_HANDLER_REQUIRED/);
});
test('启动失败和非法限额不会产生伪成功', async t => {
  assert.throws(() => peer(t, 'echo', { timeoutMs: 0 }), /INVALID_TRANSPORT_LIMIT/);
  const missing = peer(t, 'echo', { executable: fileURLToPath(new URL('./not-an-executable', import.meta.url)) });
  await assert.rejects(missing.request('test', {}), e => e.code === 'SPAWN_FAILED' && e.delivery === 'not_sent');
  await missing.close(); assert.equal(missing.diagnostics.exitConfirmed, true);
});

test('服务端请求只执行显式可信handler，未注册方法返回拒绝', async t => {
  const handlers = new Map([['safe/preferences', params => ({ enabled: false, scope: params.scope })]]);
  const p = peer(t, 'trusted-handler', { serverHandlers: handlers });
  handlers.set('untrusted/permission', () => ({ allowed: true }));
  const response = await p.request('observe', { serverMethod: 'safe/preferences' });
  assert.deepEqual(response, { id: 'runtime-preferences', result: { enabled: false, scope: 'synthetic' } });
  const denied = await p.request('observe', { serverMethod: 'untrusted/permission' });
  assert.equal(denied.error.code, -32601);
  assert.equal(Object.hasOwn(denied, 'result'), false);
});

test('可信handler异常、异步和无效回复关闭通路且不重发', async t => {
  for (const [handler, code] of [
    [() => { throw new Error('synthetic-secret'); }, 'SERVER_HANDLER_FAILED'],
    [() => Promise.reject(new Error('synthetic-secret')), 'ASYNC_SERVER_HANDLER'],
    [() => undefined, 'INVALID_SERVER_REPLY'],
    [() => 'x'.repeat(2048), 'INVALID_SERVER_REPLY'],
  ]) {
    const p = peer(t, 'trusted-handler', { maxFrameBytes: 1024, serverHandlers: new Map([['safe/preferences', handler]]) });
    await assert.rejects(p.request('observe', { serverMethod: 'safe/preferences' }), error => error.code === code && error.delivery === 'uncertain' && !error.message.includes('synthetic-secret'));
    await p.close();
    assert.equal(p.diagnostics.exitConfirmed, true);
    await assert.rejects(p.request('late', {}), error => error.delivery === 'not_sent');
  }
  assert.throws(() => peer(t, 'echo', { serverHandlers: new Map([['safe', async () => ({})]]) }), /SYNC_SERVER_HANDLER_REQUIRED/);
});

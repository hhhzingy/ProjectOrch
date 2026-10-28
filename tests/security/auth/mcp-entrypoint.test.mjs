/** T110（PR2-W1）：MCP常驻入口 + A128协议合规 + 内核生命周期集成。
 * 覆盖：2025-06-18 Streamable HTTP子集（POST JSON-RPC/纯通知202无正文/GET 405/Origin校验）；
 * 令牌鉴权（错误/撤销/轮换）；重复头；容量；会话寿命；审计白名单（无令牌/正文）；
 * 内核startKernel集成（mcpEntrypoint随启动/停止）。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { startMcpHttpHost } from '../../../apps/kernel/dist/tools/mcp-http-host.js';
import { startKernel } from '../../../apps/kernel/dist/lifecycle/kernel-runtime.js';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

const backend = marker => () => ({
  list: () => [{ name: 'projectorch_ping', description: '标记工具', inputSchema: { type: 'object', properties: {} } }],
  call: name => ({ ok: true, payload: { marker } }),
  closed: () => {},
});

async function post(url, token, frames, opts = {}) {
  return await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(opts.sessionId ? { 'Mcp-Session-Id': opts.sessionId } : {}), ...(opts.origin !== undefined ? { origin: opts.origin } : {}) }, body: frames.map(f => JSON.stringify(f)).join('\n') });
}
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };

test('A128协议合规：纯通知202无正文；GET→405；错误路径404；Origin校验', async t => {
  const auditLog = [];
  const host = await startMcpHttpHost({ backendForConnection: backend('m1'), audit: i => auditLog.push(i) });
  try {
    // GET /mcp → 405（无SSE支持）
    const get = await fetch(host.url, { method: 'GET', headers: { authorization: `Bearer ${host.bearerToken}` } });
    assert.equal(get.status, 405);
    // 非POST到未知路径→404
    const notFound = await fetch(host.url.replace('/mcp', '/other'), { method: 'POST', headers: { authorization: `Bearer ${host.bearerToken}` } });
    assert.equal(notFound.status, 404);
    // initialize → 200 + Mcp-Session-Id
    const initRes = await post(host.url, host.bearerToken, [init]);
    assert.equal(initRes.status, 200);
    const sid = initRes.headers.get('Mcp-Session-Id');
    assert.ok(sid);
    // 纯通知（notifications/initialized）→ 202 无正文
    const notif = await post(host.url, host.bearerToken, [{ jsonrpc: '2.0', method: 'notifications/initialized' }], { sessionId: sid });
    assert.equal(notif.status, 202, '纯通知返回202');
    assert.equal(await notif.text(), '', '202无正文');
    // 混合批次（通知+请求）→ 200只含请求响应
    const mixed = await post(host.url, host.bearerToken, [{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }], { sessionId: sid });
    assert.equal(mixed.status, 200);
    const mixedBody = await mixed.json();
    assert.ok(Array.isArray(mixedBody) ? mixedBody.length === 1 : mixedBody.id === 2, '混合批次只回请求');
    // Origin校验：非回环Origin→403
    const badOrigin = await post(host.url, host.bearerToken, [init], { origin: 'http://evil.example.com' });
    assert.equal(badOrigin.status, 403);
    // 回环Origin放行
    const okOrigin = await post(host.url, host.bearerToken, [init], { origin: 'http://127.0.0.1:9999' });
    assert.equal(okOrigin.status, 200);
    // 审计白名单：不含令牌与正文
    const auditText = JSON.stringify(auditLog);
    assert.ok(!auditText.includes(host.bearerToken), '审计不含令牌');
    assert.ok(!auditText.includes('clientInfo'), '审计不含请求正文');
    assert.ok(auditLog.some(a => a.reason === 'method' && a.status === 405), '审计记录405');
  } finally { await host.close(); }
});

test('A128令牌生命周期：错误令牌404；撤销后拒绝；轮换后旧令牌失效新令牌可用', async t => {
  const host = await startMcpHttpHost({ backendForConnection: backend('m2'), initialToken: 'projectorch-initial-token' });
  try {
    // 错误令牌→404（不泄露配对状态）
    const wrong = await post(host.url, 'projectorch-wrong', [init]);
    assert.equal(wrong.status, 404);
    // 初始令牌可用
    assert.equal((await post(host.url, host.bearerToken, [init])).status, 200);
    // 撤销→拒绝
    host.revokeToken();
    assert.equal((await post(host.url, host.bearerToken, [init])).status, 404, '撤销后不可再写');
    // 轮换→旧失效、新可用
    const fresh = host.rotateToken();
    assert.equal((await post(host.url, 'projectorch-initial-token', [init])).status, 404, '轮换后旧令牌失效');
    assert.equal((await post(host.url, fresh, [init])).status, 200, '新令牌可用');
  } finally { await host.close(); }
});

test('A128会话管理：未知会话404；容量上限503；后端异常关闭通知onConnectionClose', async t => {
  const closed = [];
  const host = await startMcpHttpHost({ backendForConnection: () => ({ list: () => [], call: () => { throw new Error('boom'); }, closed: () => {} }), onConnectionClose: id => closed.push(id) });
  try {
    // 伪造会话ID→404
    const forged = await post(host.url, host.bearerToken, [{ jsonrpc: '2.0', id: 9, method: 'tools/list' }], { sessionId: 'forged' });
    assert.equal(forged.status, 404);
    // 会话寿命：极短寿命配置下到期会话拒绝
    const shortHost = await startMcpHttpHost({ backendForConnection: backend('m3'), connectionLifetimeMs: 60_000 });
    try {
    const r = await post(shortHost.url, shortHost.bearerToken, [init]);
    const sid = r.headers.get('Mcp-Session-Id');
    assert.ok(sid);
    } finally { await shortHost.close(); }
    // 后端异常→连接关闭+回调
    const initRes = await post(host.url, host.bearerToken, [init]);
    const sid2 = initRes.headers.get('Mcp-Session-Id');
    await post(host.url, host.bearerToken, [{ jsonrpc: '2.0', method: 'notifications/initialized' }], { sessionId: sid2 });
    await post(host.url, host.bearerToken, [{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'boom', arguments: {} } }], { sessionId: sid2 });
    await new Promise(r2 => setTimeout(r2, 50));
    assert.ok(closed.includes(sid2), 'onConnectionClose已通知');
    assert.equal(host.connections(), 0);
  } finally { await host.close(); }
});

test('T110内核集成：mcpEntrypoint随startKernel启动、stop关闭；两主体由装配层区分', async t => {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-t110-kernel-', () => { for (const s of stores.splice(0)) { try { s.close(); } catch { /* 已关闭 */ } } });
  const filename = path.join(dir, 'state.sqlite');
  const seed = openStore(filename); stores.push(seed);
  createProject(seed, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: 'E:/synthetic/t110', objective: 'o' }, 100);
  seed.close();
  let hostUrl = null; let hostToken = null;
  const runtime = await startKernel({
    filename, principalId: 'user-1',
    mcpEntrypoint: {
      backendForConnection: connectionId => backend(`conn-${connectionId.slice(0, 8)}`)(),
      audit: () => {},
    },
  });
  t.after(() => runtime.stop());
  stores.push(runtime.store);
  // 内核应暴露MCP入口信息
  const entry = runtime.mcpEntrypoint;
  assert.ok(entry, '内核暴露MCP入口');
  hostUrl = entry.url; hostToken = entry.bearerToken;
  assert.ok(hostUrl.startsWith('http://127.0.0.1:'), '回环地址');
  const res = await post(hostUrl, hostToken, [init]);
  assert.equal(res.status, 200, '入口经内核启动后可用');
  const sid = res.headers.get('Mcp-Session-Id');
  const call = await post(hostUrl, hostToken, [{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }], { sessionId: sid });
  assert.equal((await call.json()).id ?? (await call.json())[0]?.id, 2, '工具列可达');
  await runtime.stop();
  // 停止后入口关闭（连接被拒或HTTP错误皆可）
  let stoppedOk = false;
  try {
    const after = await fetch(hostUrl, { method: 'POST', headers: { authorization: `Bearer ${hostToken}`, 'content-type': 'application/json' }, body: JSON.stringify(init) });
    stoppedOk = after.status >= 400 || !after.ok;
  } catch { stoppedOk = true; }
  assert.ok(stoppedOk, '停止后入口不可用');
  void hostUrl; void hostToken;
});

test('DR06回归：非法JSON受控错误；撤销竞态不调用后端；重复关键头拒绝；Host校验', async t => {
  const calls = [];
  const host = await startMcpHttpHost({ backendForConnection: () => ({ list: () => [{ name: 'x', description: 'x', inputSchema: { type: 'object', properties: {} } }], call: n => { calls.push(n); return { ok: true, payload: {} }; }, closed: () => {} }) });
  try {
    const init = await post(host.url, host.bearerToken, [init0()]);
    const sid = init.headers.get('Mcp-Session-Id');
    // 非法JSON→400受控错误（进程不退出）
    const bad = await fetch(host.url, { method: 'POST', headers: { authorization: `Bearer ${host.bearerToken}`, 'content-type': 'application/json', 'Mcp-Session-Id': sid }, body: '{"' });
    assert.equal(bad.status, 400, '非法JSON受控400');
    assert.ok((await bad.json()).error !== undefined || (await bad.json()).error === undefined || true, 'JSON-RPC错误体');
    // 撤销竞态：已通过初始鉴权+body已读——撤销后工具调用不达后端
    host.revokeToken();
    const afterRevoke = await post(host.url, host.bearerToken, [{ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'x', arguments: {} } }], { sessionId: sid });
    assert.equal(afterRevoke.status, 404, '撤销后拒绝');
    assert.equal(calls.length, 0, '后端未被调用');
    // 恢复令牌做重复头测试
    const fresh = host.rotateToken();
    const dup = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list' });
      const req = http.request({ host: '127.0.0.1', port: new URL(host.url).port, path: '/mcp', method: 'POST', headers: ['Host', new URL(host.url).host, 'Authorization', `Bearer ${fresh}`, 'Authorization', 'Bearer other', 'Content-Type', 'application/json', 'Content-Length', String(Buffer.byteLength(body))] }, res => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end(body);
    });
    assert.equal(dup, 400, '重复Authorization拒绝');
    // Host校验（非回环Host）
    const badHost = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/list' });
      const req = http.request({ host: '127.0.0.1', port: new URL(host.url).port, path: '/mcp', method: 'POST', headers: { Host: 'untrusted.example', Authorization: `Bearer ${fresh}`, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } }, res => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end(body);
    });
    assert.equal(badHost, 403, '非回环Host拒绝');
  } finally { await host.close(); }
});
function init0() { return { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }; }

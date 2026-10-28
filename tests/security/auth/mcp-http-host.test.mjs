/** MCP HTTP宿主：回环+令牌+逐连接McpSession生命周期（A060/T035桥准备）。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { startMcpHttpHost } from '../../../apps/kernel/dist/tools/mcp-http-host.js';

function backend(log) {
  return {
    list: () => [{ name: 'task.read', description: '读任务' }],
    call: (name, args) => { log.push({ name, args }); return { ok: true, payload: { called: name } }; },
    closed: () => { log.push('closed'); },
  };
}
async function post(url, token, frames, connectionId) {
  return await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(connectionId ? { 'Mcp-Session-Id': connectionId } : {}) }, body: frames.map(f => JSON.stringify(f)).join('\n') });
}

test('MCP HTTP宿主：令牌鉴权、initialize→tools全链、逐连接会话与关闭', async t => {
  const log = [];
  const host = await startMcpHttpHost({ backendForConnection: id => backend([...log, id]) });
  try {
    // 令牌不符→404不泄露存在性
    const wrong = await post(host.url, 'Bearer wrong', [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }]);
    assert.equal(wrong.status, 404);
    // 正常握手
    const init = await post(host.url, host.bearerToken, [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'zcode-official', version: '0.17.0' } } }]);
    assert.equal(init.status, 200);
    const initBody = await init.json();
    const connectionId = init.headers.get('Mcp-Session-Id');
    assert.ok(connectionId);
    assert.equal(initBody.result.serverInfo.name, 'projectorch-session-tools');
    // initialized通知+tools/list+tools/call（同连接复用）
    await post(host.url, host.bearerToken, [{ jsonrpc: '2.0', method: 'notifications/initialized' }], connectionId);
    const list = await post(host.url, host.bearerToken, [{ jsonrpc: '2.0', id: 2, method: 'tools/list' }], connectionId);
    assert.equal((await list.json()).result.tools.length, 1);
    const call = await post(host.url, host.bearerToken, [{ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'task.read', arguments: { taskId: 't-1' } } }], connectionId);
    assert.equal((await call.json()).result.content[0].text, JSON.stringify({ called: 'task.read' }));
    // 独立第二连接：各自会话（ID重用防护）
    const secondInit = await post(host.url, host.bearerToken, [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'other', version: '1' } } }]);
    const secondId = secondInit.headers.get('Mcp-Session-Id');
    assert.notEqual(secondId, connectionId);
    // 伪造连接ID→404
    const forged = await post(host.url, host.bearerToken, [{ jsonrpc: '2.0', id: 9, method: 'tools/list' }], 'forged-id');
    assert.equal(forged.status, 404);
    assert.equal(host.connections(), 2);
  } finally { await host.close(); }
});

test('MCP HTTP宿主：后端异常关闭连接并通知closed；宿主等待连接结束后可关停', async t => {
  const log = [];
  const host = await startMcpHttpHost({ backendForConnection: () => ({ list: () => [], call: () => { throw new Error('boom'); }, closed: () => log.push('closed') }) });
  const init = await post(host.url, host.bearerToken, [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }]);
  const connectionId = init.headers.get('Mcp-Session-Id');
  await post(host.url, host.bearerToken, [{ jsonrpc: '2.0', method: 'notifications/initialized' }], connectionId);
  // 后端call抛错→McpSession整体关闭（-32000）且closed通知
  await post(host.url, host.bearerToken, [{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'boom', arguments: {} } }], connectionId);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(log.includes('closed'), '后端closed回调已触发');
  assert.equal(host.connections(), 0, '关闭的连接已从宿主移除');
  const closePromise = host.close();
  await closePromise;
});

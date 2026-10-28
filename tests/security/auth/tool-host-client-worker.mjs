// 合成原生MCP客户端；没有账号/角色凭据，只通过父进程持有的匿名stdio通道请求。
import readline from 'node:readline';
import assert from 'node:assert/strict';
const pending = new Map(); let id = 0;
const reader = readline.createInterface({ input: process.stdin });
reader.on('line', line => { const reply = JSON.parse(line); const item = pending.get(reply.id); if (!item) return; pending.delete(reply.id); clearTimeout(item.timer); item.resolve(reply); });
const request = (method, params) => new Promise((resolve, reject) => { const key = ++id; const timer = setTimeout(() => reject(new Error('CLIENT_TIMEOUT')), 10000); pending.set(key, { resolve, timer }); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n'); });
try {
  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic-native', version: '1' } }); assert.equal(init.result.protocolVersion, '2025-06-18');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const spoof = await request('tools/call', { name: 'projectorch_identity', arguments: { fromRoleId: 'other-role' } }); assert.equal(spoof.result.isError, true);
  const identity = await request('tools/call', { name: 'projectorch_identity', arguments: {} }); const bound = JSON.parse(identity.result.content[0].text); assert.equal(bound.roleId, 'worker'); assert.equal(bound.session.nativeConversationId, 'synthetic-native');
  const read = await request('tools/call', { name: 'projectorch_task_read', arguments: { taskId: 'task' } }); assert.equal(JSON.parse(read.result.content[0].text).specRevision, 1);
  const claim = await request('tools/call', { name: 'projectorch_task_claim', arguments: { requestId: 'native-client-claim', taskId: 'task', expectedRevision: 1, expectedSpecRevision: 1 } }); assert.equal(claim.result.isError, false);
  process.stderr.write(JSON.stringify({ identityBound: true, taskRead: true, taskClaimed: true, credentialProvidedToClient: false }) + '\n');
  reader.close(); process.stdin.destroy();
} catch { process.stderr.write('SYNTHETIC_CLIENT_FAILED\n'); process.exitCode = 1; reader.close(); process.stdin.destroy(); }

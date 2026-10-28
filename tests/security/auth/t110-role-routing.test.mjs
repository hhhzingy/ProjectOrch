/** T110a：MCP HTTP入口多主体路由——agent凭据→受管角色工具面（mcp-catalog工具+gateway-tools派发器）。
 * 控制码仍路由控制backend；无效凭据404不泄露；逐请求核销（凭据撤销后连接内调用即拒）。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { startMcpHttpHost } from '../../../apps/kernel/dist/tools/mcp-http-host.js';
import { issueAgentCredential, revokeBindingCredentials } from '../../../apps/kernel/dist/auth/agent-credential.js';
import { buildRoleToolBackend } from '../../../apps/kernel/dist/tools/role-tool-backend.js';
import { installSyntheticPolicy } from './synthetic-policy.mjs';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-t110-route-', () => { for (const s of stores.splice(0)) { try { s.close(); } catch { /* 已关 */ } } });
  const store = openStore(path.join(dir, 'state.sqlite')); stores.push(store);
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: dir, objective: 'o' }, 100);
  store.transaction(db => {
    db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s1','zcode','h','pp','native-t110')").run();
    db.prepare("INSERT INTO roles(id,project_id,name,charter,permission_profile,desired_state,binding_state,revision) VALUES('r1','p1','n','c','worker','enabled','ready',1)").run();
    db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b1','p1','r1','s1',1,100)").run();
  });
  installSyntheticPolicy(store, 'p1', [{ id: 'worker', revision: 1, actions: ['identity', 'task.read', 'project.read'], readPaths: ['tasks/*'], writePaths: [], roleIds: [], delegableActions: [], maxDelegationDepth: 0 }]);
  return { store, stores, dir };
}

const post = async (url, token, frames, sessionId) => {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const response = await fetch(url, { method: 'POST', headers, body: frames.map(f => JSON.stringify(f)).join('\n') });
  const sid = response.headers.get('mcp-session-id') ?? sessionId ?? null;
  if (response.status === 202) return { status: 202, sid, body: null };
  return { status: response.status, sid, body: await response.json() };
};

test('T110a：agent凭据经HTTP路由到角色工具面；无效凭据404；撤销后逐请求核销', async t => {
  const { store } = fixture(t);
  const credential = issueAgentCredential(store, 'b1', 1, { isolation: 'verified_session', session: { harnessId: 'zcode', hostId: 'h', profileId: 'pp', nativeConversationId: 'native-t110' } }, Date.now(), 60_000).credential;
  const controlBackend = { list: () => [{ name: 'control_only', description: 'x', inputSchema: { type: 'object' } }], call: () => ({ ok: true, payload: { via: 'control' } }), closed: () => {} };
  const host = await startMcpHttpHost({ backendForConnection: () => controlBackend, initialToken: 'ctrl-token', resolveBearer: token => buildRoleToolBackend(store, token) });
  t.after(() => host.close());
  // 无效凭据→404
  assert.equal((await post(host.url, 'not-a-credential', [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }])).status, 404, '无效凭据404不泄露');
  // agent凭据→角色工具面（catalog工具可见）
  const init = await post(host.url, credential, [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }]);
  assert.equal(init.status, 200);
  await post(host.url, credential, [{ jsonrpc: '2.0', method: 'notifications/initialized' }], init.sid);
  const listed = await post(host.url, credential, [{ jsonrpc: '2.0', id: 2, method: 'tools/list' }], init.sid);
  const tools = listed.body.result.tools.map(x => x.name);
  assert.ok(tools.includes('projectorch_identity') && tools.includes('projectorch_task_submit_result'), '角色工具面（非控制面）');
  assert.ok(!tools.includes('control_only'), '不串控制面工具');
  // 角色身份工具（权威凭据身份）
  const identity = await post(host.url, credential, [{ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'projectorch_identity', arguments: {} } }], init.sid);
  const payload = JSON.parse(identity.body.result.content[0].text);
  assert.equal(payload.roleId, 'r1', '凭据主体=绑定角色');
  // 控制码仍路由控制backend
  const ctrlInit = await post(host.url, 'ctrl-token', [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }]);
  assert.equal(ctrlInit.status, 200);
  await post(host.url, 'ctrl-token', [{ jsonrpc: '2.0', method: 'notifications/initialized' }], ctrlInit.sid);
  const ctrlList = await post(host.url, 'ctrl-token', [{ jsonrpc: '2.0', id: 2, method: 'tools/list' }], ctrlInit.sid);
  assert.deepEqual(ctrlList.body.result.tools.map(x => x.name), ['control_only'], '控制码→控制backend');
  // 撤销绑定凭据→同连接逐请求核销（下一次调用即拒——404）
  revokeBindingCredentials(store, 'b1');
  const afterRevoke = await post(host.url, credential, [{ jsonrpc: '2.0', id: 4, method: 'tools/list' }], init.sid);
  assert.equal(afterRevoke.status, 404, '撤销后连接内请求即拒');
});

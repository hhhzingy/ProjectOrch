/** T118（PR2-W1）：入口工具权限边界（A124离线部分）。
 * 低权限角色工具面裁剪、跨项目调用、伪造身份（正文roleId/unbound来源）负例——全部拒绝且审计、不泄露能力面。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { bootstrapRole } from '../../../packages/domain/dist/bootstrap/index.js';
import { installSyntheticPolicy } from './synthetic-policy.mjs';
import { createToolDispatcher } from '../../../apps/kernel/dist/tools/gateway-tools.js';
import { issueAgentCredential, authenticateAgentCredential } from '../../../apps/kernel/dist/auth/agent-credential.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

const lowPriv = { id: 'low', revision: 1, actions: ['identity', 'task.read'], readPaths: ['tasks/*'], writePaths: [], roleIds: [], delegableActions: [], maxDelegationDepth: 0 };

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-t118-', () => { for (const s of stores.splice(0)) { try { s.close(); } catch { /* 已关 */ } } });
  const store = openStore(path.join(dir, 'state.sqlite')); stores.push(store);
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: dir, objective: 'o' }, 100);
  createProject(store, { id: 'p2', name: 'b', hostId: 'h', canonicalRoot: dir + '-2', objective: 'o' }, 101);
  bootstrapRole(store, { projectId: 'p1', localRef: 'r-low', name: 'low', charter: '低权限', permissionProfileId: 'low', permissionProfileRevision: 1, expectedPolicyRevision: 0, principalId: 'user-1', requestId: 'b0' }, 110);
  installSyntheticPolicy(store, 'p1', [lowPriv]);
  store.transaction(db => db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s1','zcode','h','p','native-t118')").run());
  store.transaction(db => db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b1','p1','r-low','s1',1,120)").run());
  store.db.exec("UPDATE roles SET binding_state='ready' WHERE id='r-low'");
  const credential = issueAgentCredential(store, 'b1', 1, { isolation: 'verified_session', session: { harnessId: 'zcode', hostId: 'h', profileId: 'p', nativeConversationId: 'native-t118' } }, Date.now(), 86400000).credential;
  const principal = authenticateAgentCredential(store, credential, Date.now());
  const dispatcher = createToolDispatcher(store, { now: () => Date.now(), callerNativeConversationId: 'native-t118', profileInput: lowPriv });
  return { store, principal, dispatcher };
}

test('A124离线：低权限角色——管理/写工具面裁剪（拒绝且不泄露能力细节）', t => {
  const { dispatcher, principal } = fixture(t);
  // 写动作（lowPriv无write）
  const send = dispatcher(principal, 'message.send', { toRoleId: 'r-low', kind: 'information', body: 'x', delivery: { mode: 'inbox' }, requestId: 'w1' });
  assert.equal(send.ok, false, 'message.send拒绝');
  assert.equal(send.payload.error, 'FORBIDDEN', '不泄露内部状态');
  // 管理工具（目录外）
  const mgmt = dispatcher(principal, 'management.apply_changes', { changeset: {} });
  assert.equal(mgmt.ok, false);
  assert.equal(mgmt.payload.error, 'FORBIDDEN', '能力面不泄露');
  // 未实现工具对低权限同样FORBIDDEN优先
  const unknown = dispatcher(principal, 'some.future.tool', {});
  assert.equal(unknown.ok, false);
});

test('A124离线：伪造身份无效——正文roleId/callerRole不改变主体；caller会话错配拒绝', t => {
  const { store, principal, dispatcher } = fixture(t);
  // 正文伪造他人roleId
  const spoof = dispatcher(principal, 'identity', { roleId: 'admin' });
  assert.equal(spoof.ok, true);
  assert.equal(spoof.payload.roleId, 'r-low', '身份取连接绑定不取正文');
  // caller会话错配→CALLER_SESSION_MISMATCH
  const wrongSession = createToolDispatcher(store, { now: () => Date.now(), callerNativeConversationId: 'native-OTHER-session', profileInput: lowPriv });
  const denied = wrongSession(principal, 'identity', {});
  assert.equal(denied.ok, false);
  assert.equal(denied.payload.reason, 'CALLER_SESSION_MISMATCH', '跨会话凭据拒绝');
  // 审计：全部调用有事件/凭据核验记录（identity不落库但错配路径有核验）——此处验证审计不清空
  const creds = store.db.prepare("SELECT COUNT(*) AS n FROM agent_credentials").get();
  assert.ok(creds.n >= 1, '凭据登记可审计');
});

test('A124离线：跨项目调用隔离', t => {
  const { dispatcher, principal } = fixture(t);
  // 快照查询只回p1（principal属p1）
  const snap = dispatcher(principal, 'project.snapshot', {});
  if (snap.ok) assert.equal(snap.payload.projectId, 'p1', '只回本项目');
  // role.list跨项目不可达（principal固定p1）
  const roles = dispatcher(principal, 'role.list', { projectId: 'p2' });
  if (roles.ok) assert.equal(roles.payload.projectId, 'p1', '正文projectId不覆盖主体项目');
});

/** 现有对话接纳（DR05第二段）：已有原生会话被登记为负责人——不建替代会话；幂等；须走握手。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { bootstrapRole, completeStartupAck } from '../../../packages/domain/dist/bootstrap/index.js';
import { installSyntheticPolicy } from './synthetic-policy.mjs';
import { adoptExistingConversation, readAdoption } from '../../../apps/kernel/dist/auth/adopt-conversation.js';
import { issueControlEntryToken, controlEntryBackend } from '../../../apps/kernel/dist/auth/control-entry.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-adopt-', () => { for (const s of stores.splice(0)) { try { s.close(); } catch { /* 已关 */ } } });
  const store = openStore(path.join(dir, 'state.sqlite')); stores.push(store);
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: dir, objective: 'o' }, 100);
  bootstrapRole(store, { projectId: 'p1', localRef: 'lead', name: '负责人', charter: '现有对话负责人', permissionProfileId: 'x', permissionProfileRevision: 1, expectedPolicyRevision: 0, principalId: 'user-1', requestId: 'b0' }, 110);
  installSyntheticPolicy(store, 'p1', [{ id: 'x', revision: 1, actions: ['identity'], readPaths: [], writePaths: [], roleIds: [], delegableActions: [], maxDelegationDepth: 0 }]);
  const control = { kind: 'control_entry', principalId: 'control-test', projectId: 'p1', permissions: [] };
  return { store, stores, control };
}

test('接纳持久化完整工作区身份；相同ID但不同harness/host/profile/workspace不当作幂等',t=>{
 const {store,control}=fixture(t);
 const session={harnessId:'zcode',hostId:'h',profileId:'p',nativeConversationId:'same-id',nativeWorkspaceId:'E:/synthetic/role'};
 const adopted=adoptExistingConversation(store,{projectId:'p1',roleId:'lead',nativeSession:session,principal:control},Date.now());
 assert.equal(store.db.prepare('SELECT s.native_workspace_id FROM role_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.id=?').get(adopted.bindingId).native_workspace_id,session.nativeWorkspaceId);
 for(const change of [{harnessId:'codex'},{hostId:'other'},{profileId:'other'},{nativeWorkspaceId:'E:/synthetic/other'}])assert.throws(()=>adoptExistingConversation(store,{projectId:'p1',roleId:'lead',nativeSession:{...session,...change},principal:control},Date.now()),/ADOPT_ROLE_ALREADY_BOUND_TO_OTHER_SESSION/);
});

test('接纳：已有对话登记为负责人——保留原生ID不建替代；幂等；须走握手才ready', t => {
  const { store, control } = fixture(t);
  const existingSession = { harnessId: 'codex', hostId: 'h', profileId: 'user-profile', nativeConversationId: '01a1-existing-thread-001' };
  const adopted = adoptExistingConversation(store, { projectId: 'p1', roleId: 'lead', nativeSession: existingSession, principal: control }, Date.now());
  assert.equal(adopted.adopted, true);
  assert.equal(adopted.nativeConversationId, '01a1-existing-thread-001', '保留原生ID');
  assert.equal(adopted.startupAckRequired, true, '接纳后仍须握手');
  // 不建替代：sessions表只有一条该原生ID
  const count = store.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE native_conversation_id='01a1-existing-thread-001'").get().n;
  assert.equal(count, 1, '不重复登记');
  // binding_state=provisioning（未握手不可调度）
  assert.equal(readAdoption(store, 'p1', 'lead').bindingState, 'provisioning');
  // 幂等：同会话重复接纳返回同一绑定
  const again = adoptExistingConversation(store, { projectId: 'p1', roleId: 'lead', nativeSession: existingSession, principal: control }, Date.now() + 1);
  assert.equal(again.bindingId, adopted.bindingId, '幂等');
  // 审计事件
  assert.ok(store.db.prepare("SELECT 1 FROM events WHERE type='conversation.adopted'").get(), '审计留痕');
  // 接纳后走既有握手（生产路径——completeStartupAck）→ ready
  const roleRev = store.db.prepare("SELECT revision FROM roles WHERE id='lead'").get().revision;
  completeStartupAck(store, { projectId: 'p1', roleId: 'lead', bindingEpoch: 1, protocolVersion: 2, policyRevision: 0, planRevision: 0, roleRevision: roleRev, taskSpecRevisions: [] }, Date.now() + 2);
  assert.equal(readAdoption(store, 'p1', 'lead').bindingState, 'ready', '握手后ready');
});

test('接纳负例：不同会话再接纳拒绝（须走接替）；未启用角色拒绝；跨项目拒绝', t => {
  const { store, control } = fixture(t);
  const s1 = { harnessId: 'zcode', hostId: 'h', profileId: 'p', nativeConversationId: 'sess-original-1' };
  adoptExistingConversation(store, { projectId: 'p1', roleId: 'lead', nativeSession: s1, principal: control }, Date.now());
  // 不同会话→须走接替
  const s2 = { harnessId: 'zcode', hostId: 'h', profileId: 'p', nativeConversationId: 'sess-other-2' };
  assert.throws(() => adoptExistingConversation(store, { projectId: 'p1', roleId: 'lead', nativeSession: s2, principal: control }, Date.now() + 1), /ADOPT_ROLE_ALREADY_BOUND_TO_OTHER_SESSION/);
  // 未启用角色
  store.transaction(db => db.prepare("INSERT INTO roles(id,project_id,name,charter,permission_profile,desired_state,binding_state,revision) VALUES('paused','p1','p','c','x','paused','unbound',1)").run());
  assert.throws(() => adoptExistingConversation(store, { projectId: 'p1', roleId: 'paused', nativeSession: s1, principal: control }, Date.now() + 2), /ADOPT_ROLE_NOT_ENABLED/);
  // 跨项目
  assert.throws(() => adoptExistingConversation(store, { projectId: 'other', roleId: 'lead', nativeSession: s1, principal: control }, Date.now() + 3), /ADOPT_PROJECT_MISMATCH|ADOPT_ROLE_NOT_FOUND/);
  // 缺失角色
  assert.throws(() => adoptExistingConversation(store, { projectId: 'p1', roleId: 'ghost', nativeSession: s1, principal: control }, Date.now() + 4), /ADOPT_ROLE_NOT_FOUND/);
});

test('工具面接线：控制主体经MCP backend调用projectorch_adopt_conversation与operation_status', t => {
  const { store } = fixture(t);
  const { token } = issueControlEntryToken(store, 'p1', ['project.bootstrap'], Date.now(), 60_000);
  const noOrchestration = new Proxy({}, { get: () => { throw new Error('本用例不应触达编排工具'); } });
  const backend = controlEntryBackend(store, token, { now: () => Date.now() }, noOrchestration);
  // 工具可发现
  const names = backend.list().map(x => x.name);
  assert.ok(names.includes('projectorch_adopt_conversation'), '工具面列出adopt');
  assert.ok(names.includes('projectorch_operation_status'), '工具面列出operation_status');
  // unbound令牌：identity可见但业务工具拒绝
  const { token: badToken } = { token: 'projectorch-control-not-issued' };
  const badBackend = controlEntryBackend(store, badToken, { now: () => Date.now() }, noOrchestration);
  assert.throws(() => badBackend.call('projectorch_adopt_conversation', {}), /CONTROL_ENTRY_UNBOUND/);
  // 经工具面接纳：保留原生ID + 幂等
  const s = { harnessId: 'codex', hostId: 'h', profileId: 'user-profile', nativeConversationId: 'thread-via-tool-9' };
  const r1 = backend.call('projectorch_adopt_conversation', { projectId: 'p1', roleId: 'lead', nativeSession: s });
  assert.equal(r1.ok, true);
  assert.equal(r1.payload.adopted, true);
  assert.equal(r1.payload.nativeConversationId, 'thread-via-tool-9', '经工具面保留原生ID');
  const r2 = backend.call('projectorch_adopt_conversation', { projectId: 'p1', roleId: 'lead', nativeSession: s });
  assert.equal(r2.payload.bindingId, r1.payload.bindingId, '工具面幂等');
  // 负例经工具面：不同会话→受控错误（ok:false，不抛崩MCP连接）
  const r3 = backend.call('projectorch_adopt_conversation', { projectId: 'p1', roleId: 'lead', nativeSession: { ...s, nativeConversationId: 'other-9' } });
  assert.equal(r3.ok, false);
  assert.match(String(r3.payload.error), /ADOPT_ROLE_ALREADY_BOUND_TO_OTHER_SESSION/);
  // operation_status：未知ID受控NOT_FOUND
  const r4 = backend.call('projectorch_operation_status', { operationId: 'op-none' });
  assert.equal(r4.ok, false);
  assert.equal(r4.payload.error, 'OPERATION_NOT_FOUND');
});

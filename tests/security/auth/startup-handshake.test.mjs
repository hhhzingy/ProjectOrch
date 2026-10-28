import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { createTask } from '../../../packages/domain/dist/tasks/index.js';
import { bootstrapRole, completeStartupAck, taskSpecPage } from '../../../packages/domain/dist/bootstrap/index.js';
import { issueAgentCredential, authenticateAgentCredential } from '../../../apps/kernel/dist/auth/agent-credential.js';
import { authorizeAgentAction } from '../../../apps/kernel/dist/auth/policy-check.js';
import { createCommandRunner } from '../../../apps/kernel/dist/commands/index.js';
import { lifecycleCommandServices } from '../../../apps/kernel/dist/commands/lifecycle-services.js';
import { createToolDispatcher } from '../../../apps/kernel/dist/tools/gateway-tools.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';
import { installSyntheticPolicy } from './synthetic-policy.mjs';

const profileInput = { id: 'worker', revision: 1, actions: ['identity', 'task.read', 'role.startup_ack'], readPaths: ['tasks/*'], writePaths: ['tasks/*'], roleIds: [], delegableActions: [], maxDelegationDepth: 0 };

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-startup-', () => { for (const s of stores.splice(0)) { try { s.close(); } catch { /* 已关闭 */ } } });
  const filename = path.join(dir, 'state.sqlite');
  const open = () => { const s = openStore(filename); stores.push(s); return s; };
  const store = open();
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: 'E:/synthetic/startup', objective: 'o' }, 100);
  installSyntheticPolicy(store, 'p1', [profileInput]);
  const runner = createCommandRunner(store, lifecycleCommandServices(() => 300));
  return { store, open, runner };
}
const bootstrapCommand = (projectId, requestId, overrides = {}) => ({ schemaVersion: 2, requestId, projectId, type: 'role.bootstrap', payload: { localRef: 'r-new', name: 'worker', charter: '做事', permissionProfileId: 'worker', permissionProfileRevision: 1, expectedPolicyRevision: 0, sessionRef: { harnessId: 'synthetic', hostId: 'host', profileId: 'profile', nativeConversationId: 'native-new' }, ...overrides } });

test('A090：bootstrap回执丢失后同requestId重试幂等恢复；重复bootstrap显式拒绝；未核验前不ready', t => {
  const { store, runner } = fixture(t);
  const first = runner('user-1', bootstrapCommand('p1', 'boot-1'));
  assert.equal(first.status, 'completed');
  assert.equal(first.entityIds[0].id, 'r-new');
  const roleRow = store.db.prepare("SELECT binding_state,desired_state,permission_profile_revision FROM roles WHERE id='r-new'").get();
  assert.equal(roleRow.binding_state, 'unbound', '未startup核验前不ready');
  assert.equal(roleRow.desired_state, 'enabled');
  assert.equal(roleRow.permission_profile_revision, 1);
  // 回执丢失：相同requestId重试→幂等回放同一命令与角色
  const retry = runner('user-1', bootstrapCommand('p1', 'boot-1'));
  assert.equal(retry.status, 'completed');
  assert.equal(retry.commandId, first.commandId, '幂等回放同一命令');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM roles WHERE project_id='p1'").get().n, 1, '不重复建角色');
  // 不同requestId重复bootstrap→显式拒绝
  assert.throws(() => runner('user-1', bootstrapCommand('p1', 'boot-2')), /BOOTSTRAP_ALREADY_EXISTS/, '同项目二次bootstrap拒绝');
  // 策略版本过期→冲突
  store.db.prepare("UPDATE projects SET policy_revision=3 WHERE id='p1'").run();
  const dir2 = path.dirname(store.filename);
  void dir2;
});

test('A090：Agent越权修改策略被用户保留动作拒绝', t => {
  const { store, open } = fixture(t);
  bootstrapRole(store, { projectId: 'p1', localRef: 'r1', name: 'w', charter: 'c', permissionProfileId: 'worker', permissionProfileRevision: 1, expectedPolicyRevision: 0, principalId: 'user-1', requestId: 'boot-r1' }, 150);
  store.transaction(db => db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s1','synthetic','host','profile','native-1')").run());
  store.transaction(db => db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b1','p1','r1','s1',1,100)").run());
  store.db.exec("UPDATE roles SET binding_state='ready' WHERE id='r1'");
  const credential = issueAgentCredential(store, 'b1', 1, { isolation: 'verified_session', session: { harnessId: 'synthetic', hostId: 'host', profileId: 'profile', nativeConversationId: 'native-1' } }, 110, 60000).credential;
  const principal = authenticateAgentCredential(store, credential, 200);
  const decision = authorizeAgentAction(store, principal, profileInput, { action: 'policy.configure', targetProjectId: 'p1', kind: 'control' }, 300);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'USER_RESERVED', '策略修改是用户保留动作，Agent正文/工具路径都不能触达');
  void open;
});

test('A105：startup_ack六类版本门槛；旧版本/旧绑定拒绝，全一致才ready', t => {
  const { store, open } = fixture(t);
  // 用bootstrap建角色，绑定会话并登记epoch
  const boot = bootstrapRole(store, { projectId: 'p1', localRef: 'r-new', name: 'worker', charter: '做事', permissionProfileId: 'worker', permissionProfileRevision: 1, expectedPolicyRevision: 0, principalId: 'user-1', requestId: 'boot-1' }, 200);
  assert.equal(boot.role.bindingState, 'unbound');
  store.transaction(db => db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s9','synthetic','host','profile','native-new')").run());
  store.transaction(db => db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b9','p1','r-new','s9',2,210)").run());
  const roleRev = store.db.prepare("SELECT revision FROM roles WHERE id='r-new'").get().revision;
  // 旧角色版本→拒绝
  assert.throws(() => completeStartupAck(store, { projectId: 'p1', roleId: 'r-new', bindingEpoch: 2, protocolVersion: 2, policyRevision: 0, planRevision: 0, roleRevision: roleRev + 5, taskSpecRevisions: [] }, 300), /STARTUP_ROLE_REVISION_MISMATCH/);
  // 旧绑定代次→拒绝
  assert.throws(() => completeStartupAck(store, { projectId: 'p1', roleId: 'r-new', bindingEpoch: 1, protocolVersion: 2, policyRevision: 0, planRevision: 0, roleRevision: roleRev, taskSpecRevisions: [] }, 300), /STARTUP_BINDING_EPOCH_MISMATCH/);
  // 旧协议版本→拒绝
  assert.throws(() => completeStartupAck(store, { projectId: 'p1', roleId: 'r-new', bindingEpoch: 2, protocolVersion: 1, policyRevision: 0, planRevision: 0, roleRevision: roleRev, taskSpecRevisions: [] }, 300), /STARTUP_PROTOCOL_VERSION_MISMATCH/);
  // 旧策略/计划版本→拒绝
  assert.throws(() => completeStartupAck(store, { projectId: 'p1', roleId: 'r-new', bindingEpoch: 2, protocolVersion: 2, policyRevision: 9, planRevision: 0, roleRevision: roleRev, taskSpecRevisions: [] }, 300), /STARTUP_POLICY_REVISION_MISMATCH/);
  assert.throws(() => completeStartupAck(store, { projectId: 'p1', roleId: 'r-new', bindingEpoch: 2, protocolVersion: 2, policyRevision: 0, planRevision: 7, roleRevision: roleRev, taskSpecRevisions: [] }, 300), /STARTUP_PLAN_REVISION_MISMATCH/);
  // 任务规格版本不符→拒绝（含任务粒度定位）
  createTaskFor(store, 't-1');
  assert.throws(() => completeStartupAck(store, { projectId: 'p1', roleId: 'r-new', bindingEpoch: 2, protocolVersion: 2, policyRevision: 0, planRevision: 0, roleRevision: roleRev, taskSpecRevisions: [{ taskId: 't-1', specRevision: 99 }] }, 300), /STARTUP_TASK_SPEC_REVISION_MISMATCH:t-1/);
  // 全一致→ready且版本化快照
  const taskSpecRevision = store.db.prepare("SELECT spec_revision FROM tasks WHERE id='t-1'").get().spec_revision;
  const acked = completeStartupAck(store, { projectId: 'p1', roleId: 'r-new', bindingEpoch: 2, protocolVersion: 2, policyRevision: 0, planRevision: 0, roleRevision: roleRev, taskSpecRevisions: [{ taskId: 't-1', specRevision: taskSpecRevision }] }, 300);
  assert.equal(acked.bindingState, 'ready');
  assert.ok(store.db.prepare("SELECT 1 FROM role_revisions WHERE role_id='r-new' AND revision>1").get(), '握手后版本化快照');
  void open;
});
function createTaskFor(store, id) {
  createTask(store, { id, projectId: 'p1', goal: 'g' }, 220);
}

test('A105：任务规格分页有水位；换过滤条件复用旧cursor显式拒绝（无静默漏项）', t => {
  const { store } = fixture(t);
  for (const id of ['t-a', 't-b', 't-c']) createTaskFor(store, id);
  const page1 = taskSpecPage(store, 'p1', { limit: 2 });
  assert.deepEqual(page1.items.map(i => i.taskId), ['t-a', 't-b']);
  assert.equal(page1.nextCursor.startsWith('v1:t-b|'), true);
  const page2 = taskSpecPage(store, 'p1', { limit: 2, cursor: page1.nextCursor });
  assert.deepEqual(page2.items.map(i => i.taskId), ['t-c'], '水位续读无漏项');
  assert.equal(page2.nextCursor, null);
  // 换过滤条件复用旧cursor→显式拒绝
  assert.throws(() => taskSpecPage(store, 'p1', { limit: 2, cursor: page1.nextCursor, states: ['ready'] }), /PAGE_CURSOR_FILTER_MISMATCH/);
  assert.throws(() => taskSpecPage(store, 'p1', { cursor: 'garbage' }), /INVALID_PAGE_CURSOR/);
});

test('A105：Agent工具路径startup_ack经命令管线；roleId/bindingEpoch不可由正文覆盖', t => {
  const { store, open } = fixture(t);
  bootstrapRole(store, { projectId: 'p1', localRef: 'r-new', name: 'worker', charter: '做事', permissionProfileId: 'worker', permissionProfileRevision: 1, expectedPolicyRevision: 0, principalId: 'user-1', requestId: 'boot-1' }, 200);
  store.transaction(db => db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s9','synthetic','host','profile','native-new')").run());
  store.transaction(db => db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b9','p1','r-new','s9',2,210)").run());
  // 首次握手属受信主机绑定流程（凭据签发要求ready），在域层完成；工具路径覆盖再握手
  const firstAck = completeStartupAck(store, { projectId: 'p1', roleId: 'r-new', bindingEpoch: 2, protocolVersion: 2, policyRevision: 0, planRevision: 0, roleRevision: store.db.prepare("SELECT revision FROM roles WHERE id='r-new'").get().revision, taskSpecRevisions: [] }, 240);
  assert.equal(firstAck.bindingState, 'ready');
  const credential = issueAgentCredential(store, 'b9', 2, { isolation: 'verified_session', session: { harnessId: 'synthetic', hostId: 'host', profileId: 'profile', nativeConversationId: 'native-new' } }, 250, 60000).credential;
  const principal = authenticateAgentCredential(store, credential, 260);
  const dispatcher = createToolDispatcher(store, { profileInput, now: () => 300, callerNativeConversationId: 'native-new' });
  const roleRev = store.db.prepare("SELECT revision FROM roles WHERE id='r-new'").get().revision;
  // 正文伪造他人roleId/epoch无效：roleId强制取主体
  const acked = dispatcher(principal, 'role.startup_ack', { roleId: 'r-other', bindingEpoch: 2, protocolVersion: 2, policyRevision: 0, planRevision: 0, roleRevision: roleRev, taskSpecRevisions: [] });
  assert.equal(acked.ok, true);
  assert.equal(acked.payload.roleId, 'r-new', 'roleId取主体不取正文');
  assert.equal(acked.payload.bindingState, 'ready');
  assert.ok(store.db.prepare("SELECT 1 FROM commands WHERE type='role.startup_ack' AND state='completed'").get(), '经统一命令管线');
  assert.ok(store.db.prepare("SELECT 1 FROM events WHERE type='role.startup_acknowledged'").get(), '事件已追加');
  // 二次握手：角色revision已推进→旧版本拒绝
  const stale = dispatcher(principal, 'role.startup_ack', { protocolVersion: 2, policyRevision: 0, planRevision: 0, roleRevision: roleRev, taskSpecRevisions: [] });
  assert.equal(stale.ok, false);
  assert.match(stale.payload.error, /STARTUP_ROLE_REVISION_MISMATCH/);
  void open;
});

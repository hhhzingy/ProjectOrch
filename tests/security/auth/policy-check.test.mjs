import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { issueAgentCredential, authenticateAgentCredential } from '../../../apps/kernel/dist/auth/agent-credential.js';
import { authorizeAgentAction, authorizeUserAction, loadAgentSubjectState } from '../../../apps/kernel/dist/auth/policy-check.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';
import { installSyntheticPolicy } from './synthetic-policy.mjs';

const profileInput = { id: 'worker', revision: 1, actions: ['task.read', 'task.claim'], readPaths: ['tasks/*'], writePaths: ['tasks/*'], roleIds: [], delegableActions: [], maxDelegationDepth: 0 };
function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-policy-check-', () => { for (const s of stores) s.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const open = () => { const s = openStore(filename); stores.push(s); return s; };
  const store = open();
  store.transaction(db => {
    for (const n of [1, 2]) {
      db.prepare("INSERT INTO projects(id,name,host_id,canonical_root,objective,created_at) VALUES(?,?,?,?,?,0)").run(`p${n}`, `synthetic ${n}`, 'host', `synthetic-root-${n}`, 'test');
      db.prepare("INSERT INTO roles(id,project_id,name,charter,permission_profile,desired_state,binding_state) VALUES(?,?,?,?,?,'enabled','ready')").run(`r${n}`, `p${n}`, 'synthetic', 'test', 'worker');
      db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES(?,?,?,?,?)").run(`s${n}`, 'synthetic', 'host', 'profile', `native-${n}`);
      db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES(?,?,?,?,1,100)").run(`b${n}`, `p${n}`, `r${n}`, `s${n}`);
    }
  });
  for (const n of [1, 2]) installSyntheticPolicy(store, `p${n}`, [profileInput]);
  return { store, open };
}
const ref = n => ({ harnessId: 'synthetic', hostId: 'host', profileId: 'profile', nativeConversationId: `native-${n}` });
const req = (over = {}) => ({ action: 'task.claim', targetProjectId: 'p1', kind: 'write', ...over });

test('权限来源必须匹配当前持久策略和角色档案，调用方快照不能自扩权或绕过范围', t => {
  const { store } = fixture(t);
  const credential = issueAgentCredential(store, 'b1', 1, { isolation: 'verified_session', session: ref(1) }, 100, 10000).credential;
  const principal = authenticateAgentCredential(store, credential, 150);
  const forged = { ...profileInput, actions: [...profileInput.actions, 'change.apply'] };
  assert.equal(authorizeAgentAction(store, principal, forged, req({ action: 'change.apply' }), 150).allowed, false);
  assert.equal(authorizeAgentAction(store, principal, undefined, req(), 150).allowed, true, '省略缓存时仍从持久策略核验');
  store.db.exec("UPDATE roles SET scope_paths_json='[\"tasks/allowed\"]' WHERE id='r1'");
  assert.equal(authorizeAgentAction(store, principal, profileInput, req({ path: 'tasks/other' }), 150).allowed, false);
  installSyntheticPolicy(store, 'p1', [{ ...profileInput, revision: 2, actions: ['task.read'] }]);
  assert.equal(authorizeAgentAction(store, principal, profileInput, req(), 150).allowed, false, '旧缓存不恢复已收回动作');
  assert.equal(authorizeAgentAction(store, principal, undefined, req(), 150).allowed, false);
});

test('provisioning可获得受限启动身份，但不能用启动身份执行普通写操作', t => {
  const { store } = fixture(t);
  store.db.exec("UPDATE roles SET binding_state='provisioning' WHERE id='r1'");
  const credential = issueAgentCredential(store, 'b1', 1, { isolation: 'verified_session', session: ref(1) }, 100, 10000).credential;
  const principal = authenticateAgentCredential(store, credential, 150);
  assert.equal(authorizeAgentAction(store, principal, undefined, req({ action: 'task.read', kind: 'read' }), 150).allowed, true);
  assert.equal(authorizeAgentAction(store, principal, undefined, req(), 150).allowed, false);
});

test('Agent决策读取实时状态：暂停、禁用与绑定结束在决策时点生效', t => {
  const { store } = fixture(t);
  const credential = issueAgentCredential(store, 'b1', 1, { isolation: 'verified_session', session: ref(1) }, 100, 10000).credential;
  const principal = authenticateAgentCredential(store, credential, 200);
  assert.equal(authorizeAgentAction(store, principal, profileInput, req(), 200).allowed, true);
  store.db.exec('UPDATE projects SET user_paused=1 WHERE id=\'p1\'');
  assert.deepEqual(authorizeAgentAction(store, principal, profileInput, req(), 201), { allowed: false, reason: 'PROJECT_PAUSED' });
  assert.equal(authorizeAgentAction(store, principal, profileInput, req({ kind: 'read', action: 'task.read', path: 'tasks/t1' }), 201).allowed, true);
  store.db.exec('UPDATE projects SET user_paused=0 WHERE id=\'p1\'');
  store.db.exec('UPDATE roles SET desired_state=\'disabled\' WHERE id=\'r1\'');
  assert.deepEqual(authorizeAgentAction(store, principal, profileInput, req(), 202), { allowed: false, reason: 'ROLE_NOT_ENABLED' });
  store.db.exec('UPDATE roles SET desired_state=\'enabled\' WHERE id=\'r1\'');
  store.db.exec('UPDATE role_bindings SET ended_at=202 WHERE id=\'b1\'');
  assert.throws(() => authorizeAgentAction(store, principal, profileInput, req(), 203), /POLICY_SUBJECT_NOT_ACTIVE/);
  assert.throws(() => loadAgentSubjectState(store, principal, 203), /POLICY_SUBJECT_NOT_ACTIVE/);
});

test('跨项目隔离、保留动作与档案角色约束', t => {
  const { store } = fixture(t);
  const credential = issueAgentCredential(store, 'b1', 1, { isolation: 'verified_session', session: ref(1) }, 100, 10000).credential;
  const principal = authenticateAgentCredential(store, credential, 150);
  assert.deepEqual(authorizeAgentAction(store, principal, profileInput, req({ targetProjectId: 'p2' }), 150), { allowed: false, reason: 'PROJECT_ISOLATION' });
  assert.deepEqual(authorizeAgentAction(store, principal, profileInput, req({ action: 'native.input' }), 150), { allowed: false, reason: 'USER_RESERVED' });
  assert.deepEqual(authorizeAgentAction(store, principal, profileInput, req({ action: 'role.bind' }), 150), { allowed: false, reason: 'ACTION_NOT_GRANTED' });
  const restricted = { ...profileInput, roleIds: ['r9'] };
  assert.deepEqual(authorizeAgentAction(store, principal, restricted, req(), 150), { allowed: false, reason: 'ACTION_NOT_GRANTED' });
  assert.throws(() => authorizeAgentAction(store, principal, { ...profileInput, actions: ['project.resume'] }, req(), 150), /POLICY_PROFILE_USER_RESERVED/);
  assert.equal(authorizeUserAction(req({ action: 'project.resume' })).allowed, true);
});

test('主体状态映射校验非法值与时间', t => {
  const { store } = fixture(t);
  const credential = issueAgentCredential(store, 'b1', 1, { isolation: 'verified_session', session: ref(1) }, 100, 10000).credential;
  const principal = authenticateAgentCredential(store, credential, 150);
  assert.throws(() => loadAgentSubjectState(store, principal, -1), /POLICY_CHECK_INVALID_TIME/);
  store.db.exec("UPDATE roles SET desired_state='enabled' WHERE id='r1'");
  const state = loadAgentSubjectState(store, principal, 160);
  assert.deepEqual(state, { roleDesiredState: 'enabled', projectUserPaused: false, bindingState: 'ready' });
  assert.ok(Object.isFrozen(state));
});

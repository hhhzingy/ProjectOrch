/** A053：角色树与跨层级合作。合法父子直接交流（无需逐级转述）；环/深度/权限扩大拒绝。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../packages/persistence/dist/index.js';
import { createProject } from '../../packages/domain/dist/projects/index.js';
import { createRole } from '../../packages/domain/dist/roles/index.js';
import { sendMessage, inboxRead } from '../../packages/domain/dist/messages/index.js';
import { validateGrant, parsePermissionProfile } from '../../packages/domain/dist/policy/index.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-a053-', () => { for (const s of stores.splice(0)) { try { s.close(); } catch { /* 已关闭 */ } } });
  const store = openStore(path.join(dir, 'state.sqlite'));
  stores.push(store);
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: 'E:/synthetic/a053', objective: 'o' }, 100);
  return { store };
}
const parentProfile = { id: 'parent', revision: 1, actions: ['message.send', 'task.read', 'task.report'], readPaths: ['tasks/*'], writePaths: ['tasks/*'], roleIds: [], delegableActions: ['task.read', 'task.report'], maxDelegationDepth: 2 };

test('A053：合法父子创建+直接交流（无需逐级转述）', t => {
  const { store } = fixture(t);
  const parent = createRole(store, { id: 'r-parent', projectId: 'p1', name: 'lead', charter: '统筹', permissionProfileId: 'parent' }, 110);
  const child = createRole(store, { id: 'r-child', projectId: 'p1', name: 'worker', charter: '执行', permissionProfileId: 'child', parentId: 'r-parent' }, 111);
  assert.equal(child.parentId, 'r-parent');
  assert.equal(parent.id, 'r-parent');
  // 跨层直接交流：管理角色直接给子角色发消息，子角色收件箱直接可读（不经过父角色中转）
  store.transaction(db => db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('cmd-d','p1','user','rq-d',?,'project.pause','{}','completed',100)").run('0'.repeat(64)));
  sendMessage(store, { id: 'm-direct', projectId: 'p1', commandId: 'cmd-d', toRoleId: 'r-child', kind: 'notice', body: '直接指令：无需转述' }, 120);
  const inbox = inboxRead(store, 'p1', 'r-child', { limit: 50 });
  assert.deepEqual(inbox.items.map(m => m.id), ['m-direct'], '子角色直接收到管理消息（不强制逐级转发）');
});

test('A053：权限扩大拒绝（子档案超出父可委派集合/保留动作/路径越界/深度超限）', t => {
  const { store } = fixture(t);
  createRole(store, { id: 'r-p', projectId: 'p1', name: 'p', charter: 'c', permissionProfileId: 'parent' }, 110);
  const grant = (child) => validateGrant(parsePermissionProfile(parentProfile), parsePermissionProfile(child), 1);
  assert.equal(grant({ ...parentProfile, id: 'c1', actions: ['task.read'], delegableActions: ['task.read'], maxDelegationDepth: 1 }).valid, true, '合法子档案（子动作⊆父可委派集）');
  // 用户保留动作在档案解析层即拒绝（native.input永不进入委派链）
  assert.throws(() => parsePermissionProfile({ ...parentProfile, id: 'c2', actions: ['message.send', 'task.read', 'native.input'], delegableActions: [] }), /POLICY_PROFILE_USER_RESERVED/, '保留动作永不进入委派链');
  const notHeld = grant({ ...parentProfile, id: 'c3', actions: ['message.send', 'artifact.register'], delegableActions: [] });
  assert.equal(notHeld.valid, false);
  assert.equal(notHeld.reason, 'ACTION_NOT_GRANTED', '超出父可委派集合拒绝');
  const pathEscape = grant({ ...parentProfile, id: 'c4', actions: ['task.read'], readPaths: ['secrets/*'], delegableActions: [] });
  assert.equal(pathEscape.valid, false);
  assert.equal(pathEscape.reason, 'PATH_OUT_OF_SCOPE', '路径越界拒绝');
  const deepDelegation = grant({ ...parentProfile, id: 'c5', actions: ['task.read'], delegableActions: ['task.read'], maxDelegationDepth: 16 });
  assert.equal(deepDelegation.valid, false);
  assert.equal(deepDelegation.reason, 'DELEGATION_DEPTH_EXCEEDED', '再委派深度超限拒绝');
  // 角色树深度防护：链条超过上限→ROLE_DEPTH_EXCEEDED
  let lastParent = 'r-p';
  for (let depth = 0; depth < 12; depth++) {
    const id = `r-d${depth}`;
    try {
      createRole(store, { id, projectId: 'p1', name: id, charter: 'c', permissionProfileId: 'parent', parentId: lastParent }, 120 + depth);
      lastParent = id;
    } catch (error) {
      assert.match(String(error?.message ?? error), /ROLE_DEPTH_EXCEEDED/, '深度上限即环/无界扩张防护');
      return;
    }
  }
  assert.fail('深度上限未触发');
});

test('A053：循环层级拒绝（父链回指自身即环）', t => {
  const { store } = fixture(t);
  const a = createRole(store, { id: 'r-a', projectId: 'p1', name: 'a', charter: 'c', permissionProfileId: 'parent' }, 110);
  void a;
  // 直接构造父链回指：r-c的parent是r-b，r-b的parent是r-a，再建r-x.parent=r-c合法；构造环需自指——域层CREATE时父链游标回指自身→ROLE_CYCLE_REJECTED
  createRole(store, { id: 'r-b', projectId: 'p1', name: 'b', charter: 'c', permissionProfileId: 'parent', parentId: 'r-a' }, 111);
  // 用底层路径构造回指链：把r-a的parent指到r-b（模拟历史数据异常），再建子角色触发环检测
  store.db.prepare("UPDATE roles SET parent_id='r-b' WHERE id='r-a'").run();
  assert.throws(() => createRole(store, { id: 'r-x', projectId: 'p1', name: 'x', charter: 'c', permissionProfileId: 'parent', parentId: 'r-a' }, 115), /ROLE_CYCLE_REJECTED|ROLE_DEPTH_EXCEEDED/, '环被父链游标检测拒绝');
});

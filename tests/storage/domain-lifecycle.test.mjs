import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../packages/persistence/dist/index.js';
import { createProject, setProjectObjective, pauseProjectForUser, resumeProjectByUser, readProject, projectHistory, canonicalRoot } from '../../packages/domain/dist/projects/index.js';
import { createRole, setRoleDesiredState, readRole, roleHistory, roleTaskOwnershipIntact } from '../../packages/domain/dist/roles/index.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-domain-lifecycle-', () => { for (const s of stores) s.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const open = () => { const s = openStore(filename); stores.push(s); return s; };
  const store = open();
  return { store, open };
}
const project = { id: 'p1', name: 'synthetic', hostId: 'host', canonicalRoot: 'E:/synthetic/only', objective: '目标一' };

test('项目生命周期：版本化、用户暂停意图与重启恢复', t => {
  const { store, open } = fixture(t);
  const created = createProject(store, project, 100);
  assert.deepEqual({ ...created, userPaused: false, revision: 1 }, { ...created, userPaused: false, revision: 1 });
  assert.throws(() => createProject(store, { ...project, id: 'p2' }, 101), /UNIQUE/);
  assert.throws(() => createProject(store, { ...project, id: 'p3', canonicalRoot: 'relative/path' }, 101), /INVALID_PROJECT_ROOT/);
  assert.equal(canonicalRoot('E:\\synthetic\\only\\'), 'E:\\synthetic\\only');
  const revised = setProjectObjective(store, 'p1', '目标二', 102);
  assert.equal(revised.revision, 2);
  const paused = pauseProjectForUser(store, 'p1', 103);
  assert.equal(paused.userPaused, true);
  assert.throws(() => pauseProjectForUser(store, 'p1', 104), /PROJECT_ALREADY_PAUSED/);
  assert.equal(resumeProjectByUser(store, 'p1', 105).userPaused, false);
  assert.throws(() => resumeProjectByUser(store, 'p1', 106), /PROJECT_NOT_PAUSED/);
  store.close();
  const reopened = open();
  const history = projectHistory(reopened, 'p1');
  assert.equal(history.length, 4);
  assert.equal(history[0].reason, 'create');
  assert.equal(history[0].snapshot.objective, '目标一');
  assert.equal(history[2].reason, 'user-pause');
  assert.deepEqual(readProject(reopened, 'p1'), { ...readProject(reopened, 'p1'), revision: 4, userPaused: false });
});

test('角色生命周期：层级校验、意图白名单、意图不触碰实际状态', t => {
  const { store } = fixture(t);
  createProject(store, project, 100);
  const root = createRole(store, { id: 'r-root', projectId: 'p1', name: 'root', charter: 'c', permissionProfileId: 'worker' }, 101);
  assert.deepEqual({ desiredState: root.desiredState, bindingState: root.bindingState, revision: root.revision }, { desiredState: 'enabled', bindingState: 'unbound', revision: 1 });
  store.db.exec("UPDATE roles SET binding_state='ready' WHERE id='r-root'");
  const child = createRole(store, { id: 'r-child', projectId: 'p1', name: 'child', charter: 'c', permissionProfileId: 'worker', parentId: 'r-root' }, 102);
  assert.equal(child.parentId, 'r-root');
  assert.throws(() => createRole(store, { id: 'r-x', projectId: 'p1', name: 'x', charter: 'c', permissionProfileId: 'worker', parentId: 'r-other-project' }, 103), /ROLE_NOT_FOUND/);
  let cursor = 'r-child';
  for (let i = 0; i < 7; i++) { const id = `r-l${i}`; createRole(store, { id, projectId: 'p1', name: `l${i}`, charter: 'c', permissionProfileId: 'worker', parentId: cursor }, 104 + i); cursor = id; }
  assert.throws(() => createRole(store, { id: 'r-too-deep', projectId: 'p1', name: 'deep', charter: 'c', permissionProfileId: 'worker', parentId: cursor }, 120), /ROLE_DEPTH_EXCEEDED/);
  const paused = setRoleDesiredState(store, 'p1', 'r-root', 'paused', 121);
  assert.equal(paused.desiredState, 'paused');
  assert.equal(paused.bindingState, 'ready', '意图写入不得改变实际绑定状态');
  assert.equal(setRoleDesiredState(store, 'p1', 'r-root', 'enabled', 122).desiredState, 'enabled');
  assert.throws(() => setRoleDesiredState(store, 'p1', 'r-root', 'enabled', 123), /ROLE_STATE_UNCHANGED/);
});

test('停用后可重新启用（R003）；绑定与凭据不自动恢复；重启历史完整', t => {
  const { store, open } = fixture(t);
  createProject(store, project, 100);
  createRole(store, { id: 'r1', projectId: 'p1', name: 'r', charter: 'c', permissionProfileId: 'worker' }, 101);
  store.transaction(db => db.prepare("INSERT INTO tasks(id,project_id,role_id,goal,state,acceptance_json,plan_revision) VALUES('t1','p1','r1','synthetic goal','draft','[]',0)").run());
  const disabled = setRoleDesiredState(store, 'p1', 'r1', 'disabled', 102);
  assert.equal(disabled.desiredState, 'disabled');
  assert.ok(store.db.prepare("SELECT 1 FROM roles WHERE id='r1'").get(), '停用后角色记录仍在');
  assert.equal(store.db.prepare("SELECT role_id FROM tasks WHERE id='t1'").get().role_id, 'r1', '任务归属未被清除');
  assert.equal(roleTaskOwnershipIntact(store, 'p1', 'r1'), true);
  // 重新启用：意图恢复，实际绑定状态不得自动恢复
  store.db.exec("UPDATE role_bindings SET ended_at=102 WHERE id='b1'");
  const reenabled = setRoleDesiredState(store, 'p1', 'r1', 'enabled', 103);
  assert.equal(reenabled.desiredState, 'enabled');
  assert.equal(reenabled.bindingState, 'unbound', '重新启用不自动恢复实际绑定');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM role_bindings WHERE id='b1' AND ended_at IS NULL").get().n, 0, '已结束绑定不得被意图字段复活');
  store.close();
  const reopened = open();
  const history = roleHistory(reopened, 'p1', 'r1');
  assert.equal(history.length, 3);
  assert.equal(history[1].snapshot.desiredState, 'disabled');
  assert.equal(history[2].snapshot.desiredState, 'enabled');
  assert.equal(readRole(reopened, 'p1', 'r1').bindingState, 'unbound');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../packages/persistence/dist/index.js';
import { createProject } from '../../packages/domain/dist/projects/index.js';
import { createTask } from '../../packages/domain/dist/tasks/index.js';
import { registerWorkspace, reserveWorkspace, releaseWorkspace, retireWorkspace, readWorkspace } from '../../packages/domain/dist/workspaces/index.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-workspaces-', () => { for (const s of stores) s.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const open = () => { const s = openStore(filename); stores.push(s); return s; };
  const store = open();
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: 'E:/synthetic/ws-a', objective: 'o' }, 100);
  createProject(store, { id: 'p2', name: 'b', hostId: 'h', canonicalRoot: 'E:/synthetic/ws-b', objective: 'o' }, 101);
  createTask(store, { id: 't1', projectId: 'p1', goal: 'g' }, 102);
  createTask(store, { id: 't2', projectId: 'p1', goal: 'g' }, 103);
  return { store, open };
}

test('注册：规范化路径全局唯一，跨项目同目录拒绝（R002兜底）', t => {
  const { store } = fixture(t);
  const ws = registerWorkspace(store, { id: 'w1', projectId: 'p1', canonicalPath: 'E:/synthetic/ws-a/work', managed: true, enforcement: 'enforced' }, 110);
  assert.equal(ws.state, 'available');
  assert.throws(() => registerWorkspace(store, { id: 'w2', projectId: 'p2', canonicalPath: 'e:/synthetic/ws-a/work/' }, 111), /UNIQUE|INVALID_PROJECT_ROOT/, '跨项目同目录全局唯一拒绝');
  assert.throws(() => registerWorkspace(store, { id: 'w3', projectId: 'p1', canonicalPath: 'E:/synthetic/ws-a/work', ownerTaskId: 'missing' }, 112), /WORKSPACE_TASK_NOT_FOUND/);
});

test('预约独占与冲突：第二任务预约同工作空间拒绝；仅持有者可释放；retired终态', t => {
  const { store, open } = fixture(t);
  registerWorkspace(store, { id: 'w1', projectId: 'p1', canonicalPath: 'E:/synthetic/ws-a/work' }, 110);
  const reserved = reserveWorkspace(store, 'p1', 'w1', 't1', 111);
  assert.equal(reserved.state, 'reserved');
  assert.equal(reserved.ownerTaskId, 't1');
  assert.throws(() => reserveWorkspace(store, 'p1', 'w1', 't2', 112), /WORKSPACE_CONFLICT/, '独占冲突');
  assert.throws(() => releaseWorkspace(store, 'p1', 'w1', 't2', 113), /WORKSPACE_NOT_OWNER/, '非持有者不得释放');
  const released = releaseWorkspace(store, 'p1', 'w1', 't1', 114);
  assert.equal(released.state, 'available');
  assert.equal(released.ownerTaskId, null);
  const retired = retireWorkspace(store, 'p1', 'w1', 115);
  assert.equal(retired.state, 'retired');
  assert.throws(() => reserveWorkspace(store, 'p1', 'w1', 't1', 116), /WORKSPACE_CONFLICT/, 'retired不可预约');
  assert.throws(() => retireWorkspace(store, 'p1', 'w1', 117), /WORKSPACE_TRANSITION_REJECTED/);
  store.close();
  const reopened = open();
  assert.equal(readWorkspace(reopened, 'p1', 'w1').state, 'retired', '跨重启持久');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../packages/persistence/dist/index.js';
import { createProject } from '../../packages/domain/dist/projects/index.js';
import { createTask } from '../../packages/domain/dist/tasks/index.js';
import { scheduleDispatchable } from '../../packages/domain/dist/scheduler/index.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';
import { seedDependencyResult } from './dependency-fixture.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-scheduler-', () => { for (const s of stores) s.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const open = () => { const s = openStore(filename); stores.push(s); return s; };
  const store = open();
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: 'E:/synthetic/sched', objective: 'o' }, 100);
  return { store, open };
}
const accept = (store, taskId) => seedDependencyResult(store, taskId);

test('确定性调度：仅ready任务入清单、blocked计数、同状态同序（R005同输入同输出）', t => {
  const { store, open } = fixture(t);
  createTask(store, { id: 'e-alpha', projectId: 'p1', goal: 'a' }, 110);
  createTask(store, { id: 'e-beta', projectId: 'p1', goal: 'b' }, 111);
  createTask(store, { id: 'e-gamma', projectId: 'p1', goal: 'c', dependencies: [{ prerequisiteId: 'e-alpha', requiredRevision: 1, condition: 'accepted' }] }, 112);
  // 初始：alpha/beta ready（无依赖），gamma被阻塞
  const plan1 = scheduleDispatchable(store, 'p1');
  assert.deepEqual(plan1.dispatched.map(task => task.taskId), ['e-alpha', 'e-beta'], '字典序决胜');
  assert.equal(plan1.blockedCount, 1);
  // 同状态再次调用：完全相同顺序（确定性）
  const plan1b = scheduleDispatchable(store, 'p1');
  assert.deepEqual(plan1b.dispatched, plan1.dispatched);
  // alpha被接受后：gamma就绪
  accept(store, 'e-alpha');
  const plan2 = scheduleDispatchable(store, 'p1');
  assert.deepEqual(plan2.dispatched.map(task => task.taskId), ['e-beta', 'e-gamma'], '前置验收后gamma进入清单');
  assert.equal(plan2.blockedCount, 0);
  store.close();
  const reopened = open();
  const plan3 = scheduleDispatchable(reopened, 'p1');
  assert.deepEqual(plan3.dispatched.map(task => task.taskId), ['e-beta', 'e-gamma'], '重启后同一状态同一计划（确定性）');
});

test('管理/执行公平交错：m-前缀为管理约定（可覆盖）', t => {
  const { store } = fixture(t);
  createTask(store, { id: 'e-1', projectId: 'p1', goal: 'e1' }, 120);
  createTask(store, { id: 'e-2', projectId: 'p1', goal: 'e2' }, 121);
  createTask(store, { id: 'm-1', projectId: 'p1', goal: 'm1' }, 122);
  createTask(store, { id: 'm-2', projectId: 'p1', goal: 'm2' }, 123);
  const plan = scheduleDispatchable(store, 'p1');
  const ids = plan.dispatched.map(task => task.taskId);
  assert.deepEqual(ids, ['m-1', 'e-1', 'm-2', 'e-2'], '管理先行后公平交错');
  assert.deepEqual(plan.dispatched.map(task => task.isManagement), [true, false, true, false]);
  // 自定义分类函数
  const custom = scheduleDispatchable(store, 'p1', { classifyManagement: taskId => taskId === 'e-1' });
  assert.deepEqual(custom.dispatched.map(task => task.taskId), ['e-1', 'e-2', 'm-1', 'm-2'], '自定义分类生效：管理队列[e-1]先，执行队列[e-2,m-1,m-2]顺序续排');
});

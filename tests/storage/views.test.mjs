import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../packages/persistence/dist/index.js';
import { createProject } from '../../packages/domain/dist/projects/index.js';
import { createTask, markTaskReady } from '../../packages/domain/dist/tasks/index.js';
import { registerArtifact } from '../../packages/domain/dist/artifacts/index.js';
import { taskDetailView, projectTaskGraph } from '../../packages/domain/dist/views/index.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-views-', () => { for (const s of stores) s.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const open = () => { const s = openStore(filename); stores.push(s); return s; };
  const store = open();
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: 'E:/synthetic/views', objective: 'o' }, 100);
  return { store, open };
}
const acceptTask = (store, taskId) => seedDependencyResult(store, taskId);
import { seedDependencyResult } from './dependency-fixture.mjs';

test('任务详情投影：依赖满足判定、成果清单、验收规则、缺失显式拒绝', t => {
  const { store } = fixture(t);
  createTask(store, { id: 't-pre', projectId: 'p1', goal: '前置', acceptance: [{ kind: 'manual', description: '人工验收' }] }, 110);
  createTask(store, { id: 't-main', projectId: 'p1', goal: '主任务', dependencies: [{ prerequisiteId: 't-pre', requiredRevision: 1, condition: 'accepted' }] }, 111);
  const before = taskDetailView(store, 'p1', 't-main');
  assert.equal(before.startReady, false);
  assert.deepEqual(before.dependencies, [{ prerequisiteId: 't-pre', requiredRevision: 1, condition: 'accepted', met: false, prerequisiteState: 'draft' }]);
  acceptTask(store, 't-pre');
  const after = taskDetailView(store, 'p1', 't-main');
  assert.equal(after.startReady, true);
  assert.equal(after.dependencies[0].met, true);
  assert.equal(after.dependencies[0].prerequisiteState, 'accepted');
  registerArtifact(store, { id: 'art-pre', projectId: 'p1', taskId: 't-pre', version: 'v1', pathRef: 'results/pre.txt' }, 140);
  const preView = taskDetailView(store, 'p1', 't-pre');
  assert.equal(preView.artifacts.length, 1);
  assert.equal(preView.acceptance.length, 1, '验收规则入视图');
  assert.throws(() => taskDetailView(store, 'p1', 't-missing'), /VIEW_TASK_NOT_FOUND/);
  assert.throws(() => taskDetailView(store, 'p-missing', 't-pre'), /VIEW_PROJECT_NOT_FOUND/);
  assert.equal(markTaskReady(store, 'p1', 't-main', 141).state, 'ready', '前置验收后主任务可进入ready');
});

test('项目任务图：全任务+依赖边+逐点就绪判定；项目隔离', t => {
  const { store } = fixture(t);
  createTask(store, { id: 't-a', projectId: 'p1', goal: 'a' }, 150);
  createTask(store, { id: 't-b', projectId: 'p1', goal: 'b', dependencies: [{ prerequisiteId: 't-a', requiredRevision: 1, condition: 'accepted' }] }, 151);
  const graph = projectTaskGraph(store, 'p1');
  assert.equal(graph.nodes.length, 2);
  const nodeA = graph.nodes.find(n => n.taskId === 't-a');
  const nodeB = graph.nodes.find(n => n.taskId === 't-b');
  assert.deepEqual(nodeA.dependsOn, []);
  assert.deepEqual(nodeB.dependsOn, ['t-a']);
  assert.equal(nodeB.startReady, false, '前置未验收时B不就绪');
  acceptTask(store, 't-a');
  const after = projectTaskGraph(store, 'p1');
  assert.equal(after.nodes.find(n => n.taskId === 't-b').startReady, true);
  // 项目隔离：p2空图
  createProject(store, { id: 'p2', name: 'b', hostId: 'h', canonicalRoot: 'E:/synthetic/views-b', objective: 'o' }, 160);
  assert.equal(projectTaskGraph(store, 'p2').nodes.length, 0);
});

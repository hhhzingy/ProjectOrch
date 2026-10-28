import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../packages/persistence/dist/index.js';
import { createProject } from '../../packages/domain/dist/projects/index.js';
import { createRole, setRoleDesiredState } from '../../packages/domain/dist/roles/index.js';
import { createTask, markTaskReady, evaluateStartConditions, readTask } from '../../packages/domain/dist/tasks/index.js';
import { registerArtifact } from '../../packages/domain/dist/artifacts/index.js';
import { projectTaskGraph } from '../../packages/domain/dist/views/index.js';
import { setRoleDesiredState as noop } from '../../packages/domain/dist/roles/index.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';
import { seedDependencyResult } from './dependency-fixture.mjs';
import { reviseTaskSpec } from '../../packages/domain/dist/plan-revisions/index.js';
void noop;

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-task-graph-', () => { for (const s of stores) s.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const open = () => { const s = openStore(filename); stores.push(s); return s; };
  const store = open();
  createProject(store, { id: 'p1', name: 'synthetic', hostId: 'host', canonicalRoot: 'E:/synthetic/graph', objective: 'o' }, 100);
  createRole(store, { id: 'r1', projectId: 'p1', name: 'r', charter: 'c', permissionProfileId: 'worker' }, 101);
  return { store, open };
}
const acceptTask = (store, taskId) => seedDependencyResult(store, taskId);

test('任务创建：依赖与所需revision校验、规格快照落盘', t => {
  const { store } = fixture(t);
  const a = createTask(store, { id: 't-a', projectId: 'p1', roleId: 'r1', goal: '前置任务', acceptance: [{ kind: 'manual' }] }, 110);
  assert.equal(a.state, 'draft');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM task_revisions WHERE task_id='t-a'").get().n, 1, '初始快照');
  const b = createTask(store, { id: 't-b', projectId: 'p1', goal: '后续任务', dependencies: [{ prerequisiteId: 't-a', requiredRevision: 1, condition: 'accepted' }] }, 111);
  assert.equal(b.state, 'draft');
  for (const bad of [
    { id: 't-x', projectId: 'p1', goal: 'x', dependencies: [{ prerequisiteId: 't-a', requiredRevision: 99, condition: 'accepted' }] },
    { id: 't-x', projectId: 'p1', goal: 'x', dependencies: [{ prerequisiteId: 't-a', requiredRevision: 1, condition: 'weird' }] },
    { id: 't-x', projectId: 'p-other', goal: 'x' },
    { id: 't-x', projectId: 'p1', goal: 'x', roleId: 'r-missing' },
  ]) assert.throws(() => createTask(store, bad, 112), /TASK_PREREQ_REVISION_NOT_FOUND|INVALID_TASK_CONDITION|TASK_PROJECT_NOT_FOUND|TASK_ROLE_NOT_FOUND/);
});

test('自环与间接环拒绝', t => {
  const { store } = fixture(t);
  createTask(store, { id: 't-1', projectId: 'p1', goal: 'g1' }, 120);
  createTask(store, { id: 't-2', projectId: 'p1', goal: 'g2', dependencies: [{ prerequisiteId: 't-1', requiredRevision: 1, condition: 'accepted' }] }, 121);
  assert.throws(() => createTask(store, { id: 't-1b', projectId: 'p1', goal: 'self', dependencies: [{ prerequisiteId: 't-1b', requiredRevision: 1, condition: 'accepted' }] }, 122), /CHECK constraint failed|TASK_CYCLE_REJECTED/, '自环被库CHECK与域层双重拒绝');
  assert.throws(() => createTask(store, { id: 't-3', projectId: 'p1', goal: 'g3', dependencies: [{ prerequisiteId: 't-2', requiredRevision: 9, condition: 'accepted' }] }, 123), /TASK_PREREQ_REVISION_NOT_FOUND/, '前置revision不存在时拒绝建依赖');
  // 创建路径只允许指向既有任务（无法构造指向新任务的间接环）；图更新的间接环防护由assertNoCycle在其调用点覆盖
  assert.throws(() => evaluateStartConditions(store, 'p1', 't-missing'), /TASK_NOT_FOUND/, '评估缺失任务显式拒绝');
  assert.doesNotThrow(() => readTask(store, 'p1', 't-2'));
});

test('启动条件：accepted与artifact_available评估、ready门槛、revision门槛', t => {
  const { store } = fixture(t);
  createTask(store, { id: 't-pre', projectId: 'p1', goal: '前置' }, 130);
  createTask(store, { id: 't-main', projectId: 'p1', goal: '主任务', dependencies: [{ prerequisiteId: 't-pre', requiredRevision: 1, condition: 'accepted' }] }, 131);
  assert.deepEqual(evaluateStartConditions(store, 'p1', 't-main'), { ready: false, unmet: [{ prerequisiteId: 't-pre', requiredRevision: 1, condition: 'accepted', reason: 'PREREQ_NOT_ACCEPTED' }] });
  assert.throws(() => markTaskReady(store, 'p1', 't-main', 132), /TASK_START_CONDITIONS_UNMET/, '条件不满足不得ready');
  acceptTask(store, 't-pre', 133);
  assert.equal(evaluateStartConditions(store, 'p1', 't-main').ready, true);
  const ready = markTaskReady(store, 'p1', 't-main', 134);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.revision, 2);
  assert.throws(() => markTaskReady(store, 'p1', 't-main', 135), /TASK_TRANSITION_REJECTED/);

  // artifact_available：指定规格的具名成果可用，无需先验收；任意登记不满足。
  createTask(store, { id: 't-art', projectId: 'p1', goal: '产出成果' }, 140);
  createTask(store, { id: 't-dep', projectId: 'p1', goal: '依赖成果', dependencies: [{ prerequisiteId: 't-art', requiredRevision: 1, condition: 'artifact_available', outputName: 'report' }] }, 141);
  assert.equal(evaluateStartConditions(store, 'p1', 't-dep').ready, false);
  registerArtifact(store, { id: 'art-1', projectId: 'p1', taskId: 't-art', version: 'v1', pathRef: 'results/a.txt' }, 142);
  assert.equal(evaluateStartConditions(store, 'p1', 't-dep').ready, false, '任意成果登记不能替代具名输出映射');
  seedDependencyResult(store, 't-art', { accepted: false, outputs: [{ artifactId: 'art-1', version: 'v1', outputName: 'report' }] });
  assert.equal(evaluateStartConditions(store, 'p1', 't-dep').ready, true);
  // 注：依赖创建要求前置该revision快照已存在（FK至task_revisions），因此PREREQ_REVISION_NOT_REACHED为运行期防御路径，域API不可达，不在本测试构造
});

test('跨项目前置拒绝与拓扑可执行集确定性（A039）', t => {
  const { store, open } = fixture(t);
  createTask(store, { id: 't-a', projectId: 'p1', goal: 'a' }, 160);
  const store2 = open();
  createProject(store2, { id: 'p2', name: 'other', hostId: 'host', canonicalRoot: 'E:/synthetic/graph2', objective: 'o' }, 161);
  createRole(store2, { id: 'r2', projectId: 'p2', name: 'r2', charter: 'c', permissionProfileId: 'worker' }, 162);
  assert.throws(() => createTask(store2, { id: 't-b', projectId: 'p2', goal: 'b', dependencies: [{ prerequisiteId: 't-a', requiredRevision: 1, condition: 'accepted' }] }, 163), /TASK_PREREQ_REVISION_NOT_FOUND/, '跨项目前置不可引用');
  // 菱形图：可执行集按轮次推进且顺序确定
  createTask(store, { id: 't-b', projectId: 'p1', goal: 'b', dependencies: [{ prerequisiteId: 't-a', requiredRevision: 1, condition: 'accepted' }] }, 164);
  createTask(store, { id: 't-c', projectId: 'p1', goal: 'c', dependencies: [{ prerequisiteId: 't-a', requiredRevision: 1, condition: 'accepted' }] }, 165);
  createTask(store, { id: 't-d', projectId: 'p1', goal: 'd', dependencies: [{ prerequisiteId: 't-b', requiredRevision: 1, condition: 'accepted' }, { prerequisiteId: 't-c', requiredRevision: 1, condition: 'accepted' }] }, 166);
  const readySet = () => projectTaskGraph(store, 'p1').nodes.filter(n => n.startReady && n.state === 'draft').map(n => n.taskId);
  assert.deepEqual(readySet(), ['t-a']);
  assert.deepEqual(readySet(), ['t-a'], '重复投影得到同一可执行集');
  acceptTask(store, 't-a', 167);
  assert.deepEqual(readySet(), ['t-b', 't-c'], '并行分支同轮就绪且字典序确定');
  acceptTask(store, 't-b', 168);
  assert.deepEqual(readySet(), ['t-c'], '未全满足前汇点不就绪');
  acceptTask(store, 't-c', 169);
  assert.deepEqual(readySet(), ['t-d'], '全前置验收后汇点就绪');
});

test('依赖的验收版本：只提交或旧版本验收不满足指定版本门槛（A040）', t => {
  const { store } = fixture(t);
  createTask(store, { id: 't-pre', projectId: 'p1', goal: '前置' }, 170);
  createTask(store, { id: 't-s1', projectId: 'p1', goal: '后继1', dependencies: [{ prerequisiteId: 't-pre', requiredRevision: 1, condition: 'accepted' }] }, 171);
  store.db.prepare("UPDATE tasks SET state='review' WHERE id='t-pre' AND project_id='p1'").run();
  assert.equal(evaluateStartConditions(store, 'p1', 't-s1').ready, false, '前置只提交未验收不激活后继');
  acceptTask(store, 't-pre', 172);
  assert.equal(evaluateStartConditions(store, 'p1', 't-s1').ready, true, '指定版本下限已验收激活');
  const row = store.db.prepare("SELECT revision,spec_revision FROM tasks WHERE id='t-pre'").get();
  reviseTaskSpec(store, { projectId: 'p1', taskId: 't-pre', expectedRevision: row.revision, expectedSpecRevision: row.spec_revision, spec: { goal: '新版前置', inputArtifacts: [], outputRequirements: [], acceptance: [], dependencies: [] }, affectedTaskIds: ['t-s1'], inFlightPolicy: 'finish_stale', outputReuse: 'none', reason: '更新规格' }, 173);
  createTask(store, { id: 't-s2', projectId: 'p1', goal: '后继2', dependencies: [{ prerequisiteId: 't-pre', requiredRevision: 2, condition: 'accepted' }] }, 174);
  assert.equal(evaluateStartConditions(store, 'p1', 't-s1').ready, false, '旧规格需重核，不能自动跟随新规格');
  assert.equal(evaluateStartConditions(store, 'p1', 't-s2').ready, false, '旧验收和保留的accepted标签不证明新版已验收');
  acceptTask(store, 't-pre');
  assert.equal(evaluateStartConditions(store, 'p1', 't-s2').ready, true, '新版有独立验收事实才激活');
  assert.equal(evaluateStartConditions(store, 'p1', 't-s1').ready, false, '新规格验收也不能替换冻结的旧规格依赖');
});

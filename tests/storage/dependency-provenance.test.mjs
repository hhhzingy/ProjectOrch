import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import { openStore, defaultMigrations } from '../../packages/persistence/dist/index.js';
import { createProject } from '../../packages/domain/dist/projects/index.js';
import { createTask, evaluateStartConditions, markTaskReady } from '../../packages/domain/dist/tasks/index.js';
import { registerArtifact, readArtifactRecord } from '../../packages/domain/dist/artifacts/index.js';
import { reviseTaskSpec } from '../../packages/domain/dist/plan-revisions/index.js';
import { scheduleDispatchable } from '../../packages/domain/dist/scheduler/index.js';
import { taskDetailView } from '../../packages/domain/dist/views/index.js';
import { seedDependencyResult } from './dependency-fixture.mjs';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';

function fixture(t, options = {}) {
  const stores = [];
  const directory = temporaryDirectory(t, 'projectorch-dependency-provenance-', () => { for (const s of stores) s.close(); });
  const filename = path.join(directory, 'state.sqlite');
  const open = config => { const s = openStore(filename, config); stores.push(s); return s; };
  const store = open(options);
  createProject(store, { id: 'p1', name: 'synthetic', hostId: 'h', canonicalRoot: 'E:/synthetic/provenance', objective: 'o' }, 100);
  return { store, open };
}
function revise(store, taskId) {
  const row = store.db.prepare('SELECT revision,spec_revision FROM tasks WHERE id=?').get(taskId);
  return reviseTaskSpec(store, { projectId: 'p1', taskId, expectedRevision: row.revision, expectedSpecRevision: row.spec_revision,
    spec: { goal: 'revised', inputArtifacts: [], outputRequirements: [], acceptance: [], dependencies: [] },
    affectedTaskIds: [], inFlightPolicy: 'finish_stale', outputReuse: 'none', reason: '组件测试规格修订' }, 200);
}
const create = (store, id, dependencies = []) => createTask(store, { id, projectId: 'p1', goal: id, dependencies }, 110);
const ready = (store, id = 'next') => evaluateStartConditions(store, 'p1', id).ready;

test('仅改accepted标签或实体revision不能解锁；真实裁决、过期/争议/取消均按事实判断', t => {
  const { store } = fixture(t);
  create(store, 'pre'); create(store, 'next', [{ prerequisiteId: 'pre', requiredRevision: 1, condition: 'accepted' }]);
  store.db.exec("UPDATE tasks SET state='accepted',revision=500 WHERE id='pre'");
  assert.equal(ready(store), false);
  const result = seedDependencyResult(store, 'pre');
  assert.equal(ready(store), true);
  store.db.prepare("UPDATE results SET eligibility='disputed' WHERE id=?").run(result.id);
  assert.equal(ready(store), false);
  store.db.prepare("UPDATE results SET eligibility='current' WHERE id=?").run(result.id);
  store.db.exec("UPDATE tasks SET state='cancelled' WHERE id='pre'");
  assert.equal(ready(store), false);
});

test('具名成果依赖核对输出名、版本、任务归属及结果资格；验收标签不能替代成果', t => {
  const { store, open } = fixture(t);
  create(store, 'pre'); create(store, 'other');
  assert.throws(() => create(store, 'bad', [{ prerequisiteId: 'pre', requiredRevision: 1, condition: 'artifact_available' }]), /INVALID_TASK_OUTPUT_NAME/);
  assert.equal(store.db.prepare("SELECT 1 FROM tasks WHERE id='bad'").get(), undefined, '创建失败完整回滚');
  create(store, 'next', [{ prerequisiteId: 'pre', requiredRevision: 1, condition: 'artifact_available', outputName: 'report' }]);
  registerArtifact(store, { id: 'art', projectId: 'p1', taskId: 'pre', taskRevision: 1, version: 'v1', pathRef: 'results/a.txt' }, 120);
  registerArtifact(store, { id: 'foreign-task', projectId: 'p1', taskId: 'other', version: 'v1', pathRef: 'results/b.txt' }, 120);
  for (const [index, output] of [
    { artifactId: 'art', version: 'v1', outputName: 'other' },
    { artifactId: 'art', version: 'wrong', outputName: 'report' },
    { artifactId: 'foreign-task', version: 'v1', outputName: 'report' },
    { artifactId: 'missing', version: 'v1', outputName: 'report' },
  ].entries()) {
    seedDependencyResult(store, 'pre', { accepted: false, suffix: String(index), outputs: [output] });
    assert.equal(ready(store), false);
  }
  const result = seedDependencyResult(store, 'pre', { accepted: false, suffix: 'valid', outputs: [{ artifactId: 'art', version: 'v1', outputName: 'report' }] });
  assert.equal(ready(store), true, '无需把可用成果条件扩大为先验收');
  assert.equal(taskDetailView(store, 'p1', 'next').dependencies[0].outputName, 'report');
  assert.equal(taskDetailView(store, 'p1', 'pre').artifacts[0].taskRevision, 1);
  store.db.prepare("UPDATE results SET eligibility='stale' WHERE id=?").run(result.id);
  assert.equal(ready(store), false);
  store.close();
  assert.equal(ready(open()), false, '重启保留过期事实');
});

test('规格更新后旧成果不能绑定新结果冒充新版产物；登记拒绝陈旧规格并保留不可变来源', t => {
  const { store } = fixture(t);
  create(store, 'pre');
  const old = registerArtifact(store, { id: 'old', projectId: 'p1', taskId: 'pre', version: 'v1', pathRef: 'results/a.txt' }, 120);
  assert.equal(old.taskRevision, 1);
  revise(store, 'pre');
  create(store, 'next', [{ prerequisiteId: 'pre', requiredRevision: 2, condition: 'artifact_available', outputName: 'report' }]);
  seedDependencyResult(store, 'pre', { accepted: false, outputs: [{ artifactId: 'old', version: 'v1', outputName: 'report' }] });
  assert.equal(ready(store), false);
  assert.throws(() => registerArtifact(store, { id: 'stale', projectId: 'p1', taskId: 'pre', taskRevision: 1, version: 'v1', pathRef: 'results/a.txt' }, 220), /ARTIFACT_TASK_REVISION_STALE/);
  assert.equal(store.db.prepare("SELECT 1 FROM artifacts WHERE id='stale'").get(), undefined);
  assert.throws(() => store.db.exec("UPDATE artifacts SET task_revision=2 WHERE id='old'"), /ARTIFACT_IMMUTABLE/);
  assert.throws(() => store.db.exec("INSERT INTO artifacts(id,project_id,task_id,task_revision,version,path_ref) VALUES('invalid','p1','pre',99,'v','a.txt')"), /ARTIFACT_SPEC_NOT_FOUND/);
  registerArtifact(store, { id: 'new', projectId: 'p1', taskId: 'pre', taskRevision: 2, version: 'v2', pathRef: 'results/a.txt' }, 220);
  seedDependencyResult(store, 'pre', { accepted: false, suffix: 'new', outputs: [{ artifactId: 'new', version: 'v2', outputName: 'report' }] });
  assert.equal(ready(store), true);
});

test('迁移8→9保留旧成果与依赖、不猜规格/输出名，缺证据明确阻塞且升级备份可用', t => {
  const { store, open } = fixture(t, { migrations: defaultMigrations().slice(0, 8) });
  store.db.exec("INSERT INTO tasks(id,project_id,goal,state,revision,spec_revision,plan_revision,acceptance_json) VALUES('pre','p1','pre','accepted',7,1,0,'[]'),('next','p1','next','draft',1,1,0,'[]'); INSERT INTO task_revisions(task_id,project_id,revision,snapshot_json) VALUES('pre','p1',1,'{}'),('next','p1',1,'{}'); INSERT INTO task_dependencies(project_id,task_id,prerequisite_id,required_revision,condition) VALUES('p1','next','pre',1,'artifact_available'); INSERT INTO artifacts(id,project_id,task_id,version,path_ref) VALUES('legacy','p1','pre','v1','results/legacy.txt')");
  store.close();
  const upgraded = open();
  assert.ok(fs.existsSync(upgraded.migrationBackup));
  assert.equal(readArtifactRecord(upgraded, 'p1', 'legacy').taskRevision, null);
  assert.equal(upgraded.db.prepare("SELECT version FROM artifacts WHERE id='legacy'").get().version, 'v1');
  assert.equal(evaluateStartConditions(upgraded, 'p1', 'next').unmet[0].reason, 'PREREQ_OUTPUT_NAME_MISSING');
  upgraded.db.exec("UPDATE task_dependencies SET output_name='report' WHERE task_id='next'");
  seedDependencyResult(upgraded, 'pre', { outputs: [{ artifactId: 'legacy', version: 'v1', outputName: 'report' }] });
  assert.equal(ready(upgraded), false, '输出名补齐也不能猜测旧成果规格');
});

test('调度包含持久ready任务与真实实体/规格版本，unknown占位不进入候选，重复扫描无副作用', t => {
  const { store } = fixture(t);
  create(store, 'pre'); markTaskReady(store, 'p1', 'pre', 120);
  let plan = scheduleDispatchable(store, 'p1');
  assert.equal(plan.dispatched[0].state, 'ready');
  assert.equal(plan.dispatched[0].revision, 2); assert.equal(plan.dispatched[0].specRevision, 1);
  assert.deepEqual(scheduleDispatchable(store, 'p1'), plan);
  const result = seedDependencyResult(store, 'pre', { accepted: false });
  store.db.prepare("UPDATE attempts SET state='unknown' WHERE id=?").run(result.id);
  assert.equal(scheduleDispatchable(store, 'p1').dispatched.length, 0);
  store.db.prepare("UPDATE attempts SET state='succeeded' WHERE id=?").run(result.id);
  plan = scheduleDispatchable(store, 'p1');
  assert.equal(plan.dispatched.length, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, 1, '规划不是外发，不新建尝试');
});

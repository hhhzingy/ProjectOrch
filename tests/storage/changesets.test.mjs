import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../packages/persistence/dist/index.js';
import { createProject, readProject } from '../../packages/domain/dist/projects/index.js';
import { createRole } from '../../packages/domain/dist/roles/index.js';
import { createTask } from '../../packages/domain/dist/tasks/index.js';
import { applyChangeset, applyChangesetWithin } from '../../packages/domain/dist/changesets/index.js';
import { registerArtifact } from '../../packages/domain/dist/artifacts/index.js';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-changesets-', () => { for (const s of stores) s.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const open = () => { const s = openStore(filename); stores.push(s); return s; };
  const store = open();
  createProject(store, { id: 'p1', name: 'synthetic', hostId: 'host', canonicalRoot: 'E:/synthetic/cs', objective: '初始目标' }, 100);
  createRole(store, { id: 'r-existing', projectId: 'p1', name: 'existing', charter: 'c', permissionProfileId: 'worker' }, 101);
  return { store, open, filename };
}
const base = { schemaVersion: 2, requestId: 'cs-req-1', projectId: 'p1', expectedPlanRevision: 0, reason: '管理变更：建角色并调整计划' };
// changesets.command_id外键指向commands：真实流程中命令行由runner先建，测试等价播种
const ensureCommand = (store, commandId, requestId) => store.transaction(db => db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES(?, 'p1', 'manager', ?, ?, 'management.apply_changes', '{}', 'stored', 100)").run(commandId, requestId, '0'.repeat(64)));

test('变更集整册事务：多操作按序应用、plan_revision递增、applied留痕', t => {
  const { store } = fixture(t);
  ensureCommand(store, 'cmd-cs-1', 'cs-req-1'); const applied = applyChangeset(store, 'cmd-cs-1', { ...base, operations: [
    { type: 'role.create', localRef: 'r-new', name: '新角色', charter: '新章程', scopePaths: ['tasks/*'], permissionProfileId: 'worker', permissionProfileRevision: 0 },
    { type: 'plan.revise', objective: '修订后的目标', affectedTaskIds: [], rationale: '范围调整' },
  ] }, 110);
  assert.equal(applied.appliedOperations, 2);
  assert.equal(applied.planRevision, 1);
  assert.equal(readProject(store, 'p1').objective, '修订后的目标');
  assert.equal(store.db.prepare("SELECT state FROM changesets WHERE id='cs-cmd-cs-1'").get().state, 'applied');
  assert.equal(store.db.prepare("SELECT desired_state FROM roles WHERE id='r-new'").get().desired_state, 'enabled');
  ensureCommand(store, 'cmd-cs-2', 'cs-req-2'); assert.throws(() => applyChangeset(store, 'cmd-cs-2', { ...base, requestId: 'cs-req-2', expectedPlanRevision: 0, operations: [{ type: 'plan.revise', objective: 'x', affectedTaskIds: [], rationale: 'r' }] }, 111), /PLAN_REVISION_CONFLICT/, '旧expectedPlanRevision乐观并发拒绝');
});

test('任一操作预检失败→整册回滚不部分应用，failed/conflict留痕持久', t => {
  const { store, open } = fixture(t);
  ensureCommand(store, 'cmd-ok', 'ok-1'); applyChangeset(store, 'cmd-ok', { ...base, requestId: 'ok-1', operations: [{ type: 'role.create', localRef: 'r-a', name: 'A', charter: 'c', scopePaths: [], permissionProfileId: 'worker', permissionProfileRevision: 0 }] }, 110);
  // 第二册：第二操作引用缺失角色→整册失败，第一操作（角色创建）不得生效
  assert.throws(() => { ensureCommand(store, 'cmd-bad', 'bad-1'); return applyChangeset(store, 'cmd-bad', { ...base, requestId: 'bad-1', expectedPlanRevision: 1, operations: [
    { type: 'role.create', localRef: 'r-b', name: 'B', charter: 'c', scopePaths: [], permissionProfileId: 'worker', permissionProfileRevision: 0 },
    { type: 'role.pause', roleId: 'r-missing', expectedRevision: 0, reason: 'x', currentWorkPolicy: 'finish' },
  ] }, 120); }, /CHANGESET_FAILED:ROLE_NOT_FOUND[^@]*@1/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM roles WHERE id='r-b'").get().n, 0, '整册回滚：第一操作未生效');
  assert.equal(store.db.prepare("SELECT state FROM changesets WHERE id='cs-cmd-bad'").get().state, 'failed', '失败留痕');
  // 乐观并发冲突留痕conflict
  assert.throws(() => { ensureCommand(store, 'cmd-stale', 'stale-1'); return applyChangeset(store, 'cmd-stale', { ...base, requestId: 'stale-1', expectedPlanRevision: 99, operations: [{ type: 'plan.revise', objective: 'x', affectedTaskIds: [], rationale: 'r' }] }, 121); }, /CHANGESET_CONFLICT:PLAN_REVISION_CONFLICT/);
  assert.equal(store.db.prepare("SELECT state FROM changesets WHERE id='cs-cmd-stale'").get().state, 'conflict');
  store.close();
  const reopened = open();
  assert.equal(reopened.db.prepare("SELECT state FROM changesets WHERE id='cs-cmd-ok'").get().state, 'applied', '跨重启applied持久');
  assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM changesets WHERE state IN ('failed','conflict')").get().n, 2);
});

test('角色意图迁移与任务操作经变更集：revision并发校验、task.cancel拒绝已验收', t => {
  const { store } = fixture(t);
  createTask(store, { id: 't-1', projectId: 'p1', goal: 'g' }, 110);
  ensureCommand(store, 'cmd-cs-3', 'cs-3'); const applied = applyChangeset(store, 'cmd-cs-3', { ...base, requestId: 'cs-3', operations: [
    { type: 'role.pause', roleId: 'r-existing', expectedRevision: 1, reason: '暂停', currentWorkPolicy: 'finish' },
    { type: 'task.assign', taskId: 't-1', expectedRevision: 1, roleId: 'r-existing' },
  ] }, 130);
  assert.equal(applied.appliedOperations, 2);
  assert.equal(store.db.prepare("SELECT desired_state FROM roles WHERE id='r-existing'").get().desired_state, 'paused');
  assert.equal(store.db.prepare("SELECT role_id FROM tasks WHERE id='t-1'").get().role_id, 'r-existing');
  // 陈旧revision拒绝
  assert.throws(() => { ensureCommand(store, 'cmd-cs-4', 'cs-4'); return applyChangeset(store, 'cmd-cs-4', { ...base, requestId: 'cs-4', operations: [{ type: 'role.enable', roleId: 'r-existing', expectedRevision: 1, reason: 'x', currentWorkPolicy: 'finish' }] }, 131), /CHANGESET_FAILED:ROLE_REVISION_CONFLICT[^@]*@0/, '角色已到revision 2，陈旧expected拒绝' });
  // 已验收任务不得取消
  store.db.prepare("UPDATE tasks SET state='accepted' WHERE id='t-1'").run();
  assert.throws(() => { ensureCommand(store, 'cmd-cs-5', 'cs-5'); return applyChangeset(store, 'cmd-cs-5', { ...base, requestId: 'cs-5', operations: [{ type: 'task.cancel', taskId: 't-1', expectedRevision: 3, reason: 'x' }] }, 132), /CHANGESET_FAILED:TASK_TRANSITION_REJECTED[^@]*@0/ });
  // 不支持操作显式拒绝
  assert.throws(() => { ensureCommand(store, 'cmd-cs-6', 'cs-6'); return applyChangeset(store, 'cmd-cs-6', { ...base, requestId: 'cs-6', operations: [{ type: 'task.spec.revise', taskId: 't-1', expectedRevision: 3, expectedSpecRevision: 0, spec: { goal: 'x', outputRequirements: [{ name: 'o', kind: 'file', description: 'd' }] }, affectedTaskIds: [], inFlightPolicy: 'finish', outputReuse: 'allow', reason: 'x' }] }, 133), /CHANGESET_FAILED:CAPABILITY_UNSUPPORTED[^@]*@0/ });
});

test('A049/A050：新增角色+重派任务整册生效；非法/自提权拒绝，规格版本冲突拒绝且合法修订保存', t => {
  const { store } = fixture(t);
  createTask(store, { id: 't-a', projectId: 'p1', goal: 'a' }, 105);
  createTask(store, { id: 't-b', projectId: 'p1', goal: 'b' }, 106);
  // A049合法场景：新增角色+重派任务同册原子生效
  ensureCommand(store, 'cmd-a049', 'a049-1');
  const applied = applyChangeset(store, 'cmd-a049', { ...base, requestId: 'a049-1', expectedPlanRevision: 0, operations: [
    { type: 'role.create', localRef: 'r-reassigned', name: '接手角色', charter: '接手', scopePaths: ['tasks/*'], permissionProfileId: 'worker', permissionProfileRevision: 0 },
    { type: 'task.assign', taskId: 't-a', expectedRevision: 1, roleLocalRef: 'r-reassigned' },
  ] }, 110);
  assert.equal(applied.appliedOperations, 2, '新增角色与重派任务同册生效');
  assert.equal(store.db.prepare("SELECT role_id FROM tasks WHERE id='t-a'").get().role_id, 'r-reassigned');
  // A049注入非法项（指向不存在的角色）→整册拒绝无半个计划
  ensureCommand(store, 'cmd-a049b', 'a049-2');
  assert.throws(() => applyChangeset(store, 'cmd-a049b', { ...base, requestId: 'a049-2', expectedPlanRevision: applied.planRevision, operations: [
    { type: 'role.create', localRef: 'r-x', name: 'x', charter: 'x', scopePaths: [], permissionProfileId: 'worker', permissionProfileRevision: 0 },
    { type: 'task.assign', taskId: 't-b', expectedRevision: 1, roleId: 'r-ghost' },
  ] }, 120), /ROLE_NOT_FOUND/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM roles WHERE id='r-x'").get().n, 0, '整册拒绝无半个计划');
  // A050自提权：自由脚本/未知管理操作与规格修订显式拒绝（管理Agent不可自行扩大授权）
  ensureCommand(store, 'cmd-a050', 'a050-1');
  assert.throws(() => applyChangeset(store, 'cmd-a050', { ...base, requestId: 'a050-1', expectedPlanRevision: applied.planRevision, operations: [{ type: 'policy.configure', policyJson: { everything: true } }] }, 130), /SCHEMA_MISMATCH|CAPABILITY_UNSUPPORTED|INVALID/, '自由策略变更不在管理操作枚举（合同层即拒绝）');
  ensureCommand(store, 'cmd-a050b', 'a050-2');
  const revision = { type: 'task.spec.revise', taskId: 't-a', expectedRevision: 2, expectedSpecRevision: 0, spec: { goal: '修订目标', inputArtifacts: [], outputRequirements: [{ name: 'r', kind: 'file', description: 'd' }], acceptance: [{ ruleId: 'r1', description: '独立复核', mode: 'designated_reviewer', reviewerRoleId: 'r-reassigned', independent: true }], dependencies: [] }, affectedTaskIds: [], inFlightPolicy: 'finish_stale', outputReuse: 'none', reason: '规格修订' };
  assert.throws(() => applyChangeset(store, 'cmd-a050b', { ...base, requestId: 'a050-2', expectedPlanRevision: applied.planRevision, operations: [revision] }, 135), /SPEC_REVISION_CONFLICT/, '旧规格号不能覆盖当前任务');
  ensureCommand(store, 'cmd-valid-spec', 'valid-spec');
  const revised = applyChangeset(store, 'cmd-valid-spec', { ...base, requestId: 'valid-spec', expectedPlanRevision: applied.planRevision, operations: [{ ...revision, expectedSpecRevision: 1 }] }, 136);
  assert.equal(revised.planRevision, applied.planRevision + 1);
  assert.equal(store.db.prepare("SELECT spec_revision FROM tasks WHERE id='t-a'").get().spec_revision, 2);
  const saved = JSON.parse(store.db.prepare("SELECT snapshot_json FROM task_revisions WHERE task_id='t-a' AND revision=2").get().snapshot_json);
  assert.equal(saved.goal, revision.spec.goal); assert.deepEqual(saved.acceptance, revision.spec.acceptance);
  void store;
});

test('批内建角色后创建任务，完整输入/输出/具名依赖保存到当前值与规格快照', t => {
  const { store } = fixture(t);
  createTask(store, { id: 'pre', projectId: 'p1', goal: 'pre' }, 105);
  registerArtifact(store, { id: 'input', projectId: 'p1', version: 'v1', pathRef: 'input.txt' }, 106);
  const spec = { goal: '任务目标', inputArtifacts: [{ artifactId: 'input', version: 'v1' }], outputRequirements: [{ name: 'out', kind: 'file', description: '产物' }], acceptance: [{ ruleId: 'manual', mode: 'user', description: '用户验收' }], dependencies: [{ taskId: 'pre', requiredTaskRevision: 1, condition: 'artifact_available', outputName: 'report' }] };
  ensureCommand(store, 'cmd-create', 'create');
  const result = applyChangeset(store, 'cmd-create', { ...base, requestId: 'create', operations: [
    { type: 'role.create', localRef: 'new-role', name: '执行者', charter: '具体任务', scopePaths: ['results/*'], permissionProfileId: 'worker', permissionProfileRevision: 0 },
    { type: 'task.create', localRef: 'new-task', assigneeLocalRef: 'new-role', spec },
  ] }, 120);
  assert.equal(result.appliedOperations, 2);
  const row = store.db.prepare("SELECT role_id,inputs_json,outputs_json FROM tasks WHERE id='new-task'").get();
  assert.equal(row.role_id, 'new-role'); assert.deepEqual(JSON.parse(row.inputs_json), spec.inputArtifacts); assert.deepEqual(JSON.parse(row.outputs_json), spec.outputRequirements);
  const snapshot = JSON.parse(store.db.prepare("SELECT snapshot_json FROM task_revisions WHERE task_id='new-task' AND revision=1").get().snapshot_json);
  assert.deepEqual(snapshot.inputArtifacts, spec.inputArtifacts); assert.deepEqual(snapshot.outputRequirements, spec.outputRequirements);
  assert.equal(snapshot.dependencies[0].outputName, 'report');
  assert.equal(store.db.prepare("SELECT output_name FROM task_dependencies WHERE task_id='new-task'").get().output_name, 'report');
});

test('批内连续操作核验更新后的revision；后项失败回滚全册并持久失败审计', t => {
  const { store } = fixture(t);
  const pause = { type: 'role.pause', roleId: 'r-existing', expectedRevision: 1, reason: '暂停', currentWorkPolicy: 'finish' };
  const enable = { type: 'role.enable', roleId: 'r-existing', expectedRevision: 2, reason: '恢复', currentWorkPolicy: 'finish' };
  ensureCommand(store, 'cmd-batch', 'batch');
  applyChangeset(store, 'cmd-batch', { ...base, requestId: 'batch', operations: [pause, enable] }, 120);
  assert.equal(store.db.prepare("SELECT revision FROM roles WHERE id='r-existing'").get().revision, 3);
  ensureCommand(store, 'cmd-failure', 'failure');
  assert.throws(() => applyChangeset(store, 'cmd-failure', { ...base, requestId: 'failure', expectedPlanRevision: 1, operations: [
    { ...pause, expectedRevision: 3 }, { ...enable, expectedRevision: 3 },
  ] }, 130), /ROLE_REVISION_CONFLICT.*@1/);
  assert.equal(store.db.prepare("SELECT desired_state FROM roles WHERE id='r-existing'").get().desired_state, 'enabled');
  assert.equal(store.db.prepare("SELECT revision FROM roles WHERE id='r-existing'").get().revision, 3);
  assert.equal(store.db.prepare("SELECT state FROM changesets WHERE command_id='cmd-failure'").get().state, 'failed');
  assert.equal(store.db.prepare("SELECT plan_revision FROM projects WHERE id='p1'").get().plan_revision, 1);
});

test('事务内入口不嵌套事务；外层失败共同回滚，未入事务拒绝', t => {
  const { store } = fixture(t);
  const input = { ...base, requestId: 'within', operations: [{ type: 'role.create', localRef: 'within-role', name: 'role', charter: 'c', scopePaths: [], permissionProfileId: 'worker', permissionProfileRevision: 0 }] };
  assert.throws(() => applyChangesetWithin(store.db, 'cmd-within', input, 120), /CHANGESET_TRANSACTION_REQUIRED/);
  ensureCommand(store, 'cmd-within', 'within');
  assert.throws(() => store.transaction(db => { applyChangesetWithin(db, 'cmd-within', input, 120); throw new Error('INJECTED_AFTER_APPLY'); }), /INJECTED_AFTER_APPLY/);
  assert.equal(store.db.prepare("SELECT 1 FROM roles WHERE id='within-role'").get(), undefined);
  assert.equal(store.db.prepare("SELECT 1 FROM changesets WHERE command_id='cmd-within'").get(), undefined);
  assert.equal(store.transaction(db => applyChangesetWithin(db, 'cmd-within', input, 120)).planRevision, 1);
});

test('两个真实进程竞争同一计划版本，仅一册生效，另册明确冲突', { timeout: 20000 }, async t => {
  const { store, filename } = fixture(t);
  const children = ['process-a', 'process-b'].map(id => fork(new URL('./fixtures/changeset-concurrency-worker.mjs', import.meta.url), [filename, id], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true }));
  t.after(() => { for (const child of children) if (child.exitCode === null && !child.killed) child.kill(); });
  const exits = children.map(child => once(child, 'exit'));
  const initial = await Promise.all(children.map(child => once(child, 'message')));
  assert.ok(initial.every(([message]) => message.ready));
  const pending = children.map(child => once(child, 'message'));
  for (const child of children) child.send('go');
  const results = (await Promise.all(pending)).map(([message]) => message);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.match(results.find(r => !r.ok).error, /CHANGESET_CONFLICT:PLAN_REVISION_CONFLICT/);
  assert.ok((await Promise.all(exits)).every(([code]) => code === 0));
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM roles WHERE id LIKE 'role-process-%'").get().n, 1);
  assert.equal(store.db.prepare("SELECT plan_revision FROM projects WHERE id='p1'").get().plan_revision, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM changesets WHERE state='conflict'").get().n, 1);
});

/** A052/A087：计划影响分析与规格修订。旧成果保留（stale历史）、新验收缺口明确、无关工作可继续；
 * specRevision递增、旧结果不释放新依赖、新检查生成新结果后再裁决。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore, defaultMigrations } from '../../packages/persistence/dist/index.js';
import { createProject } from '../../packages/domain/dist/projects/index.js';
import { createRole } from '../../packages/domain/dist/roles/index.js';
import { createTask, markTaskReady } from '../../packages/domain/dist/tasks/index.js';
import { submitResult, decideAcceptance, readResult } from '../../packages/domain/dist/results/index.js';
import { reviseTaskSpec, analyzeSpecImpact, requestRevalidate } from '../../packages/domain/dist/plan-revisions/index.js';
import { evaluateStartConditions } from '../../packages/domain/dist/tasks/index.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-plan-rev-', () => { for (const s of stores.splice(0)) { try { s.close(); } catch { /* 已关闭 */ } } });
  const open = () => { const store = openStore(path.join(dir, 'state.sqlite')); stores.push(store); return store; };
  const store = open();
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: 'E:/synthetic/planrev', objective: 'o' }, 100);
  createRole(store, { id: 'r-w', projectId: 'p1', name: 'worker', charter: 'c', permissionProfileId: 'worker' }, 101);
  createTask(store, { id: 't-pre', projectId: 'p1', goal: '前置', acceptance: [{ kind: 'manual' }] }, 110);
  createTask(store, { id: 't-down', projectId: 'p1', goal: '下游', dependencies: [{ prerequisiteId: 't-pre', requiredRevision: 1, condition: 'accepted' }] }, 111);
  createTask(store, { id: 't-unrelated', projectId: 'p1', goal: '无关' }, 112);
  store.transaction(db => db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s1','synthetic','host','profile','native-1')").run());
  store.transaction(db => db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b1','p1','r-w','s1',1,120)").run());
  store.db.prepare("INSERT INTO attempts(id,project_id,task_id,task_revision,binding_id,binding_epoch,execution_kind,state,started_at) VALUES('at-1','p1','t-pre',1,'b1',1,'native','running',125)").run();
  store.transaction(db => db.prepare("UPDATE tasks SET spec_revision=1 WHERE id='t-pre'").run());
  const result = submitResult(store, { id: 'res-old', projectId: 'p1', taskId: 't-pre', taskRevision: 1, attemptId: 'at-1', outcome: 'succeeded', summary: '旧规格成果' }, 130);
  assert.equal(result.eligibility, 'current');
  return { store, open };
}
const newSpec = (goal) => ({
  goal,
  inputArtifacts: [],
  outputRequirements: [{ name: 'report', kind: 'report', description: '按新要求输出' }],
  acceptance: [{ kind: 'manual' }],
  dependencies: [],
});

test('传递闭包使间接后继及迟到结果待重核；仅取消未发内部调度，无关任务和消息保持', t => {
  const { store, open } = fixture(t);
  createTask(store, { id: 't-leaf', projectId: 'p1', goal: '间接后继', dependencies: [{ prerequisiteId: 't-down', requiredRevision: 1, condition: 'accepted' }] }, 132);
  store.db.exec("INSERT INTO attempts(id,project_id,task_id,task_revision,binding_id,binding_epoch,state,started_at) VALUES('down-attempt','p1','t-down',1,'b1',1,'running',133)");
  submitResult(store, { id: 'down-old', projectId: 'p1', taskId: 't-down', taskRevision: 1, attemptId: 'down-attempt', outcome: 'succeeded', summary: '后继旧成果' }, 134);
  store.db.exec("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('cmd','p1','user','req','hash','test','{}','completed',135)");
  for (const [id, event, taskId, state] of [['root', 'workflow.evaluate', 't-pre', 'pending'], ['child', 'workflow.evaluate', 't-down', 'pending'], ['leaf', 'workflow.evaluate', 't-leaf', 'pending'], ['unrelated', 'workflow.evaluate', 't-unrelated', 'pending'], ['message', 'message.deliver', 't-pre', 'pending'], ['sent', 'workflow.evaluate', 't-down', 'uncertain']]) {
    store.db.prepare("INSERT INTO outbox(id,command_id,operation_key,payload_json,state,next_attempt_at) VALUES(?,'cmd',?,?,?,135)").run(id, id, JSON.stringify({ event, taskId }), state);
  }
  const impact = reviseTaskSpec(store, { projectId: 'p1', taskId: 't-pre', expectedRevision: 1, expectedSpecRevision: 1, spec: newSpec('新根规格'), affectedTaskIds: [], inFlightPolicy: 'request_stop', outputReuse: 'none', reason: '测试完整影响闭包' }, 140);
  assert.deepEqual(impact.downstreamTaskIds, ['t-down', 't-leaf']); assert.equal(impact.unrelatedTaskCount, 1);
  assert.equal(readResult(store, 'p1', 'down-old').eligibility, 'stale');
  const late = submitResult(store, { id: 'down-late', projectId: 'p1', taskId: 't-down', taskRevision: 1, attemptId: 'down-attempt', outcome: 'succeeded', summary: '迟到后继' }, 141);
  assert.equal(late.eligibility, 'stale');
  for (const id of ['root', 'child', 'leaf']) assert.equal(store.db.prepare('SELECT state FROM outbox WHERE id=?').get(id).state, 'cancelled');
  for (const id of ['unrelated', 'message']) assert.equal(store.db.prepare('SELECT state FROM outbox WHERE id=?').get(id).state, 'pending');
  assert.equal(store.db.prepare("SELECT state FROM outbox WHERE id='sent'").get().state, 'uncertain');
  assert.deepEqual(store.db.prepare('SELECT attempt_id FROM native_control_requests ORDER BY attempt_id').all().map(row => row.attempt_id), ['at-1', 'down-attempt']);
  assert.equal(store.db.prepare("SELECT state FROM attempts WHERE id='down-attempt'").get().state, 'running');
  assert.throws(() => store.db.exec('DELETE FROM task_revision_impacts'), /IMMUTABLE/);
  store.close(); const reopened = open();
  assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM task_revision_impacts').get().n, 2);
  assert.equal(reopened.db.prepare("SELECT state FROM tasks WHERE id='t-leaf'").get().state, 'blocked');
  reopened.db.exec("UPDATE attempts SET state='succeeded',ended_at=150 WHERE id='down-attempt'; UPDATE results SET eligibility='current' WHERE id='down-late'");
  assert.throws(() => decideAcceptance(reopened, { id: 'do-not-bypass', projectId: 'p1', resultId: 'down-late', decision: 'accept', reviewerPrincipalId: 'user-1', evidence: [{ ok: 1 }], rule: { mode: 'user' }, principal: { id: 'user-1', kind: 'authenticated_user' } }, 151), /TASK_SPEC_REVALIDATION_REQUIRED/);
  const down = reopened.db.prepare("SELECT revision,spec_revision FROM tasks WHERE id='t-down'").get();
  reviseTaskSpec(reopened, { projectId: 'p1', taskId: 't-down', expectedRevision: down.revision, expectedSpecRevision: down.spec_revision,
    spec: { ...newSpec('后继按新前置重核'), dependencies: [{ prerequisiteId: 't-pre', requiredRevision: 2, condition: 'accepted' }] }, affectedTaskIds: [], inFlightPolicy: 'finish_stale', outputReuse: 'none', reason: '后继新规格' }, 152);
  assert.equal(reopened.db.prepare("SELECT state FROM tasks WHERE id='t-down'").get().state, 'draft');
  assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM task_revision_impacts i JOIN tasks t ON t.id=i.task_id AND t.project_id=i.project_id AND t.spec_revision=i.task_spec_revision WHERE t.id='t-down'").get().n, 0);
  assert.equal(reopened.db.prepare("SELECT state FROM tasks WHERE id='t-leaf'").get().state, 'blocked');
});

test('014升级015保留旧项目及任务，不猜填过去的影响记录', t => {
  const stores = []; const dir = temporaryDirectory(t, 'projectorch-impact-migration-', () => { for (const store of stores) if (!store.closed) store.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const old = openStore(filename, { migrations: defaultMigrations().slice(0, 14) }); stores.push(old);
  createProject(old, { id: 'p', name: 'old', hostId: 'h', canonicalRoot: dir, objective: '保留' }, 100);
  createTask(old, { id: 'original', projectId: 'p', goal: '原任务' }, 101); old.close();
  const upgraded = openStore(filename); stores.push(upgraded);
  assert.ok(upgraded.db.prepare('PRAGMA user_version').get().user_version >= 15, '015已应用（后续迁移共存）');
  assert.equal(upgraded.db.prepare("SELECT goal FROM tasks WHERE id='original'").get().goal, '原任务');
  assert.equal(upgraded.db.prepare('SELECT COUNT(*) AS n FROM task_revision_impacts').get().n, 0);
  assert.equal(upgraded.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('显式声明的非依赖影响保持待重核，后续修订不能将尚未解决的影响误报为无关', t => {
  const { store } = fixture(t);
  const input = { projectId: 'p1', taskId: 't-pre', expectedRevision: 1, expectedSpecRevision: 1, spec: newSpec('新要求'), affectedTaskIds: ['t-unrelated'], inFlightPolicy: 'finish_stale', outputReuse: 'none', reason: '用户声明额外影响' };
  reviseTaskSpec(store, input, 140);
  assert.equal(evaluateStartConditions(store, 'p1', 't-unrelated').ready, false);
  reviseTaskSpec(store, { ...input, expectedRevision: 2, expectedSpecRevision: 2, affectedTaskIds: [] }, 141);
  const analysis = analyzeSpecImpact(store, { projectId: 'p1', taskId: 't-pre' }, 142);
  assert.ok(analysis.downstream.some(task => task.taskId === 't-unrelated'));
  assert.ok(!analysis.unrelatedTasks.some(task => task.taskId === 't-unrelated'));
});

test('实体状态版本与规格快照独立；ready后修订写spec=2而不是实体revision=3', t => {
  const { store } = fixture(t);
  createTask(store, { id: 'versioned', projectId: 'p1', goal: '初始规格' }, 131);
  const initial = store.db.prepare("SELECT revision,spec_revision FROM tasks WHERE id='versioned'").get();
  assert.equal(initial.revision, 1); assert.equal(initial.spec_revision, 1);
  markTaskReady(store, 'p1', 'versioned', 132);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM task_revisions WHERE task_id='versioned'").get().n, 1);
  const changed = reviseTaskSpec(store, { projectId: 'p1', taskId: 'versioned', expectedRevision: 2, expectedSpecRevision: 1, spec: newSpec('第二规格'), affectedTaskIds: [], inFlightPolicy: 'finish_stale', outputReuse: 'none', reason: '新规格' }, 140);
  assert.equal(changed.revision, 3); assert.equal(changed.specRevision, 2);
  const snapshot = store.db.prepare("SELECT snapshot_json FROM task_revisions WHERE task_id='versioned' AND revision=2").get();
  assert.equal(JSON.parse(snapshot.snapshot_json).goal, '第二规格');
  assert.equal(store.db.prepare("SELECT 1 FROM task_revisions WHERE task_id='versioned' AND revision=3").get(), undefined);
});

test('unknown停止请求重启后仍待核对；不能通过重验证重派或通过修订依赖引入环', t => {
  const { store, open } = fixture(t);
  store.db.exec("UPDATE attempts SET state='unknown',native_execution_id='synthetic-turn' WHERE id='at-1'");
  const input = { projectId: 'p1', taskId: 't-pre', expectedRevision: 1, expectedSpecRevision: 1, spec: newSpec('请求停止'), affectedTaskIds: [], inFlightPolicy: 'request_stop', outputReuse: 'none', reason: '需要核对' };
  assert.throws(() => reviseTaskSpec(store, { ...input, spec: { ...input.spec, dependencies: [{ prerequisiteId: 't-down', requiredRevision: 1, condition: 'accepted' }] } }, 135), /TASK_CYCLE_REJECTED/);
  assert.equal(store.db.prepare("SELECT spec_revision FROM tasks WHERE id='t-pre'").get().spec_revision, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM native_control_requests').get().n, 0);
  reviseTaskSpec(store, input, 140);
  store.close(); const reopened = open();
  const request = reopened.db.prepare("SELECT * FROM native_control_requests WHERE attempt_id='at-1'").get();
  assert.equal(request.state, 'pending'); assert.equal(request.expected_native_execution_id, 'synthetic-turn');
  assert.equal(reopened.db.prepare("SELECT state FROM attempts WHERE id='at-1'").get().state, 'unknown');
  assert.throws(() => requestRevalidate(reopened, { projectId: 'p1', taskId: 't-pre', bindingId: 'b1', bindingEpoch: 1, attemptId: 'do-not-repeat' }, 150), /REVALIDATE_ATTEMPT_ACTIVE/);
});

test('A052：计划影响分析——旧成果保留、新缺口明确、无关工作可继续', t => {
  const { store } = fixture(t);
  const impact = reviseTaskSpec(store, {
    projectId: 'p1', taskId: 't-pre', expectedRevision: 1, expectedSpecRevision: 1,
    spec: newSpec('新要求：按新模板输出'), affectedTaskIds: ['t-down'], inFlightPolicy: 'request_stop', outputReuse: 'none', reason: '原端新要求',
  }, 140);
  assert.equal(impact.specRevision, 2, 'specRevision递增');
  assert.deepEqual(impact.staleResultIds, ['res-old'], '旧成果stale但保留');
  assert.equal(readResult(store, 'p1', 'res-old').summary, '旧规格成果', '旧成果历史可读');
  assert.deepEqual(impact.interruptedAttemptIds, [], '请求不能伪报停止终态');
  assert.deepEqual(impact.stopRequestedAttemptIds, ['at-1']);
  assert.equal(store.db.prepare("SELECT state FROM attempts WHERE id='at-1'").get().state, 'running');
  assert.equal(store.db.prepare("SELECT state FROM native_control_requests WHERE attempt_id='at-1'").get().state, 'pending');
  assert.deepEqual(impact.downstreamTaskIds, ['t-down'], '下游受影响清单');
  assert.equal(impact.newAcceptanceGap.length, 1, '新验收缺口明确');
  assert.equal(impact.planRevision, 1, '计划版本推进');
  // 无关工作可继续：无关任务状态与版本原样
  const analysis = analyzeSpecImpact(store, { projectId: 'p1', taskId: 't-pre' }, 150);
  assert.equal(analysis.staleResults.length, 1);
  assert.equal(analysis.unrelatedTasks.find(u => u.taskId === 't-unrelated')?.state, 'draft', '无关任务不受影响');
  // 不得自动降低验收标准：新规格验收规则少于旧规格→显式拒绝
  assert.throws(() => reviseTaskSpec(store, {
    projectId: 'p1', taskId: 't-pre', expectedRevision: 2, expectedSpecRevision: 2,
    spec: { ...newSpec('降低验收'), acceptance: [] }, affectedTaskIds: [], inFlightPolicy: 'finish_stale', outputReuse: 'none', reason: '试图削弱',
  }, 160), /SPEC_ACCEPTANCE_WEAKENED/, '验收弱化显式拒绝');
});

test('A087：规格修订与迟到结果——旧结果不释放新依赖；新结果按新规格生成后再裁决', t => {
  const { store } = fixture(t);
  // 建立旧成果accepted（下游依赖以accepted为条件）：
  const oldRev = store.db.prepare("SELECT revision,spec_revision FROM tasks WHERE id='t-pre'").get();
  void oldRev;
  // 下游在旧成果current时未激活（condition=accepted但未裁决）；修订后旧结果stale更不释放
  reviseTaskSpec(store, {
    projectId: 'p1', taskId: 't-pre', expectedRevision: 1, expectedSpecRevision: 1,
    spec: newSpec('修订后规格'), affectedTaskIds: ['t-down'], inFlightPolicy: 'request_stop', outputReuse: 'none', reason: '规格修订',
  }, 140);
  assert.equal(readResult(store, 'p1', 'res-old').eligibility, 'stale', '旧结果自动stale');
  // 旧结果不释放新依赖：下游仍不ready
  const downstream = evaluateStartConditions(store, 'p1', 't-down');
  assert.equal(downstream.ready, false, '旧成果不释放新依赖');
  // 迟到结果（旧revision）：落库即stale（历史保留、不释放新依赖、不可裁决）
  const late = submitResult(store, { id: 'res-late', projectId: 'p1', taskId: 't-pre', taskRevision: 1, attemptId: 'at-1', outcome: 'succeeded', summary: '迟到结果' }, 150);
  assert.equal(late.eligibility, 'stale', '迟到结果落库即stale');
  // result.revalidate：按新规格建受控重验证尝试
  const request = { projectId: 'p1', taskId: 't-pre', bindingId: 'b1', bindingEpoch: 1, attemptId: 'at-rv' };
  assert.throws(() => requestRevalidate(store, request, 160), /REVALIDATE_ATTEMPT_ACTIVE/);
  store.db.prepare("UPDATE attempts SET state='interrupted',ended_at=161 WHERE id='at-1'").run(); // 合成权威终态，非真实Harness验收
  const revalidated = requestRevalidate(store, request, 162);
  assert.equal(revalidated.taskRevision, 2, '重验证绑定新规格revision');
  assert.equal(store.db.prepare("SELECT execution_kind FROM attempts WHERE id='at-rv'").get().execution_kind, 'revalidation');
  // 新检查生成新结果后才裁决：新结果按新revision提交并accept
  const newResult = submitResult(store, { id: 'res-new', projectId: 'p1', taskId: 't-pre', taskRevision: 2, attemptId: 'at-rv', outcome: 'succeeded', summary: '新规格成果' }, 170);
  assert.equal(newResult.eligibility, 'current', '新结果current');
  store.db.prepare("UPDATE attempts SET state='succeeded',ended_at=175 WHERE id='at-rv'").run();
  const accepted = decideAcceptance(store, { id: 'acc-new', projectId: 'p1', resultId: 'res-new', decision: 'accept', reviewerPrincipalId: 'user-1', evidence: [{ review: '按新规格复核' }], rule: { mode: 'user' }, principal: { id: 'user-1', kind: 'authenticated_user' } }, 180);
  assert.equal(accepted.decision, 'accept', '新结果按新规格裁决');
  // 旧结果裁决拒绝（stale不可accept）
  assert.throws(() => decideAcceptance(store, { id: 'acc-old', projectId: 'p1', resultId: 'res-old', decision: 'accept', reviewerPrincipalId: 'user-1', evidence: [{ ok: 1 }], rule: { mode: 'user' }, principal: { id: 'user-1', kind: 'authenticated_user' } }, 190), /ACCEPTANCE_REQUIRES_CURRENT|STALE_SPEC/, '旧结果不可再裁决');
});

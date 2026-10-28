import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { hostname } from 'node:os';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { parseContract } from '../../../packages/contracts/dist/index.js';
import { createProjectForUser } from '../../../apps/kernel/dist/commands/project-create.js';
import { issuePairingChallenge } from '../../../apps/kernel/dist/auth/pairing.js';
import { startLocalGateway } from '../../../apps/kernel/dist/http/local-gateway.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

async function fixture(t) {
  let gateway;
  t.after(async () => { if (gateway) await gateway.close(); });
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-user-changesets-', () => { for (const s of stores) s.close(); });
  const store = openStore(path.join(dir, 'state.sqlite')); stores.push(store);
  const policy = { id: 'test', revision: 0, profiles: [{ id: 'reader', revision: 2, actions: ['identity', 'task.read'], readPaths: ['results/*'], writePaths: [], roleIds: [], delegableActions: [], maxDelegationDepth: 0 }], limits: { totalConcurrency: 1, roleConcurrency: 1, maxAttempts: 2, maxCorrectionTurns: 1, maxManagementRounds: 2, maxDynamicRoles: 0, wallTimeMs: 10000, costCeiling: null, costEnforcement: 'unavailable' }, nativeMode: 'disabled', writeIsolation: 'exclusive_workspace' };
  const created = createProjectForUser(store, 'test-user', hostname(), { schemaVersion: 2, requestId: 'project', hostId: hostname(), name: '测试', rootPath: 'E:/synthetic/user-changesets', objective: '组件测试', initialPolicy: policy }, Date.now());
  const projectId = created.projectId;
  gateway = await startLocalGateway({ store, principalId: 'test-user' });
  const origin = gateway.origin.origin;
  const challenge = issuePairingChallenge(store);
  const pairingResponse = await fetch(origin + '/api/v1/pairing', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ schemaVersion: 2, requestId: 'pair-valid', challengeId: challenge.challengeId, oneTimeCode: challenge.oneTimeCode }) });
  assert.equal(pairingResponse.status, 200);
  const { csrfToken } = await pairingResponse.json();
  const headers = { Origin: origin, Cookie: pairingResponse.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json', 'x-projectorch-csrf': csrfToken };
  const post = async (body, custom = headers) => { const response = await fetch(origin + '/api/v1/changesets', { method: 'POST', headers: custom, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const get = async url => { const response = await fetch(origin + url, { headers }); return { status: response.status, body: await response.json() }; };
  const input = (requestId, operations, expectedPlanRevision = 0) => ({ schemaVersion: 2, requestId, projectId, expectedPlanRevision, reason: '用户管理测试', operations });
  return { store, projectId, headers, post, get, input, policy, origin, gateway };
}
const role = (id = 'role') => ({ type: 'role.create', localRef: id, name: '执行者', charter: '具体责任', scopePaths: ['results/*'], permissionProfileId: 'reader', permissionProfileRevision: 2 });
const spec = { goal: '实现一个明确任务', inputArtifacts: [], outputRequirements: [{ name: 'report', kind: 'report', description: '可复核报告' }], acceptance: [{ ruleId: 'review', mode: 'user', description: '用户复核' }], dependencies: [] };
const task = (id = 'task') => ({ type: 'task.create', localRef: id, assigneeLocalRef: 'role', spec });
const revise = (taskId = 'task', expectedRevision = 1, expectedSpecRevision = 1) => ({ type: 'task.spec.revise', taskId, expectedRevision, expectedSpecRevision, spec: { ...spec, goal: '按新目标工作' }, affectedTaskIds: [], inFlightPolicy: 'finish_stale', outputReuse: 'none', reason: '用户修改需求' });
const replaceDependencies = (taskId, expectedRevision, expectedSpecRevision, dependencies) => ({ type: 'task.dependencies.replace', taskId, expectedRevision, expectedSpecRevision, dependencies, affectedTaskIds: [], inFlightPolicy: 'finish_stale', reason: '用户明确改接前置规格' });

test('独立依赖替换复用修订：保留完整规格、显式版本、同册计划一次推进与重放', async t => {
  const f = await fixture(t);
  await f.post(f.input('create', [role(), task(), task('child')]));
  const original = (await f.get('/api/v1/tasks/child')).body.spec;
  const dependency = { taskId: 'task', requiredTaskRevision: 1, condition: 'artifact_available', outputName: 'report' };
  const payload = f.input('replace', [replaceDependencies('child', 1, 1, [dependency])], 1);
  const result = await f.post(payload); assert.equal(result.body.status, 'completed'); assert.deepEqual((await f.post(payload)).body, result.body);
  const child = (await f.get('/api/v1/tasks/child')).body;
  assert.equal(child.specRevision, 2); assert.equal(child.planRevision, 2); assert.deepEqual(child.spec, { ...original, dependencies: [dependency] });
  const stale = await f.post(f.input('stale-deps', [replaceDependencies('child', 1, 1, [])], 2)); assert.equal(stale.body.status, 'failed');
  assert.equal(f.store.db.prepare('SELECT plan_revision FROM projects').get().plan_revision, 2);
});

test('批内先建后替换依赖按序读取完整规格；环、缺规格、跨项目和部分失败整册拒绝', async t => {
  const f = await fixture(t);
  const dependency = { taskId: 'task', requiredTaskRevision: 1, condition: 'accepted' };
  const result = await f.post(f.input('create-replace', [role(), task(), task('child'), replaceDependencies('child', 1, 1, [dependency])]));
  assert.equal(result.body.status, 'completed'); assert.equal(f.store.db.prepare('SELECT plan_revision FROM projects').get().plan_revision, 1);
  for (const [name, dependencies] of [['cycle', [{ taskId: 'child', requiredTaskRevision: 2, condition: 'accepted' }]], ['missing', [{ taskId: 'task', requiredTaskRevision: 99, condition: 'accepted' }]], ['foreign', [{ taskId: 'foreign-task', requiredTaskRevision: 1, condition: 'accepted' }]]]) {
    const response = await f.post(f.input(name, [replaceDependencies('task', 1, 1, dependencies)], 1)); assert.equal(response.body.status, 'failed', name);
    assert.equal(f.store.db.prepare("SELECT spec_revision FROM tasks WHERE id='task'").get().spec_revision, 1);
  }
  const rollback = await f.post(f.input('replace-rollback', [replaceDependencies('child', 2, 2, []), { type: 'task.assign', taskId: 'missing', expectedRevision: 1, roleId: 'role' }], 1));
  assert.equal(rollback.body.status, 'failed'); assert.equal((await f.get('/api/v1/tasks/child')).body.spec.dependencies.length, 1);
});

test('阻塞快照使用固定合同/真实规格影响与未结束尝试，认证及参数边界独立验证', async t => {
  const f = await fixture(t);
  await f.post(f.input('create', [role(), task(), { ...task('child'), spec: { ...spec, dependencies: [{ taskId: 'task', requiredTaskRevision: 1, condition: 'accepted' }] } }]));
  const response = await f.get('/api/v1/tasks/child/readiness'); assert.equal(response.status, 200); parseContract('task-readiness', response.body);
  assert.equal(response.body.dependencyReady, false); assert.equal(response.body.blocks[0].reason, 'PREREQ_NOT_ACCEPTED');
  await f.post(f.input('revise', [revise()], 1));
  const changed = (await f.get('/api/v1/tasks/child/readiness')).body;
  assert.ok(changed.blocks.some(block => block.reason === 'TASK_SPEC_REVALIDATION_REQUIRED'));
  assert.ok(changed.blocks.some(block => block.reason === 'PREREQ_SPEC_MISMATCH' && block.currentRevision === 2));
  assert.equal(changed.revision, 2); assert.equal(changed.specRevision, 1); assert.equal(changed.planRevision, 2);
  f.store.db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('readiness-session','synthetic','h','p','synthetic')").run();
  f.store.db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('readiness-binding',?,'role','readiness-session',1,100)").run(f.projectId);
  f.store.db.prepare("INSERT INTO attempts(id,project_id,task_id,task_revision,binding_id,binding_epoch,state,started_at) VALUES('readiness-attempt',?,'child',1,'readiness-binding',1,'unknown',100)").run(f.projectId);
  f.store.db.prepare('UPDATE projects SET user_paused=1 WHERE id=?').run(f.projectId);
  const paused = (await f.get('/api/v1/tasks/child/readiness')).body; assert.equal(paused.userPaused, true); assert.equal(paused.unresolvedAttempts[0].state, 'unknown');
  const anonymous = await fetch(f.origin + '/api/v1/tasks/child/readiness', { headers: { Origin: f.origin } }); assert.equal(anonymous.status, 401);
  assert.equal((await f.get('/api/v1/tasks/missing/readiness')).status, 404);
  assert.equal((await f.get('/api/v1/tasks/child/readiness?roleId=other')).status, 400);
});

test('HTTP规格修订保存完整快照、一次推进计划版本、重放及旧版本冲突，遗漏后继仍纳入闭包', async t => {
  const f = await fixture(t);
  const child = id => ({ ...task(id), spec: { ...spec, dependencies: [{ taskId: id === 'child' ? 'task' : 'child', requiredTaskRevision: 1, condition: 'accepted' }] } });
  assert.equal((await f.post(f.input('create', [role(), task(), child('child'), child('leaf'), task('independent')]))).body.status, 'completed');
  const payload = f.input('revise', [revise()], 1);
  const response = await f.post(payload); assert.equal(response.status, 202); assert.equal(response.body.status, 'completed');
  assert.deepEqual((await f.post(payload)).body, response.body);
  const detail = (await f.get('/api/v1/tasks/task')).body; assert.equal(detail.specRevision, 2); assert.equal(detail.revision, 2);
  assert.equal(detail.planRevision, 2); assert.deepEqual(detail.spec, revise().spec);
  assert.equal(f.store.db.prepare('SELECT plan_revision FROM projects').get().plan_revision, 2);
  assert.deepEqual(f.store.db.prepare("SELECT task_id FROM task_revision_impacts ORDER BY task_id").all().map(r => r.task_id), ['child', 'leaf']);
  assert.equal(f.store.db.prepare("SELECT state FROM tasks WHERE id='child'").get().state, 'blocked');
  assert.equal(f.store.db.prepare("SELECT state FROM tasks WHERE id='leaf'").get().state, 'blocked');
  assert.equal(f.store.db.prepare("SELECT revision FROM tasks WHERE id='independent'").get().revision, 1);
  const old = await f.post(f.input('stale-revision', [revise()], 2)); assert.equal(old.body.status, 'failed'); assert.equal(old.body.error.code, 'REVISION_CONFLICT');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM task_revisions WHERE task_id='task'").get().n, 2);
});

test('规格修订引用、环、削弱规则、跨项目影响和批内失败均拒绝且不留下部分修订', async t => {
  const f = await fixture(t); await f.post(f.input('create', [role(), task()]));
  for (const [name, operation] of [
    ['input', { ...revise(), spec: { ...spec, inputArtifacts: [{ artifactId: 'missing', version: 'v1' }] } }],
    ['reviewer', { ...revise(), spec: { ...spec, acceptance: [{ ruleId: 'review', mode: 'designated_reviewer', reviewerRoleId: 'other-project-role', independent: true, description: '指定复核' }] } }],
    ['check', { ...revise(), spec: { ...spec, acceptance: [{ ruleId: 'check', mode: 'automated_check', checkDefinitionId: 'missing', checkVersion: 'v1', description: '检查' }] } }],
    ['cycle', { ...revise(), spec: { ...spec, dependencies: [{ taskId: 'task', requiredTaskRevision: 1, condition: 'accepted' }] } }],
    ['weaken', { ...revise(), spec: { ...spec, acceptance: [] } }],
    ['foreign-impact', { ...revise(), affectedTaskIds: ['foreign-task'] }],
  ]) {
    const response = await f.post(f.input(`bad-${name}`, [operation], 1));
    assert.ok(response.status >= 400 || response.body.status === 'failed', name);
    assert.equal(f.store.db.prepare("SELECT spec_revision FROM tasks WHERE id='task'").get().spec_revision, 1);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM task_revision_impacts').get().n, 0);
  }
  const result = await f.post(f.input('batch-rollback', [revise(), { type: 'task.assign', taskId: 'missing', expectedRevision: 1, roleId: 'role' }], 1));
  assert.equal(result.body.status, 'failed');
  assert.equal(f.store.db.prepare("SELECT spec_revision FROM tasks WHERE id='task'").get().spec_revision, 1);
  assert.equal(f.store.db.prepare('SELECT plan_revision FROM projects').get().plan_revision, 1);
});

test('用户修订最终审计失败时回滚完整规格、影响表、后继状态、Outbox取消和幂等记录', async t => {
  const f = await fixture(t);
  await f.post(f.input('create', [role(), task(), { ...task('child'), spec: { ...spec, dependencies: [{ taskId: 'task', requiredTaskRevision: 1, condition: 'accepted' }] } }]));
  const pending = f.store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state='pending'").get().n;
  f.store.db.exec("CREATE TRIGGER reject_spec_audit BEFORE INSERT ON events WHEN NEW.type='changeset.applied' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_SPEC_AUDIT'); END");
  assert.equal((await f.post(f.input('rollback-spec', [revise()], 1))).status, 422);
  assert.equal(f.store.db.prepare("SELECT spec_revision FROM tasks WHERE id='task'").get().spec_revision, 1);
  assert.equal(f.store.db.prepare("SELECT state FROM tasks WHERE id='child'").get().state, 'draft');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM task_revision_impacts').get().n, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state='pending'").get().n, pending);
  assert.equal(f.store.db.prepare("SELECT 1 FROM commands WHERE request_id='rollback-spec'").get(), undefined);
});

test('用户HTTP变更→角色/完整任务→事件/固定回执；重放、查询和失败回执持久', async t => {
  const { store, projectId, post, get, input } = await fixture(t);
  const payload = input('create', [role(), task()]);
  const response = await post(payload);
  assert.equal(response.status, 202); assert.equal(response.body.status, 'completed');
  parseContract('receipt', response.body);
  assert.equal(response.body.entityIds.length, 2);
  assert.deepEqual((await post(payload)).body, response.body);
  assert.equal((await get(response.body.receiptUrl)).body.commandId, response.body.commandId);
  assert.deepEqual((await get('/api/v1/receipts/create')).body, response.body);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='changeset.applied'").get().n, 1);
  const detail = await get('/api/v1/tasks/task'); assert.equal(detail.status, 200);
  parseContract('task-detail', detail.body); assert.deepEqual(detail.body.spec, spec); assert.equal(detail.body.planRevision, 1);
  assert.equal((await get(`/api/v1/projects/${projectId}/policy`)).body.profiles[0].revision, 2);
  const snapshot = JSON.parse(store.db.prepare("SELECT snapshot_json FROM role_revisions WHERE role_id='role' AND revision=1").get().snapshot_json);
  assert.equal(snapshot.permissionProfileRevision, 2); assert.deepEqual(snapshot.scopePaths, ['results/*']);
  const stale = input('stale', [{ type: 'task.assign', taskId: 'task', roleId: 'role', expectedRevision: 1 }], 0);
  const failure = await post(stale); assert.equal(failure.status, 202); assert.equal(failure.body.status, 'failed');
  assert.equal(failure.body.error.code, 'REVISION_CONFLICT');
  assert.deepEqual((await post(stale)).body, failure.body);
  assert.deepEqual((await get(failure.body.receiptUrl)).body, failure.body);
  assert.equal((await post({ ...payload, reason: '同键异内容' })).status, 409);
});

test('用户写接口拒绝CSRF/恶意来源、未知档案/版本/越界范围及未支持操作，不留下半个请求', async t => {
  const { store, headers, post, input } = await fixture(t);
  const before = store.db.prepare('SELECT COUNT(*) AS n FROM commands').get().n;
  const payload = input('denied', [role()]);
  assert.equal((await post(payload, { ...headers, 'x-projectorch-csrf': 'wrong' })).status, 401);
  assert.equal((await post(payload, { ...headers, Origin: 'https://evil.invalid' })).status, 403);
  for (const operation of [{ ...role(), permissionProfileRevision: 1 }, { ...role(), permissionProfileId: 'unknown' }, { ...role(), scopePaths: ['private/*'] }, { type: 'plan.revise', objective: 'new', affectedTaskIds: [], rationale: 'test' }]) {
    const result = await post(input('invalid', [operation]));
    assert.ok([403, 409, 501].includes(result.status));
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM commands').get().n, before);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM roles').get().n, 0);
});

test('事件写入失败回滚角色/任务/变更/命令；用户暂停时仍能管理角色，但不声称已原生停止', async t => {
  const { store, projectId, post, input } = await fixture(t);
  store.db.exec("CREATE TRIGGER fail_user_changes_event BEFORE INSERT ON events WHEN NEW.type='changeset.applied' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_EVENT_FAILURE'); END");
  assert.equal((await post(input('rollback', [role(), task()]))).status, 422);
  for (const table of ['roles', 'tasks', 'changesets']) assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  assert.equal(store.db.prepare("SELECT 1 FROM commands WHERE request_id='rollback'").get(), undefined);
  store.db.exec('DROP TRIGGER fail_user_changes_event');
  store.db.prepare('UPDATE projects SET user_paused=1 WHERE id=?').run(projectId);
  assert.equal((await post(input('rollback', [role(), task()]))).body.status, 'completed');
  const result = await post(input('pause-role', [{ type: 'role.pause', roleId: 'role', expectedRevision: 1, reason: '暂停', currentWorkPolicy: 'finish' }], 1));
  assert.equal(result.body.status, 'completed');
  const row = store.db.prepare("SELECT desired_state,binding_state FROM roles WHERE id='role'").get();
  assert.equal(row.desired_state, 'paused'); assert.equal(row.binding_state, 'unbound');
  assert.equal(store.db.prepare('SELECT user_paused FROM projects WHERE id=?').get(projectId).user_paused, 1);
});

test('任务分页符合合同、无漏项，变更后旧游标及跨项目游标拒绝，回执来源隔离', async t => {
  const { store, projectId, post, get, input, policy } = await fixture(t);
  assert.equal((await post(input('tasks', [role(), task('a'), task('b'), task('c')]))).body.status, 'completed');
  const first = await get(`/api/v1/projects/${projectId}/tasks?limit=1`);
  assert.equal(first.status, 200); assert.equal(first.body.items.length, 1); assert.ok(first.body.nextCursor);
  const second = await get(`/api/v1/projects/${projectId}/tasks?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`);
  assert.equal(second.body.items[0].id, 'b'); parseContract('task-detail', second.body.items[0]);
  await post(input('more', [task('d')], 1));
  assert.equal((await get(`/api/v1/projects/${projectId}/tasks?cursor=${encodeURIComponent(first.body.nextCursor)}`)).status, 409);
  const other = createProjectForUser(store, 'test-user', hostname(), { schemaVersion: 2, requestId: 'other-project', hostId: hostname(), name: '另一个项目', rootPath: 'E:/synthetic/user-changesets-other', objective: '隔离', initialPolicy: policy }, Date.now());
  const currentPage = await get(`/api/v1/projects/${projectId}/tasks?limit=1`);
  assert.equal((await get(`/api/v1/projects/${other.projectId}/tasks?cursor=${encodeURIComponent(currentPage.body.nextCursor)}`)).status, 409, '有效游标也不能跨项目');
  store.db.exec("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,receipt_json,created_at) SELECT 'foreign',project_id,'other-user','foreign',request_hash,type,payload_json,'completed',json_set(receipt_json,'$.commandId','foreign','$.requestId','foreign','$.receiptUrl','/api/v1/commands/foreign/receipt'),100 FROM commands WHERE request_id='tasks'");
  assert.equal((await get('/api/v1/commands/foreign/receipt')).status, 404);
  assert.equal((await get('/api/v1/tasks/missing')).status, 404);
  assert.equal((await get(`/api/v1/projects/${projectId}/tasks?limit=0`)).status, 409);
});

test('角色档案修改保存所选版本与快照；已绑定角色配置变化须等待重新接入能力', async t => {
  const { store, projectId, post, input } = await fixture(t);
  await post(input('role-only', [role()]));
  const update = { type: 'role.update', roleId: 'role', expectedRevision: 1, charter: '修订职责', permissionProfileId: 'reader', permissionProfileRevision: 2 };
  assert.equal((await post(input('update', [update], 1))).body.status, 'completed');
  const snapshot = JSON.parse(store.db.prepare("SELECT snapshot_json FROM role_revisions WHERE role_id='role' AND revision=2").get().snapshot_json);
  assert.equal(snapshot.permissionProfileRevision, 2); assert.deepEqual(snapshot.scopePaths, ['results/*']);
  store.transaction(db => {
    db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('synthetic-session','synthetic','host','test','test')").run();
    db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('synthetic-binding',?,'role','synthetic-session',1,100)").run(projectId);
  });
  assert.equal((await post(input('bound-update', [{ ...update, expectedRevision: 2, charter: '不能静默忽略的新版职责' }], 2))).status, 501);
  assert.equal(store.db.prepare("SELECT charter FROM roles WHERE id='role'").get().charter, '修订职责');
});

test('请求体尚未读完时撤销浏览器会话，实际写入前重验并拒绝', { timeout: 10000 }, async t => {
  const { store, headers, input, origin, gateway } = await fixture(t);
  const body = JSON.stringify(input('delayed', [role()]));
  const seen = once(gateway.server, 'request');
  let request;
  const result = new Promise((resolve, reject) => {
    request = httpRequest(origin + '/api/v1/changesets', { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
    request.once('error', reject); request.write(body.slice(0, 10));
  });
  await seen;
  store.db.prepare('UPDATE browser_sessions SET revoked_at=?').run(Date.now());
  request.end(body.slice(10));
  assert.equal(await result, 401);
  assert.equal(store.db.prepare("SELECT 1 FROM commands WHERE request_id='delayed'").get(), undefined);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM roles').get().n, 0);
});

test('变更集接受合同内的多字节长职责，超出1MiB请求仍在入库前拒绝', async t => {
  const { store, post, input } = await fixture(t);
  const response = await post(input('unicode', [{ ...role(), charter: '职责说明'.repeat(1500) }]));
  assert.equal(response.status, 202); assert.equal(response.body.status, 'completed');
  assert.equal(store.db.prepare("SELECT length(charter) AS n FROM roles WHERE id='role'").get().n, 6000);
  const oversized = await post(input('oversized', [{ ...role('too-big'), charter: 'x'.repeat(1024 * 1024 + 1) }], 1));
  assert.equal(oversized.status, 413);
  assert.equal(store.db.prepare("SELECT 1 FROM commands WHERE request_id='oversized'").get(), undefined);
});

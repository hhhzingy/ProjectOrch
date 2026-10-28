import {advanceReviewWorkflow} from '../../../apps/kernel/dist/execution/review-continuation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openStore, defaultMigrations } from '../../../packages/persistence/dist/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { createRole } from '../../../packages/domain/dist/roles/index.js';
import { createTaskWithin, evaluateStartConditions } from '../../../packages/domain/dist/tasks/index.js';
import { completeStartupAck } from '../../../packages/domain/dist/bootstrap/index.js';
import { registerWorkspace } from '../../../packages/domain/dist/workspaces/index.js';
import { reserveDispatch } from '../../../packages/domain/dist/dispatch-guard/index.js';
import { registerArtifact } from '../../../packages/domain/dist/artifacts/index.js';
import { registerGitArtifactWithin } from '../../../packages/domain/dist/artifacts/git.js';
import { submitResult } from '../../../packages/domain/dist/results/index.js';
import { issueAgentCredential, authenticateAgentCredential } from '../../../apps/kernel/dist/auth/agent-credential.js';
import { createToolDispatcher } from '../../../apps/kernel/dist/tools/gateway-tools.js';
import { createCommandRunner } from '../../../apps/kernel/dist/commands/index.js';
import { userCommandServices } from '../../../apps/kernel/dist/commands/user-review.js';
import { startApplication } from '../../../apps/kernel/dist/lifecycle/application.js';
import { issuePairingChallenge } from '../../../apps/kernel/dist/auth/pairing.js';
import { installSyntheticPolicy } from './synthetic-policy.mjs';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

const profile = { id: 'workflow', revision: 1, actions: ['identity', 'task.read', 'task.claim', 'task.report_own', 'task.submit_own', 'task.accept_assigned', 'artifact.read'], readPaths: ['tasks/*', 'results/*'], writePaths: ['tasks/*', 'results/*'], roleIds: [], delegableActions: [], maxDelegationDepth: 0 };
const rules = [{ ruleId: 'review-one', mode: 'designated_reviewer', reviewerRoleId: 'reviewer1', independent: true, description: '第一次独立复核' }, { ruleId: 'review-two', mode: 'designated_reviewer', reviewerRoleId: 'reviewer2', independent: true, description: '第二次独立复核' }];

function fixture(t, acceptanceRules = rules, outputRequirements = [{ name: 'report', kind: 'report', description: '完成报告' }], selectedProfile=profile) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-task-tools-', () => { for (const s of stores) s.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const open = () => { const s = openStore(filename); stores.push(s); return s; };
  const store = open();
  fs.mkdirSync(path.join(dir, 'results'));
  createProject(store, { id: 'p', name: 'synthetic', hostId: 'host', canonicalRoot: dir, objective: '工具组件回归，不是真实原生验收' }, 100);
  const principals = {};
  for (const roleId of ['worker', 'reviewer1', 'reviewer2']) {
    createRole(store, { id: roleId, projectId: 'p', name: roleId, charter: '明确职责', permissionProfileId: 'workflow' }, 101);
    store.transaction(db => {
      db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES(?,'synthetic','host','isolated',?)").run(roleId, `native-${roleId}`);
      db.prepare('INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES(?,?,?,?,1,100)').run(roleId, 'p', roleId, roleId);
      db.prepare("UPDATE roles SET binding_state='provisioning' WHERE id=?").run(roleId);
    });
    const credential = issueAgentCredential(store, roleId, 1, { isolation: 'verified_session', session: { harnessId: 'synthetic', hostId: 'host', profileId: 'isolated', nativeConversationId: `native-${roleId}` } }, 110, 60000).credential;
    principals[roleId] = authenticateAgentCredential(store, credential, 120);
  }
  installSyntheticPolicy(store, 'p', [selectedProfile]);
  const create = (id, dependencies = []) => store.transaction(db => createTaskWithin(db, { id, projectId: 'p', roleId: 'worker', goal: id, inputArtifacts: [], outputRequirements, acceptance: acceptanceRules, dependencies }, 130));
  create('task'); create('next', [{ prerequisiteId: 'task', requiredRevision: 1, condition: 'accepted' }]);
  for (const roleId of ['worker', 'reviewer1', 'reviewer2']) completeStartupAck(store, { projectId: 'p', roleId, bindingEpoch: 1, protocolVersion: 2, policyRevision: 0, planRevision: 0, roleRevision: 1, taskSpecRevisions: [{ taskId: 'task', specRevision: 1 }] }, 140);
  fs.mkdirSync(path.join(dir,'workspace'));
  registerWorkspace(store, { id: 'workspace', projectId: 'p', canonicalPath: path.join(dir, 'workspace'), enforcement: 'enforced' }, 145);
  reserveDispatch(store, { projectId: 'p', roleId: 'worker', bindingEpoch: 1, taskId: 'task', taskRevision: 1, workspaceId: 'workspace', attemptId: 'attempt' }, 150);
  store.db.exec("UPDATE attempts SET state='running',native_execution_id='execution-worker' WHERE id='attempt'");
  let currentTime=300;
  const dispatcher = (roleId, executionId = `execution-${roleId}`) => createToolDispatcher(store, { profileInput: selectedProfile, now: () => currentTime, callerNativeConversationId: `native-${roleId}`, ...(executionId ? { callerNativeExecutionId: executionId } : {}) });
  const call = (roleId, tool, args, executionId) => dispatcher(roleId, executionId)(principals[roleId], tool, args);
  const claim = { requestId: 'claim', taskId: 'task', expectedRevision: 1, expectedSpecRevision: 1 };
  const evidence = [];
  for (const n of [1, 2]) {
    const file = path.join(dir, 'results', `review-${n}.txt`); fs.writeFileSync(file, `synthetic review ${n}`);
    const bytes = fs.readFileSync(file); const hash = createHash('sha256').update(bytes).digest('hex');
    registerArtifact(store, { id: `evidence-${n}`, projectId: 'p', version: hash, pathRef: `results/review-${n}.txt`, sha256: hash, byteSize: bytes.length }, 160);
    evidence.push(file);
  }
  const outputFile = path.join(dir, 'results', 'output.txt'); fs.writeFileSync(outputFile, 'synthetic required report');
  const outputBytes = fs.readFileSync(outputFile), outputHash = createHash('sha256').update(outputBytes).digest('hex');
  registerArtifact(store, { id: 'report-output', projectId: 'p', taskId: 'task', taskRevision: 1, version: outputHash, pathRef: 'results/output.txt', sha256: outputHash, byteSize: outputBytes.length }, 160);
  const result = () => {
    store.db.exec("UPDATE attempts SET state='succeeded',ended_at=250 WHERE id='attempt'; UPDATE tasks SET state='review' WHERE id='task'");
    return submitResult(store, { id: 'result', projectId: 'p', taskId: 'task', taskRevision: 1, attemptId: 'attempt', outcome: 'succeeded', outputs: [{ outputName: 'report', artifactId: 'report-output', version: outputHash }], summary: 'synthetic success' }, 260);
  };
  return { store, open, filename, dir, principals, call, dispatcher, claim, create, result, evidence, outputFile, setNow:value=>{currentTime=value;} };
}
const accept = n => ({ requestId: `review-${n}`, taskId: 'task', taskRevision: 1, resultId: 'result', decision: 'accept', reason: '独立检查通过', evidenceArtifactIds: [`evidence-${n}`], ruleId: n === 1 ? 'review-one' : 'review-two' });

test('项目根不同于受管cwd：真实登记/content/提交/独立退回/原绑定修复/验收与负责人读裁决',t=>{
 const custom={...profile,actions:[...profile.actions,'artifact.register_own'],readPaths:[...profile.readPaths,'workspace/*'],writePaths:[...profile.writePaths,'workspace/*']};
 const f=fixture(t,[rules[0]],undefined,custom),ok=(role,tool,args,execution)=>{const r=f.call(role,tool,args,execution);assert.equal(r.ok,true,JSON.stringify(r));return r.payload;};
 const register=(name,text)=>{const bytes=Buffer.from(text);fs.writeFileSync(path.join(f.dir,'workspace',name),bytes);return ok('worker','artifact.register',{requestId:'register-'+name,taskId:'task',taskRevision:1,kind:'report',path:'workspace/'+name,sha256:createHash('sha256').update(bytes).digest('hex'),byteSize:bytes.length});};
 ok('worker','task.claim',f.claim);const first=register('v1.md','real v1 missing requirement');
 const content=ok('reviewer1','artifact.content',{artifactId:first.artifactId,version:first.version,offset:0});assert.equal(content.content,'real v1 missing requirement');
 const submit=(id,attempt,artifact,execution)=>ok('worker','task.submit_result',{requestId:id,taskId:'task',taskRevision:1,attemptId:attempt,bindingEpoch:1,outcome:'succeeded',outputs:[{outputName:'report',artifactId:artifact.artifactId,version:artifact.version}],summary:id,checks:[],remainingIssues:[]},execution);
 const v1=submit('v1-result','attempt',first);f.store.db.exec("UPDATE attempts SET state='succeeded',ended_at=301 WHERE id='attempt';UPDATE workspace_reservations SET state='released' WHERE task_id='task'");
 const reject=ok('reviewer1','task.accept',{...accept(1),requestId:'real-reject',resultId:v1.resultId,decision:'reject',reason:'actual missing requirement',evidenceArtifactIds:[first.artifactId]});
 const before=f.store.db.prepare('SELECT total_changes() n').get().n;
 const viewed=ok('reviewer2','result.read',{resultId:v1.resultId});assert.equal(viewed.decisions[0].decisionId,reject.decisionId);assert.deepEqual(viewed.decisions[0].reviewer,{kind:'bound_agent',roleId:'reviewer1'});assert.equal(viewed.decisions[0].reason,'actual missing requirement');assert.deepEqual(viewed.decisions[0].evidenceArtifactIds,[first.artifactId]);
 assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n,before,'result.read零业务副作用');
 assert.equal(advanceReviewWorkflow(f.store,301,10).reopened,1);
 const admission=reserveDispatch(f.store,{projectId:'p',roleId:'worker',bindingEpoch:1,taskId:'task',taskRevision:1,workspaceId:'workspace',attemptId:'attempt-v2'},302);assert.equal(admission.attemptId,'attempt-v2');
 f.store.db.exec("UPDATE attempts SET state='running',native_execution_id='execution-worker-v2' WHERE id='attempt-v2'");
 assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM attempts WHERE id='attempt-v2' AND state='running' AND native_execution_id='execution-worker-v2' AND binding_id='worker'").get().n,1,JSON.stringify(f.store.db.prepare('SELECT id,state,native_execution_id,binding_id FROM attempts').all()));
 f.setNow(304);
 const revision=f.store.db.prepare("SELECT revision FROM tasks WHERE id='task'").get().revision;
 ok('worker','task.claim',{requestId:'claim-v2',taskId:'task',expectedRevision:revision,expectedSpecRevision:1},'execution-worker-v2');
 const fixed=register('v2.md','real v2 satisfies requirement'),v2=submit('v2-result','attempt-v2',fixed,'execution-worker-v2');
 f.store.db.exec("UPDATE attempts SET state='succeeded',ended_at=303 WHERE id='attempt-v2'");
 const accepted=ok('reviewer1','task.accept',{...accept(1),requestId:'real-accept',resultId:v2.resultId,evidenceArtifactIds:[fixed.artifactId]});assert.equal(accepted.accepted,true);
 assert.equal(f.store.db.prepare("SELECT state FROM tasks WHERE id='task'").get().state,'accepted');assert.equal(fs.readFileSync(path.join(f.dir,'workspace/v1.md'),'utf8'),'real v1 missing requirement');
});

test('登记及提交验证项目相对实物：缺文件、错hash/size、漂移、同名其他工作区不误选',t=>{
 const custom={...profile,actions:[...profile.actions,'artifact.register_own'],readPaths:[...profile.readPaths,'workspace/*'],writePaths:[...profile.writePaths,'workspace/*','same.md']},f=fixture(t,[rules[0]],undefined,custom);
 assert.equal(f.call('worker','task.claim',f.claim).ok,true);const bytes=Buffer.from('actual'),hash=createHash('sha256').update(bytes).digest('hex');fs.writeFileSync(path.join(f.dir,'workspace/same.md'),bytes);
 const args={taskId:'task',taskRevision:1,kind:'report',path:'workspace/same.md',sha256:hash,byteSize:bytes.length};
 fs.mkdirSync(path.join(f.dir,'other-workspace'));fs.writeFileSync(path.join(f.dir,'other-workspace/ghost.md'),bytes);
 const ghost=f.call('worker','artifact.register',{...args,path:'workspace/ghost.md',requestId:'no-other-workspace-fallback'});assert.equal(ghost.payload.error,'ARTIFACT_FILE_MISSING_USE_PROJECT_RELATIVE_PATH');
 for(const [label,override]of [['short',{path:'same.md'}],['missing',{path:'workspace/missing.md'}],['hash',{sha256:'f'.repeat(64)}],['size',{byteSize:99}]]){const r=f.call('worker','artifact.register',{...args,...override,requestId:label});assert.equal(r.ok,false);assert.match(r.payload.error,/ARTIFACT_FILE_/);}
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM artifacts WHERE task_id=?').get('task').n,1,'仅fixture既有产物，失败登记回滚');
 const registered=f.call('worker','artifact.register',{...args,requestId:'good'});assert.equal(registered.ok,true,JSON.stringify(registered));fs.writeFileSync(path.join(f.dir,'workspace/same.md'),'changed');
 const result=f.call('worker','task.submit_result',{requestId:'drift-submit',taskId:'task',taskRevision:1,attemptId:'attempt',bindingEpoch:1,outcome:'succeeded',outputs:[{outputName:'report',artifactId:registered.payload.artifactId,version:registered.payload.version}],summary:'drift',checks:[],remainingIssues:[]});assert.equal(result.ok,false);assert.equal(result.payload.error,'ARTIFACT_FILE_HASH_OR_SIZE_MISMATCH');assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM results').get().n,0);
});

const userRules = [{ ruleId: 'user-review', mode: 'user', description: '用户核对成果' }];
test('junction真实路径先授权：登记和复用旧引用提交拒绝且无残留，同范围普通文件仍可提交',t=>{
 const allowed=['tasks/*','results/link/file.txt','results/allowed.txt'],custom={...profile,actions:[...profile.actions,'artifact.register_own'],readPaths:allowed,writePaths:allowed};
 const f=fixture(t,[rules[0]],undefined,custom);assert.equal(f.call('worker','task.claim',f.claim).ok,true);
 fs.mkdirSync(path.join(f.dir,'private'));const bytes=Buffer.from('restricted bytes'),hash=createHash('sha256').update(bytes).digest('hex'),link=path.join(f.dir,'results/link');fs.writeFileSync(path.join(f.dir,'private/file.txt'),bytes);fs.symlinkSync(path.join(f.dir,'private'),link,'junction');
 const totals=()=>Object.fromEntries(['artifacts','results','commands','agent_command_scopes','events','outbox'].map(table=>[table,f.store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));
 try{
  const args={taskId:'task',taskRevision:1,kind:'report',path:'results/link/file.txt',sha256:hash,byteSize:bytes.length},before=totals();
  const denied=f.call('worker','artifact.register',{...args,requestId:'junction-register'});assert.equal(denied.ok,false);assert.equal(denied.payload.error,'FORBIDDEN');assert.deepEqual(totals(),before);
  registerArtifact(f.store,{id:'legacy-link',projectId:'p',taskId:'task',taskRevision:1,version:hash,pathRef:args.path,sha256:hash,byteSize:bytes.length},290);
  const submit=(requestId,artifactId,version)=>f.call('worker','task.submit_result',{requestId,taskId:'task',taskRevision:1,attemptId:'attempt',bindingEpoch:1,outcome:'succeeded',outputs:[{outputName:'report',artifactId,version}],summary:'scope check',checks:[],remainingIssues:[]});
  const beforeSubmit=totals(),rejected=submit('junction-submit','legacy-link',hash);assert.equal(rejected.ok,false);assert.equal(rejected.payload.error,'FORBIDDEN');assert.deepEqual(totals(),beforeSubmit);
  fs.writeFileSync(path.join(f.dir,'results/allowed.txt'),bytes);const good=f.call('worker','artifact.register',{...args,path:'results/allowed.txt',requestId:'allowed-register'});assert.equal(good.ok,true,JSON.stringify(good));assert.equal(submit('allowed-submit',good.payload.artifactId,good.payload.version).ok,true);
 }finally{fs.unlinkSync(link);}
});
const userCommand = (requestId = 'user-review', overrides = {}) => ({ schemaVersion: 2, requestId, projectId: 'p', type: 'task.accept', payload: { ...accept(1), ruleId: 'user-review', ...overrides } });
function userInput(requestId = 'user-review', overrides = {}) { const command = userCommand(requestId, overrides); delete command.payload.requestId; return command; }

test('标准应用已配对用户通过HTTP裁决，身份由会话固定，回执幂等且后继同事务激活', async t => {
  let runtime; t.after(async () => { if (runtime) await runtime.stop(); });
  const f = fixture(t, userRules); f.result();
  assert.equal(f.call('worker', 'task.accept', { requestId: 'agent-user-rule', ...userInput().payload }).payload.error, 'UNTRUSTED_USER', 'Agent仍不能代用户验收');
  runtime = await startApplication(f.dir);
  const origin = runtime.gateway.origin.origin;
  const challenge = issuePairingChallenge(runtime.store);
  const paired = await fetch(origin + '/api/v1/pairing', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ schemaVersion: 2, requestId: 'pair', challengeId: challenge.challengeId, oneTimeCode: challenge.oneTimeCode }) });
  assert.equal(paired.status, 200);
  const { csrfToken } = await paired.json();
  const headers = { Origin: origin, Cookie: paired.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json', 'x-projectorch-csrf': csrfToken };
  const post = async (body, custom = headers) => { const response = await fetch(origin + '/api/v1/commands', { method: 'POST', headers: custom, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const read = await fetch(origin + '/api/v1/tasks/task/review', { headers });
  assert.equal(read.status, 200); const review = await read.json();
  assert.equal(review.results[0].summary, 'synthetic success'); assert.equal(review.artifacts.length, 3);
  const evidenceVersion = String(f.store.db.prepare("SELECT version FROM artifacts WHERE id='evidence-1'").get().version);
  const contentUrl = `/api/v1/artifacts/evidence-1/content?version=${evidenceVersion}&offset=0`;
  const contentResponse = await fetch(origin + contentUrl, { headers }); assert.equal(contentResponse.status, 200);
  assert.deepEqual(await contentResponse.json(), { artifactId: 'evidence-1', version: evidenceVersion, offset: 0, content: 'synthetic review 1', encoding: 'utf8', nextOffset: null, sha256: evidenceVersion });
  assert.equal((await fetch(origin + contentUrl, { headers: { Origin: origin } })).status, 401);
  for (const suffix of ['&path=private/key', '&offset=1', '&version=other']) assert.equal((await fetch(origin + contentUrl + suffix, { headers })).status, 400);
  assert.equal((await fetch(origin + '/api/v1/artifacts/evidence-1/content?version=wrong&offset=0', { headers })).status, 409);
  assert.equal((await fetch(origin + '/api/v1/artifacts/evidence-1/content?version=x&offset=1e2', { headers })).status, 400);
  const noCsrf = { ...headers }; delete noCsrf['x-projectorch-csrf'];
  assert.equal((await post(userInput(), noCsrf)).status, 401);
  assert.equal((await post(userInput('spoof', { reviewerPrincipalId: 'worker' }))).status, 400);
  const decisionInput = userInput('user-review', { reason: '核对'.repeat(2000) });
  const accepted = await post(decisionInput); assert.equal(accepted.status, 200); assert.equal(accepted.body.status, 'completed');
  assert.deepEqual((await post(decisionInput)).body, accepted.body);
  assert.equal((await post(userInput('user-review', { reason: '不同意图' }))).status, 409);
  const source = f.store.db.prepare('SELECT source_principal_id FROM commands WHERE id=?').get(accepted.body.commandId).source_principal_id;
  assert.match(source, /^local-user-/);
  assert.equal(f.store.db.prepare('SELECT reviewer_principal_id FROM result_rule_decisions').get().reviewer_principal_id, source);
  assert.equal(f.store.db.prepare("SELECT state FROM tasks WHERE id='task'").get().state, 'accepted');
  assert.equal(f.store.db.prepare("SELECT state FROM tasks WHERE id='next'").get().state, 'ready');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM result_rule_decisions').get().n, 1);
  const intents = f.store.db.prepare('SELECT payload_json FROM outbox WHERE command_id=?').all(accepted.body.commandId).map(row => JSON.parse(row.payload_json));
  assert.equal(intents.filter(item => item.event === 'workflow.evaluate' && item.taskId === 'next').length, 1);
  fs.appendFileSync(f.evidence[0], ' changed after acceptance');
  assert.equal((await fetch(origin + contentUrl, { headers })).status, 409, '返回内容前重新核对，不用元数据缓存充当原始内容');
});

test('用户验收拒绝过期/未知执行/证据漂移，失败不残留命令裁决或后继', t => {
  for (const scenario of ['spec', 'unknown', 'evidence']) {
    const f = fixture(t, userRules); f.result();
    if (scenario === 'spec') f.store.db.exec("UPDATE tasks SET spec_revision=2 WHERE id='task'");
    if (scenario === 'unknown') f.store.db.exec("UPDATE attempts SET state='unknown',ended_at=NULL WHERE id='attempt'");
    if (scenario === 'evidence') fs.appendFileSync(f.evidence[0], 'changed');
    const run = createCommandRunner(f.store, userCommandServices(f.store, () => 300));
    assert.throws(() => run('synthetic-user', userInput()), /STALE_SPEC|RESULT_NOT_CURRENT|RESULT_EXECUTION_NOT_CONFIRMED|ACCEPTANCE_EVIDENCE_CONTENT_CHANGED/);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM commands').get().n, 0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM result_rule_decisions').get().n, 0);
    assert.equal(f.store.db.prepare("SELECT state FROM tasks WHERE id='next'").get().state, 'draft');
  }
});

test('用户不能冒充指定复核者；多规则最后用户裁决重核前序证据并整体回滚', t => {
  const f = fixture(t, [rules[0], ...userRules]); f.result();
  const run = createCommandRunner(f.store, userCommandServices(f.store, () => 300));
  assert.throws(() => run('synthetic-user', userInput('wrong-reviewer', { ruleId: 'review-one' })), /WRONG_REVIEWER/);
  assert.equal(f.call('reviewer1', 'task.accept', accept(1)).ok, true);
  fs.appendFileSync(f.evidence[0], 'drift after review');
  assert.throws(() => run('synthetic-user', userInput('last-review', { evidenceArtifactIds: ['evidence-2'] })), /ACCEPTANCE_PRIOR_EVIDENCE_CHANGED/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM result_rule_decisions').get().n, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM acceptances').get().n, 0);
  assert.equal(f.store.db.prepare("SELECT state FROM tasks WHERE id='next'").get().state, 'draft');
});

test('用户可在暂停时保存验收而不启动后继；事件失败回滚整个用户裁决', t => {
  const f = fixture(t, userRules); f.result();
  const run = createCommandRunner(f.store, userCommandServices(f.store, () => 300));
  f.store.db.exec("CREATE TRIGGER synthetic_user_review_failure BEFORE INSERT ON events WHEN NEW.type='task.accepted' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_REVIEW_FAILURE'); END");
  assert.throws(() => run('synthetic-user', userInput()), /SYNTHETIC_REVIEW_FAILURE/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM result_rule_decisions').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM acceptances').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM commands').get().n, 0);
  f.store.db.exec("DROP TRIGGER synthetic_user_review_failure; UPDATE projects SET user_paused=1 WHERE id='p'");
  assert.equal(run('synthetic-user', userInput()).status, 'completed');
  assert.equal(f.store.db.prepare("SELECT state FROM tasks WHERE id='task'").get().state, 'accepted');
  assert.equal(f.store.db.prepare("SELECT state FROM tasks WHERE id='next'").get().state, 'draft');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0);
});

test('最终验收要求具名输出完整且来源/版本/内容匹配，不能只凭复核证据通过', t => {
  for (const scenario of ['missing', 'duplicate', 'version', 'source', 'content']) {
    const f = fixture(t, userRules); f.result();
    const outputs = JSON.parse(f.store.db.prepare("SELECT outputs_json FROM results WHERE id='result'").get().outputs_json);
    if (scenario === 'missing') outputs.length = 0;
    if (scenario === 'duplicate') outputs.push({ ...outputs[0] });
    if (scenario === 'version') outputs[0].version = 'f'.repeat(64);
    if (scenario === 'source') { outputs[0].artifactId = 'evidence-1'; outputs[0].version = f.store.db.prepare("SELECT version FROM artifacts WHERE id='evidence-1'").get().version; }
    if (scenario === 'content') fs.appendFileSync(f.outputFile, 'changed after submission');
    f.store.db.prepare("UPDATE results SET outputs_json=? WHERE id='result'").run(JSON.stringify(outputs));
    const run = createCommandRunner(f.store, userCommandServices(f.store, () => 300));
    assert.throws(() => run('synthetic-user', userInput()), /ACCEPTANCE_OUTPUT/, scenario);
    for (const table of ['commands', 'result_rule_decisions', 'acceptances', 'outbox']) assert.equal(f.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, `${scenario}:${table}`);
    assert.equal(f.store.db.prepare("SELECT state FROM tasks WHERE id='next'").get().state, 'draft');
  }
});

test('真实Git输出可进入用户验收；裸提交、缺对象及类型替换不能激活后继', t => {
  for (const scenario of ['valid', 'legacy', 'missing-blob', 'wrong-kind']) {
    const f = fixture(t, userRules, [{ name: 'report', kind: 'git_commit', description: '已核对提交' }]);
    const repo = path.join(f.dir, 'repo'); fs.mkdirSync(repo);
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-b', 'main'); git('config', 'user.name', 'Synthetic'); git('config', 'user.email', 'synthetic@projectorch.invalid');
    fs.writeFileSync(path.join(repo, 'report.txt'), 'synthetic Git output'); git('add', '.'); git('commit', '-m', 'synthetic output');
    const head = git('rev-parse', 'HEAD');
    if (scenario === 'legacy') registerArtifact(f.store, { id: 'git-output', projectId: 'p', taskId: 'task', taskRevision: 1, version: head, pathRef: `git:${head}` }, 220);
    else f.store.transaction(() => registerGitArtifactWithin(f.store, { id: 'git-output', projectId: 'p', taskId: 'task', taskRevision: 1, repositoryPath: 'repo', revision: head }, 220));
    let output = { outputName: 'report', artifactId: 'git-output', version: head };
    if (scenario === 'wrong-kind') output = { outputName: 'report', artifactId: 'report-output', version: String(f.store.db.prepare("SELECT version FROM artifacts WHERE id='report-output'").get().version) };
    f.store.db.exec("UPDATE attempts SET state='succeeded',ended_at=250 WHERE id='attempt'; UPDATE tasks SET state='review' WHERE id='task'");
    submitResult(f.store, { id: 'result', projectId: 'p', taskId: 'task', taskRevision: 1, attemptId: 'attempt', outcome: 'succeeded', outputs: [output], summary: 'synthetic native completion and actual Git objects' }, 260);
    if (scenario === 'missing-blob') { const blob = git('rev-parse', 'HEAD:report.txt'); fs.unlinkSync(path.join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2))); }
    const run = createCommandRunner(f.store, userCommandServices(f.store, () => 300));
    if (scenario === 'valid') {
      assert.equal(run('synthetic-user', userInput()).status, 'completed');
      assert.equal(f.store.db.prepare("SELECT state FROM tasks WHERE id='next'").get().state, 'ready');
      assert.equal(git('rev-parse', 'HEAD'), head);
    } else {
      assert.throws(() => run('synthetic-user', userInput()), /CAPABILITY_UNSUPPORTED|GIT_READ_FAILED|ACCEPTANCE_OUTPUT_KIND_MISMATCH/, scenario);
      assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM result_rule_decisions').get().n, 0);
      assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM acceptances').get().n, 0);
      assert.equal(f.store.db.prepare("SELECT state FROM tasks WHERE id='next'").get().state, 'draft');
    }
  }
});

test('任务领取精确承接同执行/目录占位，幂等重放含原attempt，不创建额外执行', t => {
  const { store, call, claim } = fixture(t);
  assert.equal(call('reviewer1', 'task.claim', claim).payload.error, 'TASK_NOT_OWNED');
  assert.equal(call('worker', 'task.claim', claim, 'other-execution').payload.error, 'TASK_EXECUTION_NOT_CURRENT');
  const first = call('worker', 'task.claim', claim); assert.equal(first.ok, true); assert.equal(first.payload.attemptId, 'attempt');
  const replay = call('worker', 'task.claim', claim); assert.equal(replay.payload.attemptId, 'attempt'); assert.equal(replay.payload.commandId, first.payload.commandId);
  assert.equal(store.db.prepare("SELECT state FROM tasks WHERE id='task'").get().state, 'active');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, 1);
  assert.equal(call('worker', 'task.claim', { ...claim, requestId: 'other-claim' }).payload.error, 'TASK_REVISION_CONFLICT');
});

test('领取拒绝过期握手、disabled模式、无目录占位、未确认运行和未知执行', t => {
  for (const scenario of ['ack', 'policy', 'workspace', 'dispatching', 'unknown']) {
    const { store, call, claim } = fixture(t);
    if (scenario === 'ack') store.db.exec("UPDATE projects SET plan_revision=1 WHERE id='p'");
    if (scenario === 'policy') store.db.exec("UPDATE projects SET policy_json=json_set(policy_json,'$.nativeMode','disabled') WHERE id='p'");
    if (scenario === 'workspace') store.db.exec("UPDATE workspace_reservations SET state='unknown' WHERE task_id='task'");
    if (['dispatching', 'unknown'].includes(scenario)) store.db.prepare("UPDATE attempts SET state=? WHERE id='attempt'").run(scenario);
    assert.equal(call('worker', 'task.claim', claim).ok, false, scenario);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM commands').get().n, 0, scenario);
  }
});

test('进展与具体等待持久；无真实满足事实不能解阻，不能冒充原生终态', t => {
  const { store, call, claim, open, create, dir } = fixture(t);
  create('wait-target');
  assert.equal(call('worker', 'task.claim', claim).ok, true);
  const payload = { requestId: 'progress', taskId: 'task', attemptId: 'attempt', bindingEpoch: 1, report: '等待后续确认', wait: { target: { kind: 'task', taskId: 'wait-target', taskRevision: 1 }, deadline: new Date(10000).toISOString(), onTimeout: 'raise_issue', taskRevision: 1, attemptId: 'attempt', bindingEpoch: 1 } };
  assert.equal(call('worker', 'task.report', payload).ok, true);
  assert.equal(call('worker', 'task.report', payload).ok, true);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM task_reports').get().n, 1);
  assert.equal(store.db.prepare("SELECT state FROM attempts WHERE id='attempt'").get().state, 'running');
  assert.equal(call('worker', 'task.report', { ...payload, requestId: 'unresolved', wait: null }).payload.error, 'WAIT_UNRESOLVED');
  assert.equal(call('worker', 'task.report', { ...payload, requestId: 'old-turn' }, 'old-turn').payload.error, 'TASK_EXECUTION_NOT_CURRENT');
  const second = open(); assert.equal(second.db.prepare("SELECT state FROM tasks WHERE id='task'").get().state, 'waiting');
  store.db.exec("INSERT INTO attempts(id,project_id,task_id,task_revision,binding_id,binding_epoch,state,started_at) VALUES('target-attempt','p','wait-target',1,'worker',1,'succeeded',200)");
  const targetBytes = fs.readFileSync(path.join(dir, 'results', 'output.txt'));
  const targetHash = createHash('sha256').update(targetBytes).digest('hex');
  registerArtifact(store, { id: 'target-output', projectId: 'p', taskId: 'wait-target', taskRevision: 1, version: targetHash, pathRef: 'results/output.txt', sha256: targetHash, byteSize: targetBytes.length }, 240);
  submitResult(store, { id: 'target-result', projectId: 'p', taskId: 'wait-target', taskRevision: 1, attemptId: 'target-attempt', outcome: 'succeeded', outputs: [{ artifactId: 'target-output', outputName: 'report', version: targetHash }], summary: '合成目标完成' }, 250);
  for (const n of [1, 2]) assert.equal(call(`reviewer${n}`, 'task.accept', { ...accept(n), requestId: `target-review-${n}`, taskId: 'wait-target', resultId: 'target-result' }).ok, true);
  store.db.exec("UPDATE attempts SET state='unknown' WHERE id='target-attempt'");
  assert.equal(call('worker', 'task.report', { ...payload, requestId: 'target-became-unknown', wait: null }).payload.error, 'WAIT_UNRESOLVED');
  store.db.exec("UPDATE attempts SET state='succeeded' WHERE id='target-attempt'");
  assert.equal(call('worker', 'task.report', { ...payload, requestId: 'resolved', wait: null }).ok, true);
  assert.equal(store.db.prepare("SELECT state FROM tasks WHERE id='task'").get().state, 'active');
  assert.equal(store.db.prepare("SELECT state FROM attempts WHERE id='attempt'").get().state, 'running');
});

test('任务命令重放仍核对当前路径范围，收窄范围后不返回旧成功回执', t => {
  const { store, call, claim } = fixture(t);
  const first = call('worker', 'task.claim', claim);
  assert.equal(first.ok, true);
  store.db.prepare("UPDATE roles SET scope_paths_json='[\"tasks/other\"]' WHERE id='worker'").run();
  assert.equal(call('worker', 'task.claim', claim).payload.error, 'FORBIDDEN:PATH_OUT_OF_SCOPE');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM agent_command_scopes').get().n, 1);
});

test('等待拒绝自环/多跳环，记录与命令一起回滚', t => {
  const { store, call, claim, principals } = fixture(t);
  call('worker', 'task.claim', claim);
  const payload = { requestId: 'cycle', taskId: 'task', attemptId: 'attempt', bindingEpoch: 1, report: '不能互等', wait: { target: { kind: 'task', taskId: 'task', taskRevision: 1 }, deadline: new Date(10000).toISOString(), onTimeout: 'raise_issue', taskRevision: 1, attemptId: 'attempt', bindingEpoch: 1 } };
  assert.equal(call('worker', 'task.report', payload).payload.error, 'WAIT_DEADLOCK');
  store.db.exec("INSERT INTO attempts(id,project_id,task_id,task_revision,binding_id,binding_epoch,state,started_at) VALUES('other-attempt','p','next',1,'worker',1,'running',200); INSERT INTO waits(id,project_id,task_id,task_revision,attempt_id,binding_id,binding_epoch,target_json,deadline,on_timeout,state) VALUES('other-wait','p','next',1,'other-attempt','worker',1,'{\"kind\":\"task\",\"taskId\":\"task\",\"taskRevision\":1}',10000,'raise_issue','waiting')");
  assert.equal(call('worker', 'task.report', { ...payload, wait: { ...payload.wait, target: { kind: 'task', taskId: 'next', taskRevision: 1 } } }).payload.error, 'WAIT_DEADLOCK');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM task_reports').get().n, 0);
  const commandScopes = store.db.prepare('SELECT command_id,credential_id FROM agent_command_scopes WHERE project_id=? AND role_id=?').all(principals.worker.projectId, principals.worker.roleId);
  assert.equal(commandScopes.length, 1, '仅原认领命令，失败回报没有留下命令或来源映射');
  assert.equal(commandScopes[0].credential_id, principals.worker.credentialId);
  assert.equal(store.db.prepare('SELECT type FROM commands WHERE id=?').get(commandScopes[0].command_id).type, 'task.claim');
});

test('多规则分别授权、独立性核验，全部通过才accepted并登记后继候选；重放不重复激活', t => {
  const { store, call, result } = fixture(t); result();
  assert.equal(call('worker', 'task.accept', accept(1)).ok, false);
  assert.equal(call('reviewer2', 'task.accept', accept(1)).ok, false);
  const first = call('reviewer1', 'task.accept', accept(1)); assert.equal(first.ok, true); assert.equal(first.payload.accepted, false);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM acceptances').get().n, 0);
  assert.equal(evaluateStartConditions(store, 'p', 'next').ready, false);
  const second = call('reviewer2', 'task.accept', accept(2)); assert.equal(second.ok, true); assert.equal(second.payload.accepted, true);
  assert.equal(store.db.prepare("SELECT state FROM tasks WHERE id='next'").get().state, 'ready');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM acceptances WHERE decision='accept'").get().n, 1);
  assert.equal(call('reviewer2', 'task.accept', accept(2)).payload.commandId, second.payload.commandId);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 1);
  const candidate = JSON.parse(store.db.prepare('SELECT payload_json FROM outbox').get().payload_json);
  assert.equal(candidate.schemaVersion, 2); assert.equal(candidate.taskId, 'next'); assert.equal(candidate.taskRevision, 2); assert.equal(candidate.specRevision, 1);
});

test('证据文件缺失/漂移/范围拒绝；最后一条验收重核前序证据并原子回滚', t => {
  const { store, call, result, evidence } = fixture(t); result();
  assert.equal(call('reviewer1', 'task.accept', accept(1)).ok, true);
  fs.writeFileSync(evidence[0], 'changed after first review');
  const final = call('reviewer2', 'task.accept', accept(2)); assert.equal(final.payload.error, 'ACCEPTANCE_PRIOR_EVIDENCE_CHANGED');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM result_rule_decisions').get().n, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM acceptances').get().n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0);
  fs.unlinkSync(evidence[1]);
  assert.equal(call('reviewer2', 'task.accept', accept(2)).payload.error, 'ACCEPTANCE_EVIDENCE_CONTENT_CHANGED');
});

test('规则裁决与后继事件/Outbox全部同事务；注入失败不留下半次验收', t => {
  const { store, call, result } = fixture(t); result();
  call('reviewer1', 'task.accept', accept(1));
  store.db.exec("CREATE TRIGGER workflow_fail BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'WORKFLOW_INJECTED'); END");
  assert.equal(call('reviewer2', 'task.accept', accept(2)).ok, false);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM result_rule_decisions').get().n, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM acceptances').get().n, 0);
  assert.equal(store.db.prepare("SELECT state FROM tasks WHERE id='next'").get().state, 'draft');
  store.db.exec('DROP TRIGGER workflow_fail');
  assert.equal(call('reviewer2', 'task.accept', accept(2)).payload.accepted, true);
});

test('用户规则不能由Agent批准，独立复核拒绝执行者，成功文字不替代原生终态', t => {
  const { store, call, result } = fixture(t); result();
  store.db.prepare("UPDATE tasks SET acceptance_json=? WHERE id='task'").run(JSON.stringify([{ ruleId: 'review-one', mode: 'user', description: '必须用户批准' }]));
  assert.equal(call('reviewer1', 'task.accept', accept(1)).payload.error, 'UNTRUSTED_USER');
  store.db.prepare("UPDATE tasks SET acceptance_json=? WHERE id='task'").run(JSON.stringify([{ ...rules[0], reviewerRoleId: 'worker' }]));
  assert.equal(call('worker', 'task.accept', accept(1)).payload.error, 'SELF_REVIEW');
  store.db.prepare("UPDATE tasks SET acceptance_json=? WHERE id='task'").run(JSON.stringify(rules));
  store.db.exec("UPDATE attempts SET state='unknown' WHERE id='attempt'");
  assert.equal(call('reviewer1', 'task.accept', accept(1)).payload.error, 'RESULT_EXECUTION_NOT_CONFIRMED');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM result_rule_decisions').get().n, 0);
  registerArtifact(store, { id: 'private-evidence', projectId: 'p', version: 'v1', pathRef: 'private/check.txt', sha256: 'a'.repeat(64) }, 290);
  assert.equal(call('reviewer1', 'task.accept', { ...accept(1), evidenceArtifactIds: ['private-evidence'] }).payload.error, 'ACCEPTANCE_EVIDENCE_FORBIDDEN');
});

test('迁移9→10保留旧库、握手不猜填；数据升级备份存在', t => {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-workflow-upgrade-', () => { for (const s of stores) s.close(); });
  const file = path.join(dir, 'state.sqlite'); const old = openStore(file, { migrations: defaultMigrations().slice(0, 9) }); stores.push(old);
  createProject(old, { id: 'p', name: 'old', hostId: 'h', canonicalRoot: dir, objective: '旧记录' }, 100); old.close();
  const upgraded = openStore(file); stores.push(upgraded);
  assert.ok(fs.existsSync(upgraded.migrationBackup));
  assert.equal(upgraded.db.prepare('SELECT COUNT(*) AS n FROM role_startup_acks').get().n, 0);
  assert.equal(upgraded.db.prepare("SELECT objective FROM projects WHERE id='p'").get().objective, '旧记录');
});

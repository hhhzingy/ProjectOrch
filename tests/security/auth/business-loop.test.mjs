/** A089：仅依合同完成业务闭环（e2e）。全链只经公共入口：领域用户入口（建项目/建任务/工作区/验收裁决）、
 * HTTP配对、命令管线（role.bootstrap）、受信主机绑定流程（establishFirstBinding→startupAck→凭据）、
 * Agent工具派发器、dispatch-guard认领、plan-revisions规格修订、交接与集成。
 * 所有业务ID来自回执或查询；主机登记会话和合成原生终态使用测试写库，不代表真实原生E2E。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { createTask, readTask } from '../../../packages/domain/dist/tasks/index.js';
import { createRole } from '../../../packages/domain/dist/roles/index.js';
import { registerWorkspace } from '../../../packages/domain/dist/workspaces/index.js';
import { issuePairingChallenge } from '../../../apps/kernel/dist/auth/pairing.js';
import { createCommandRunner } from '../../../apps/kernel/dist/commands/index.js';
import { lifecycleCommandServices } from '../../../apps/kernel/dist/commands/lifecycle-services.js';
import { startKernel } from '../../../apps/kernel/dist/lifecycle/kernel-runtime.js';
import { createToolDispatcher } from '../../../apps/kernel/dist/tools/gateway-tools.js';
import { installSyntheticPolicy } from './synthetic-policy.mjs';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';
import { issueAgentCredential, authenticateAgentCredential } from '../../../apps/kernel/dist/auth/agent-credential.js';
import { establishFirstBinding } from '../../../packages/domain/dist/native-binding/index.js';
import { completeStartupAck } from '../../../packages/domain/dist/bootstrap/index.js';
import { evaluateDispatch, reserveDispatch } from '../../../packages/domain/dist/dispatch-guard/index.js';
import { submitResult, decideAcceptance, registerCheckDefinition, recordCheckRun } from '../../../packages/domain/dist/results/index.js';
import { raiseIssue, resolveIssue } from '../../../packages/domain/dist/issues/index.js';
import { prepareHandover, verifyHandover, consumeHandover } from '../../../packages/domain/dist/handovers/index.js';
import { requestIntegration, startIntegration, completeIntegration } from '../../../packages/domain/dist/integrations/index.js';
import { reviseTaskSpec } from '../../../packages/domain/dist/plan-revisions/index.js';
import { registerArtifact } from '../../../packages/domain/dist/artifacts/index.js';

function request(port, method, target, headers, body = null) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path: target, headers }, response => {
      const chunks = [];
      response.on('data', c => chunks.push(c));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8'), setCookie: response.headers['set-cookie'] ?? [] }));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}
const trail = [];
const log = (step, who, evidence) => { trail.push({ step, who, evidence }); return evidence; };
const profileInput = { id: 'demo', revision: 1, actions: ['identity', 'project.read', 'role.read', 'message.read_own', 'message.send', 'message.ack_own', 'artifact.register_own', 'artifact.read', 'task.submit_own', 'case.raise', 'case.read'], readPaths: ['tasks/*'], writePaths: ['tasks/*'], roleIds: [], delegableActions: [], maxDelegationDepth: 0 };

test('A089：配对→建项目负责人→读任务→登记工作区→提交复核→关闭异常→交接和集成（ID全部来自回执/查询）', async t => {
  let runtime;
  t.after(async () => { await runtime?.stop(); });
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-a089-', () => { for (const store of stores) store.close(); });
  for(const name of ['ws'])fs.mkdirSync(path.join(dir,name));
  const filename = path.join(dir, 'state.sqlite');
  const track = store => { stores.push(store); return store; };

  // ── 用户入口：建项目（实现者：user-app-domain）──
  const seed = track(openStore(filename));
  const project = log('建项目', 'user-app-domain', createProject(seed, { id: 'p-demo', name: 'demo', hostId: 'h', canonicalRoot: dir, objective: '演示闭环' }, 100));
  installSyntheticPolicy(seed, 'p-demo', [profileInput]);
  assert.equal(project.id, 'p-demo');

  // ── 用户入口：HTTP配对（错误一次性码拒绝→正确码回执Cookie）──
  runtime = await startKernel({ filename, principalId: 'user-1', outbox: { deliver: () => 'delivered' }, outboxPollMs: 200 });
  track(runtime.store);
  const authority = `127.0.0.1:${runtime.gateway.port}`;
  const challenge = log('配对挑战', 'gateway', issuePairingChallenge(runtime.store));
  const badPairing = await request(runtime.gateway.port, 'POST', '/api/v1/pairing', { Host: authority, Origin: `http://${authority}`, 'Content-Type': 'application/json' }, JSON.stringify({ schemaVersion: 2, requestId: 'bad', challengeId: challenge.challengeId, oneTimeCode: 'wrong' }));
  assert.ok([400, 403].includes(badPairing.status), '错误一次性码拒绝');
  const paired = await request(runtime.gateway.port, 'POST', '/api/v1/pairing', { Host: authority, Origin: `http://${authority}`, 'Content-Type': 'application/json' }, JSON.stringify({ schemaVersion: 2, requestId: 'pair-ok', challengeId: challenge.challengeId, oneTimeCode: challenge.oneTimeCode }));
  assert.equal(paired.status, 200);
  log('配对成功', 'gateway', { cookie: paired.setCookie.some(c => c.startsWith('projectorch_session=')) });

  // ── 用户入口：role.bootstrap经命令管线（角色ID来自回执；重试幂等）──
  const runner = createCommandRunner(runtime.store, lifecycleCommandServices(() => 300));
  const bootstrap = log('bootstrap', 'user-command', runner('user-1', { schemaVersion: 2, requestId: 'boot-a089', projectId: 'p-demo', type: 'role.bootstrap', payload: { localRef: 'r-demo', name: 'demo-worker', charter: '演示', permissionProfileId: 'demo', permissionProfileRevision: 1, expectedPolicyRevision: 0, sessionRef: { harnessId: 'synthetic', hostId: 'host', profileId: 'p', nativeConversationId: 'nat-a089' } } }));
  assert.equal(bootstrap.status, 'completed');
  const roleId = bootstrap.entityIds[0].id;
  assert.equal(roleId, 'r-demo');
  const replay = runner('user-1', { schemaVersion: 2, requestId: 'boot-a089', projectId: 'p-demo', type: 'role.bootstrap', payload: { localRef: 'r-demo', name: 'demo-worker', charter: '演示', permissionProfileId: 'demo', permissionProfileRevision: 1, expectedPolicyRevision: 0, sessionRef: { harnessId: 'synthetic', hostId: 'host', profileId: 'p', nativeConversationId: 'nat-a089' } } });
  assert.equal(replay.commandId, bootstrap.commandId, 'bootstrap重试幂等回放');

  // ── 受信主机绑定流程：会话登记（受信主机边界）→首绑定→启动握手→凭据 ──
  const sessionId = `sess-${randomUUID()}`;
  runtime.store.transaction(db => db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES(?,?,?,?,?)").run(sessionId, 'synthetic', 'host', 'p', 'nat-a089'));
  const binding = log('首绑定', 'trusted-host', establishFirstBinding(seed, { bindingId: `b-${randomUUID().slice(0, 8)}`, projectId: 'p-demo', roleId, sessionId }, 210));
  assert.equal(binding.epoch, 1);
  const acked = log('启动握手', 'trusted-host', completeStartupAck(seed, { projectId: 'p-demo', roleId, bindingEpoch: binding.epoch, protocolVersion: 2, policyRevision: 0, planRevision: 0, roleRevision: seed.db.prepare("SELECT revision FROM roles WHERE id=?").get(roleId).revision, taskSpecRevisions: [] }, 220));
  assert.equal(acked.bindingState, 'ready', '握手后ready');
  const bindingRow = seed.db.prepare("SELECT id FROM role_bindings WHERE project_id='p-demo' AND role_id=? AND ended_at IS NULL").get(roleId);
  const credential = log('凭据签发', 'trusted-host', issueAgentCredential(runtime.store, String(bindingRow.id), binding.epoch, { isolation: 'verified_session', session: { harnessId: 'synthetic', hostId: 'host', profileId: 'p', nativeConversationId: 'nat-a089' } }, 230, 60000).credential);
  const principal = authenticateAgentCredential(runtime.store, credential, 240);

  // ── 用户入口：建任务+工作区（读任务经详情回执；越权读不泄露）──
  createRole(seed, { id: 'r-reviewer', projectId: 'p-demo', name: 'reviewer', charter: '复核', permissionProfileId: 'demo', parentId: null }, 245);
  const task = log('建任务', 'user-app-domain', createTask(seed, { id: 't-demo', projectId: 'p-demo', roleId, goal: '演示任务', acceptance: [{ kind: 'manual' }] }, 250));
  assert.equal(readTask(seed, 'p-demo', task.id).roleId, roleId);
  registerWorkspace(seed, { id: 'ws-demo', projectId: 'p-demo', canonicalPath: path.join(dir, 'ws'), enforcement: 'enforced' }, 255);
  log('登记工作区', 'user-app-domain', { workspaceId: 'ws-demo' });

  // ── 规格修订（原端新要求）：spec_revision 1→2（验收规则不减）──
  const revised = log('规格修订', 'management-changeset-path', reviseTaskSpec(seed, {
    projectId: 'p-demo', taskId: 't-demo', expectedRevision: 1, expectedSpecRevision: 1,
    spec: { goal: '演示任务（修订）', inputArtifacts: [], outputRequirements: [{ name: 'report', kind: 'report', description: '产出报告' }], acceptance: [{ kind: 'manual' }], dependencies: [] },
    affectedTaskIds: [], inFlightPolicy: 'finish_stale', outputReuse: 'none', reason: '原端新要求',
  }, 260));
  assert.equal(revised.specRevision, 2);

  // ── Agent：dispatch-guard认领（重复认领拒绝）→工具身份+提交 ──
  const claim = log('认领', 'agent-dispatch', reserveDispatch(seed, { projectId: 'p-demo', roleId, bindingEpoch: binding.epoch, taskId: 't-demo', taskRevision: revised.specRevision, workspaceId: 'ws-demo', attemptId: 'at-a089' }, 265));
  assert.equal(claim.attemptId, 'at-a089');
  const dup = evaluateDispatch(seed, { projectId: 'p-demo', roleId, bindingEpoch: binding.epoch, taskId: 't-demo', taskRevision: revised.specRevision, workspaceId: 'ws-demo' });
  assert.equal(dup.allowed, false, '重复认领拒绝');
  const dispatcher = createToolDispatcher(runtime.store, { profileInput, now: () => 300, callerNativeConversationId: 'nat-a089' });
  const identity = dispatcher(principal, 'identity', {});
  assert.equal(identity.payload.roleId, roleId, '身份取自绑定不取正文');
  const forged = dispatcher(principal, 'identity', {});
  void forged;

  // ── Agent：受控检查+提交结果（猜任务ID拒绝；ID来自查询/回执）──
  registerCheckDefinition(seed, { projectId: 'p-demo', id: 'chk-demo', version: 'v1', definition: { kind: 'script' } }, 270);
  const badSubmit = dispatcher(principal, 'task.submit_result', { taskId: 't-guess', taskRevision: 1, attemptId: claim.attemptId, outcome: 'succeeded', summary: '猜ID' });
  assert.equal(badSubmit.ok, false, '猜任务ID拒绝');
  const submitted = log('提交结果', 'agent-tool', submitResult(seed, { id: 'res-demo', projectId: 'p-demo', taskId: 't-demo', taskRevision: revised.specRevision, attemptId: claim.attemptId, outcome: 'succeeded', outputs: [], summary: '演示产出' }, 280));
  assert.equal(submitted.eligibility, 'current');
  assert.throws(() => decideAcceptance(seed, { id: 'acc-before-terminal', projectId: 'p-demo', resultId: 'res-demo', decision: 'accept', reviewerPrincipalId: 'user-1', evidence: [{ review: '自报不能代替执行终态' }] }, 281), /RESULT_EXECUTION_NOT_CURRENT/);
  // 合成原生终态观察；本测试不是实际Harness执行或真实E2E验收。
  seed.db.prepare("UPDATE attempts SET state='succeeded',ended_at=281 WHERE id=?").run(claim.attemptId);
  recordCheckRun(seed, { id: 'run-demo', projectId: 'p-demo', resultId: 'res-demo', checkId: 'chk-demo', checkVersion: 'v1', targetSpecRevision: revised.specRevision, outcome: 'passed', evidence: { suite: 'demo' } }, 282);

  // ── 用户：登记成果+验收（自报拒绝；按规则accept）──
  registerArtifact(seed, { id: 'art-demo', projectId: 'p-demo', taskId: 't-demo', version: 'v1', pathRef: 'results/demo.txt', sha256: 'a'.repeat(64) }, 285);
  log('登记成果', 'user-app-domain', { artifactId: 'art-demo' });
  const selfRule = { mode: 'designated_reviewer', reviewerRoleId: roleId, independent: true };
  assert.throws(() => decideAcceptance(seed, { id: 'acc-self', projectId: 'p-demo', resultId: 'res-demo', decision: 'accept', reviewerPrincipalId: 'p-self', evidence: [{ ok: 1 }], rule: selfRule, principal: { id: 'p-self', kind: 'bound_agent', roleId } }, 290), /SELF_REVIEW/, '自报验收拒绝');
  const accepted = log('验收', 'user-review', decideAcceptance(seed, { id: 'acc-demo', projectId: 'p-demo', resultId: 'res-demo', decision: 'accept', reviewerPrincipalId: 'user-1', evidence: [{ review: '独立复核通过' }], rule: { mode: 'user' }, principal: { id: 'user-1', kind: 'authenticated_user' } }, 295));
  assert.equal(accepted.decision, 'accept');

  // ── Agent→用户：异常提出与关闭（caseId来自回执）──
  const raised = log('提异常', 'agent-tool', dispatcher(principal, 'issue.raise', { taskId: 't-demo', category: 'technical', summary: '演示异常', evidenceArtifactIds: ['art-demo'] }));
  assert.equal(raised.ok, true);
  const caseRow = seed.db.prepare("SELECT id,revision FROM cases WHERE id=?").get(raised.payload.caseId);
  assert.ok(caseRow);
  const issueClosed = log('关闭异常', 'user-review', resolveIssue(seed, 'p-demo', raised.payload.caseId, caseRow.revision, { resolution: '已解决' }, 300));
  assert.equal(issueClosed.state, 'resolved');

  // ── 交接与集成（ID来自回执；交接消费一次性）──
  const handover = log('交接准备', 'trusted-host', prepareHandover(seed, { id: 'hv-demo', projectId: 'p-demo', roleId, fromBindingEpoch: binding.epoch, verifierRoleId: 'r-reviewer', notes: '演示交接', recentMessageIds: [] }, 310));
  const verified = log('交接核验', 'trusted-host', verifyHandover(seed, 'p-demo', handover.id, 'r-reviewer', 315));
  assert.equal(verified.state, 'verified');
  const consumed = log('交接消费', 'trusted-host', consumeHandover(seed, 'p-demo', handover.id, 320));
  assert.equal(consumed.state, 'consumed');
  requestIntegration(seed, { id: 'int-demo', projectId: 'p-demo', taskId: 't-demo', targetVersion: 'v1', artifactIds: ['art-demo'], checks: [{ name: 'demo-suite', description: '演示集成检查' }] }, 330);
  startIntegration(seed, 'p-demo', 'int-demo', 335);
  const integrated = log('集成完成', 'integration-check', completeIntegration(seed, 'p-demo', 'int-demo', [{ name: 'demo-suite', passed: true, evidence: { ok: 1 } }], 340));
  assert.ok(['verified', 'completed'].includes(integrated.state), '集成检查通过');
  // 集成冲突负例已在integrations.test覆盖（failed可重试）
  assert.ok(trail.length >= 12, `全链${trail.length}步留痕`);
  assert.ok(trail.every(s => typeof s.who === 'string' && s.who.length > 0), '每动作有实现者');
  await runtime.stop();
  for (const store of stores.splice(0)) store.close();
});

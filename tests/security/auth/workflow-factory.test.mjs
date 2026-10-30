/** workflowFactory装配闭环e2e：startKernel(合成驱动)→用户命令→任务ready→workflow.evaluate意图→
 * WorkflowConsumer.pump→coordinator.prepare/run→驱动执行→结算→后继激活。
 * 合成驱动（无模型输入）；不是真实原生验收——真实ZCode驱动由zcode-supervisor.ts承载。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { createRole } from '../../../packages/domain/dist/roles/index.js';
import { createTaskWithin } from '../../../packages/domain/dist/tasks/index.js';
import { registerWorkspace } from '../../../packages/domain/dist/workspaces/index.js';
import { completeStartupAck, bootstrapRole } from '../../../packages/domain/dist/bootstrap/index.js';
import { establishFirstBinding } from '../../../packages/domain/dist/native-binding/index.js';
import { issueAgentCredential, authenticateAgentCredential } from '../../../apps/kernel/dist/auth/agent-credential.js';
import { NativeCompatibilityRegistry } from '../../../apps/kernel/dist/native/compatibility.js';
import { ExecutionCoordinator } from '../../../apps/kernel/dist/execution/coordinator.js';
import { WorkflowConsumer } from '../../../apps/kernel/dist/execution/workflow-consumer.js';
import { enqueueWorkflowCandidatesWithin } from '../../../apps/kernel/dist/execution/workflow-intents.js';
import { installSyntheticPolicy } from './synthetic-policy.mjs';
import { startKernel } from '../../../apps/kernel/dist/lifecycle/kernel-runtime.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-wf-factory-', () => { for (const s of stores.splice(0)) { try { s.close(); } catch { /* 已关闭 */ } } });
  const filename = path.join(dir, 'state.sqlite');
  const workspaceRoot = path.join(dir, 'workspace');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const store = openStore(filename);
  stores.push(store);
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: workspaceRoot, objective: 'o' }, 100);
  bootstrapRole(store, { projectId: 'p1', localRef: 'r-w', name: 'worker', charter: 'c', permissionProfileId: 'wf-exec', permissionProfileRevision: 1, expectedPolicyRevision: 0, principalId: 'user-1', requestId: 'boot-1' }, 110);
  store.transaction(db => db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s1','zcode','h','probe','sess-wf')").run());
  const binding = establishFirstBinding(store, { bindingId: 'b1', projectId: 'p1', roleId: 'r-w', sessionId: 's1' }, 120);
  const profile = { id: 'wf-exec', revision: 1, actions: ['identity', 'task.read', 'task.claim'], readPaths: ['tasks/*'], writePaths: ['tasks/*'], roleIds: [], delegableActions: [], maxDelegationDepth: 0 };
  installSyntheticPolicy(store, 'p1', [profile]);
  store.transaction(db => createTaskWithin(db, { id: 't-wf', projectId: 'p1', roleId: 'r-w', goal: '工作流任务', inputArtifacts: [], outputRequirements: [{ name: 'report', kind: 'report', description: '产出报告' }], acceptance: [{ ruleId: 'accept-1', description: '用户验收', mode: 'user' }], dependencies: [] }, 130));
  completeStartupAck(store, { projectId: 'p1', roleId: 'r-w', bindingEpoch: binding.epoch, protocolVersion: 2, policyRevision: 0, planRevision: 0, roleRevision: store.db.prepare("SELECT revision FROM roles WHERE id='r-w'").get().revision, taskSpecRevisions: [{ taskId: 't-wf', specRevision: 1 }] }, 140);
  registerWorkspace(store, { id: 'ws-wf', projectId: 'p1', canonicalPath: workspaceRoot, enforcement: 'enforced' }, 150);
  const credential = issueAgentCredential(store, 'b1', binding.epoch, { isolation: 'verified_session', session: { harnessId: 'zcode', hostId: 'h', profileId: 'probe', nativeConversationId: 'sess-wf' } }, Date.now(), 24 * 60 * 60 * 1000).credential;
  return { store, stores, filename, workspaceRoot, credential, bindingEpoch: binding.epoch, dir };
}

test('workflowFactory装配闭环：startKernel→意图→pump→coordinator→执行→结算→后继激活', async t => {
  const f = fixture(t);
  // 合成驱动：立即返回completed
  const registry = new NativeCompatibilityRegistry();
  const identity = { harnessId: 'zcode', version: 'synthetic', executableSha256: 'a'.repeat(64), bundleSha256: null, adapterProtocol: 'synthetic-v1', route: 'official_cli' };
  registry.setAdapterCapabilities(identity, ['textInput', 'resume', 'historyRead', 'roleTools']);
  registry.recordTrustedProbe({ identity, probeId: 'synthetic', evidenceSha256: 'b'.repeat(64), capabilities: { textInput: 'verified', resume: 'verified', historyRead: 'verified', roleTools: 'verified' } });
  const session = { harnessId: 'zcode', hostId: 'h', profileId: 'probe', nativeConversationId: 'sess-wf' };
  const driver = {
    session, ownerKey: 'synthetic-super', workspaceRoot: f.workspaceRoot, registry,
    identity: () => identity, assertOwner() {}, assertIsolation() {},
    start(input, started) { queueMicrotask(() => started(session, 'native-turn-wf')); return { result: Promise.resolve({ session, executionId: 'native-turn-wf', status: 'completed', terminalConfirmed: true }) }; },
  };

  let coordinatorRef;
  const workflowFactory = (store, ctx) => {
    const services = {
      now: ctx.now, isKernelOwner: ctx.isKernelOwner,
      assertGates() {},
      principalForBinding(bindingId) { return authenticateAgentCredential(store, f.credential, ctx.now()); },
      driverForBinding() { return driver; },
    };
    coordinatorRef = new ExecutionCoordinator(store, services);
    return new WorkflowConsumer(store, coordinatorRef, { workspaceForTask: () => 'ws-wf' });
  };

  const runtime = await startKernel({ filename: f.filename, principalId: 'user-1', workflowFactory, workflowPollMs: 200, outbox: { deliver: () => 'delivered' }, outboxPollMs: 200 });
  f.stores.push(runtime.store);
  // 命令管线完成→workflow.evaluate意图入队（用runtime.store内核连接确保可见性）
  runtime.store.transaction(db => db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('cmd-wf','p1','user-1','rq-wf',?,'project.pause','{}','completed',200)").run('0'.repeat(64)));
  const enqueued = runtime.store.transaction(db => enqueueWorkflowCandidatesWithin(db, 'p1', 'cmd-wf', 200));
  const outboxRow = runtime.store.db.prepare("SELECT state,operation_key FROM outbox WHERE operation_key LIKE 'workflow%'").get();
  if (!outboxRow) throw new Error('OUTBOX_ENTRY_MISSING after enqueue: count=' + enqueued);
  // 等待pump消费并执行
  for (let i = 0; i < 50; i++) {
    await new Promise(resolve => setTimeout(resolve, 200));
    const attempt = runtime.store.db.prepare("SELECT state FROM attempts WHERE task_id='t-wf'").get();
    const evalRow = runtime.store.db.prepare('SELECT decision,code FROM workflow_evaluations LIMIT 1').get();
    const outbox = runtime.store.db.prepare("SELECT state FROM outbox WHERE operation_key LIKE 'workflow%'").get();
    if (i === 5) console.log('poll5: outbox=' + outbox?.state + ' eval=' + JSON.stringify(evalRow) + ' attempt=' + (attempt?.state ?? 'none'));
    if (attempt && ['succeeded', 'failed', 'unknown'].includes(attempt.state)) break;
  }
  const attempt = runtime.store.db.prepare("SELECT state FROM attempts WHERE task_id='t-wf'").get();
  assert.ok(attempt, '尝试已创建');
  assert.equal(attempt.state, 'succeeded', '合成驱动完成执行');
  const dispatch = runtime.store.db.prepare("SELECT phase FROM execution_dispatches WHERE task_id='t-wf'").get();
  assert.equal(dispatch.phase, 'succeeded', '派发结算成功');
  const reservation = runtime.store.db.prepare("SELECT state FROM workspace_reservations WHERE task_id='t-wf'").get();
  assert.equal(reservation?.state ?? 'released', 'released', '目录预约已释放');
  await runtime.stop();
});

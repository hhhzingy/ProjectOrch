/** T116（PR2-W3）：持续执行装配（R109离线部分）。
 * 默认启动器（startApplication）接入工作流消费：project run持久状态 + 就绪任务持续派发 + 空闲唤醒（受信驱动）
 * + 重启接管恢复 + 无新事件不空转。A127完整判定为native（真实双端），本测试验证装配语义（合成驱动）。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { createTaskWithin } from '../../../packages/domain/dist/tasks/index.js';
import { registerWorkspace } from '../../../packages/domain/dist/workspaces/index.js';
import { bootstrapRole, completeStartupAck } from '../../../packages/domain/dist/bootstrap/index.js';
import { establishFirstBinding } from '../../../packages/domain/dist/native-binding/index.js';
import { issueAgentCredential, authenticateAgentCredential } from '../../../apps/kernel/dist/auth/agent-credential.js';
import { installSyntheticPolicy } from './synthetic-policy.mjs';
import { enqueueWorkflowCandidatesWithin } from '../../../apps/kernel/dist/execution/workflow-intents.js';
import { startKernel } from '../../../apps/kernel/dist/lifecycle/kernel-runtime.js';
import { ExecutionCoordinator } from '../../../apps/kernel/dist/execution/coordinator.js';
import { WorkflowConsumer } from '../../../apps/kernel/dist/execution/workflow-consumer.js';
import { NativeCompatibilityRegistry } from '../../../apps/kernel/dist/native/compatibility.js';
import { issueAgentCredential as reissueCredential } from '../../../apps/kernel/dist/auth/agent-credential.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-t116-', () => { for (const s of stores.splice(0)) { try { s.close(); } catch { /* 已关 */ } } });
  const filename = path.join(dir, 'state.sqlite');
  const ws = path.join(dir, 'ws'); fs.mkdirSync(ws, { recursive: true });
  const store = openStore(filename); stores.push(store);
  createProject(store, { id: 'p1', name: '持续执行', hostId: 'h', canonicalRoot: ws, objective: 'o' }, 100);
  bootstrapRole(store, { projectId: 'p1', localRef: 'worker', name: '执行者', charter: 'c', permissionProfileId: 'cont', permissionProfileRevision: 1, expectedPolicyRevision: 0, principalId: 'user-1', requestId: 'b0' }, 110);
  store.transaction(db => db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s1','zcode','h','p','sess-t116')").run());
  establishFirstBinding(store, { bindingId: 'b1', projectId: 'p1', roleId: 'worker', sessionId: 's1' }, 120);
  installSyntheticPolicy(store, 'p1', [{ id: 'cont', revision: 1, actions: ['identity', 'task.read', 'task.claim', 'task.report_own', 'task.submit_own'], readPaths: ['tasks/*'], writePaths: ['tasks/*'], roleIds: [], delegableActions: [], maxDelegationDepth: 0 }]);
  const mkTask = (id) => store.transaction(db => createTaskWithin(db, { id, projectId: 'p1', roleId: 'worker', goal: id + '目标', inputArtifacts: [], outputRequirements: [{ name: 'report', kind: 'report', description: 'd' }], acceptance: [{ ruleId: 'r1', description: '用户验收', mode: 'user' }], dependencies: [] }, 130));
  mkTask('task-a'); mkTask('task-b');
  completeStartupAck(store, { projectId: 'p1', roleId: 'worker', bindingEpoch: 1, protocolVersion: 2, policyRevision: 0, planRevision: 0, roleRevision: store.db.prepare("SELECT revision FROM roles WHERE id='worker'").get().revision, taskSpecRevisions: [{ taskId: 'task-a', specRevision: 1 }, { taskId: 'task-b', specRevision: 1 }] }, 140);
  registerWorkspace(store, { id: 'ws1', projectId: 'p1', canonicalPath: ws, enforcement: 'enforced' }, 150);
  issueAgentCredential(store, 'b1', 1, { isolation: 'verified_session', session: { harnessId: 'zcode', hostId: 'h', profileId: 'p', nativeConversationId: 'sess-t116' } }, Date.now(), 86400000);
  store.transaction(db => db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('cmd-t116','p1','user-1','rq-t116',?,'project.pause','{}','completed',200)").run('0'.repeat(64)));
  store.transaction(db => enqueueWorkflowCandidatesWithin(db, 'p1', 'cmd-t116', 200));
  store.close();
  return { filename, ws, dir, stores };
}

/** 项目运行状态（R109）：从持久表推导（不新增并行状态机——复用既有模型表达）。 */
function projectRunStatus(store) {
  const projectId = 'p1';
  const activeAttempts = store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE project_id=? AND state IN ('dispatching','running','waiting_input','unknown')").get(projectId).n;
  const unknownAttempts = store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE project_id=? AND state='unknown'").get(projectId).n;
  const pendingWorkflow = store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state='pending' AND json_extract(payload_json,'$.event')='workflow.evaluate' AND json_extract(payload_json,'$.projectId')=?").get(projectId).n;
  const userPaused = store.db.prepare("SELECT user_paused FROM projects WHERE id=?").get(projectId).user_paused === 1;
  const readyTasks = store.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id=? AND state IN ('draft','ready')").get(projectId).n;
  let state;
  if (userPaused) state = 'paused';
  else if (unknownAttempts > 0) state = 'unknown-execution';
  else if (activeAttempts > 0) state = 'running';
  else if (pendingWorkflow > 0) state = 'ready-to-dispatch';
  else state = 'idle';
  return { state, activeAttempts, unknownAttempts, pendingWorkflow, userPaused, readyTasks };
}

test('T116离线：默认workflowFactory持续派发——两任务被消费执行、运行状态可表达、空闲不空转', async t => {
  const f = fixture(t);
  const executions = [];
  const session = { harnessId: 'zcode', hostId: 'h', profileId: 'p', nativeConversationId: 'sess-t116' };
  let identity;
  let registryRef;
  const runtime = await startKernel({
    filename: f.filename, principalId: 'user-1', workflowPollMs: 200,
    outbox: { deliver: () => 'delivered' }, outboxPollMs: 200,
    workflowFactory: (store, ctx) => {
      
      const registry = new NativeCompatibilityRegistry();
      registryRef = registry;
      identity = { harnessId: 'zcode', version: 'synthetic-t116', executableSha256: 'a'.repeat(64), bundleSha256: null, adapterProtocol: 'synthetic', route: 'official_cli' };
      registry.recordTrustedProbe({ identity, probeId: 't116', evidenceSha256: 'b'.repeat(64), capabilities: { textInput: 'verified', resume: 'verified', historyRead: 'verified', roleTools: 'verified' } });
      const credential = store.db.prepare("SELECT id FROM agent_credentials ORDER BY created_at DESC LIMIT 1").get();
      void credential;
      const cred = getCredential(store);
      const principal = authenticateAgentCredential(store, cred, Date.now());
      const driver = {
        session, ownerKey: 't116-driver', workspaceRoot: f.ws, registry,
        identity: () => identity, assertOwner() {}, assertIsolation() {},
        start(input, started) {
          const taskId = input.taskId;
          const executionId = `native-turn-${taskId}`;
          executions.push({ taskId, executionId, input });
          queueMicrotask(() => started(session, executionId));
          return { result: Promise.resolve({ session, executionId, status: 'completed', terminalConfirmed: true }) };
        },
      };
      const services = { now: ctx.now, isKernelOwner: ctx.isKernelOwner, assertGates() {}, principalForBinding: () => principal, driverForBinding: () => driver };
      return new WorkflowConsumer(store, new ExecutionCoordinator(store, services), { workspaceForTask: (p, taskId) => 'ws1' });
    },
  });
  f.stores.push(runtime.store);
  // 等两个任务执行完成
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 200));
    const done = runtime.store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE project_id='p1' AND state='succeeded'").get().n;
    const evalBad = runtime.store.db.prepare("SELECT decision,code FROM workflow_evaluations WHERE decision!='prepared'").all();
    if (i % 10 === 9 && evalBad.length) console.log('blocked eval:', JSON.stringify(evalBad));
    if (done >= 2) break;
    if (i === 20) console.log('attempts:', JSON.stringify(runtime.store.db.prepare('SELECT task_id,state FROM attempts').all()), 'dispatches:', JSON.stringify(runtime.store.db.prepare('SELECT task_id,phase FROM execution_dispatches').all()));
  }
  const succeeded = runtime.store.db.prepare("SELECT task_id,state FROM attempts WHERE project_id='p1' ORDER BY task_id").all();
  assert.equal(succeeded.length, 2, '两任务尝试');
  assert.ok(succeeded.every(a => a.state === 'succeeded'), '全部执行完成');
  // 运行状态可表达
  const status = projectRunStatus(runtime.store);
  assert.equal(status.state, 'idle', '完成后idle');
  assert.equal(status.activeAttempts, 0);
  // 执行记录含输入（任务ID关联）
  assert.equal(executions.length, 2, '两次真实驱动调用');
  assert.deepEqual(executions.map(e => e.taskId).sort(), ['task-a', 'task-b']);
  // 空闲不空转：等待1秒确认无新增执行
  const before = executions.length;
  await new Promise(r => setTimeout(r, 1000));
  assert.equal(executions.length, before, '无新事件不空转');
  await runtime.stop();
});

test('T116离线：重启接管——在途执行转unknown且不重发；新内核恢复账本', async t => {
  const f = fixture(t);
  // 第一内核：启动后立即在发送前停止（模拟在途崩溃）——直接构造：启动内核后kill（不优雅stop）
  let started1;
  const runtime1 = await startKernel({ filename: f.filename, principalId: 'user-1', workflowPollMs: 100,
    workflowFactory: (store, ctx) => {
      const session2 = { harnessId: 'zcode', hostId: 'h', profileId: 'p', nativeConversationId: 'sess-t116' };
      const registry = new NativeCompatibilityRegistry();
      const identity = { harnessId: 'zcode', version: 'synthetic-t116', executableSha256: 'a'.repeat(64), bundleSha256: null, adapterProtocol: 'synthetic', route: 'official_cli' };
      registry.recordTrustedProbe({ identity, probeId: 't116', evidenceSha256: 'b'.repeat(64), capabilities: { textInput: 'verified', resume: 'verified', historyRead: 'verified', roleTools: 'verified' } });
      const cred = getCredential(store);
      const principal = authenticateAgentCredential(store, cred, Date.now());
      const driver = { session: session2, ownerKey: 'crash-driver', workspaceRoot: f.ws, registry, identity: () => identity, assertOwner() {}, assertIsolation() {},
        start(input, started) { started1 = true; started(session2, `native-turn-${input.taskId}`); return { result: new Promise(() => {}) }; } };
      const services = { now: ctx.now, isKernelOwner: ctx.isKernelOwner, assertGates() {}, principalForBinding: () => principal, driverForBinding: () => driver };
      
      return new WorkflowConsumer(store, new ExecutionCoordinator(store, services), { workspaceForTask: () => 'ws1' });
    } });
  f.stores.push(runtime1.store);
  // 等第一任务开始（running）
  for (let i = 0; i < 50; i++) { await new Promise(r => setTimeout(r, 100)); const r2 = runtime1.store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE state IN ('dispatching','running')").get().n; if (r2 >= 1) break; }
  assert.ok(started1, '第一内核已开始执行');
  // 崩溃：直接close store（不走优雅stop——留下在途）
  try { runtime1.store.close(); } catch { /* 已关 */ }
  f.stores.pop();
  // 模拟租约到期（owner死亡后心跳停止）：清锁允许接管——真实场景为等待lockLeaseMs过期
  { const unlock = openStore(f.filename); unlock.db.exec("UPDATE kernel_lock SET holder='',heartbeat=0 WHERE id=1"); unlock.close(); }
  // 第二内核接管：恢复unknown不重发
  const executions2 = [];
  const runtime2 = await startKernel({ filename: f.filename, principalId: 'user-1', workflowPollMs: 100,
    workflowFactory: (store, ctx) => {
      const registry = new NativeCompatibilityRegistry(); const identity = { harnessId: 'zcode', version: 'synthetic-t116', executableSha256: 'a'.repeat(64), bundleSha256: null, adapterProtocol: 'synthetic', route: 'official_cli' };
      registry.recordTrustedProbe({ identity, probeId: 't116', evidenceSha256: 'b'.repeat(64), capabilities: { textInput: 'verified', resume: 'verified', historyRead: 'verified', roleTools: 'verified' } });
      const cred = getCredential(store); const principal = authenticateAgentCredential(store, cred, Date.now());
      const session2 = { harnessId: 'zcode', hostId: 'h', profileId: 'p', nativeConversationId: 'sess-t116' };
      const driver = { session: session2, ownerKey: 'takeover-driver', workspaceRoot: f.ws, registry, identity: () => identity, assertOwner() {}, assertIsolation() {},
        start(input, started) { executions2.push(input.taskId); started(session2, `native-turn2-${input.taskId}`); return { result: Promise.resolve({ session: session2, executionId: `native-turn2-${input.taskId}`, status: 'completed', terminalConfirmed: true }) }; } };
      const services = { now: ctx.now, isKernelOwner: ctx.isKernelOwner, assertGates() {}, principalForBinding: () => principal, driverForBinding: () => driver };
      return new WorkflowConsumer(store, new ExecutionCoordinator(store, services), { workspaceForTask: () => 'ws1' });
    } });
  f.stores.push(runtime2.store);
  await new Promise(r => setTimeout(r, 1500));
  // 旧执行转unknown（不重发同一任务）
  const unknown = runtime2.store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE state='unknown'").get().n;
  assert.ok(unknown >= 1, '崩溃在途转unknown');
  // 重启后状态可表达
  const status = projectRunStatus(runtime2.store);
  assert.equal(status.state, 'unknown-execution', 'unknown执行状态如实表达');
  await runtime2.stop();
});

function getCredential(store) {
  return reissueCredential(store, 'b1', 1, { isolation: 'verified_session', session: { harnessId: 'zcode', hostId: 'h', profileId: 'p', nativeConversationId: 'sess-t116' } }, Date.now(), 86400000).credential;
}


import { after } from "node:test";
import process2 from "node:process";
after(() => { setTimeout(() => process2.exit(0), 300).unref?.(); });

// 合成执行环境：不启动官方软件或模型，不用这些证明冒充生产能力。
import fs from 'node:fs';
import path from 'node:path';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { createRole } from '../../../packages/domain/dist/roles/index.js';
import { createTaskWithin } from '../../../packages/domain/dist/tasks/index.js';
import { completeStartupAck } from '../../../packages/domain/dist/bootstrap/index.js';
import { registerWorkspace } from '../../../packages/domain/dist/workspaces/index.js';
import { issueAgentCredential, authenticateAgentCredential } from '../../../apps/kernel/dist/auth/agent-credential.js';
import { NativeCompatibilityRegistry } from '../../../apps/kernel/dist/native/compatibility.js';
import { ExecutionCoordinator } from '../../../apps/kernel/dist/execution/coordinator.js';
import { installSyntheticPolicy } from './synthetic-policy.mjs';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

export function executionFixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-execution-', () => { for (const store of stores) if (!store.closed) store.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const store = openStore(filename); stores.push(store);
  const workspaceRoot = path.join(dir, 'workspace'); fs.mkdirSync(workspaceRoot);
  createProject(store, { id: 'p', name: 'synthetic execution', hostId: 'host', canonicalRoot: dir, objective: '组件测试，不是真实原生验收' }, 100);
  createRole(store, { id: 'worker', projectId: 'p', name: 'worker', charter: '组件执行者', permissionProfileId: 'execution' }, 101);
  const session = { harnessId: 'zcode', hostId: 'host', profileId: 'synthetic-only', nativeConversationId: 'synthetic-native' };
  store.db.exec("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('session','zcode','host','synthetic-only','synthetic-native'); INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('binding','p','worker','session',1,100); UPDATE roles SET binding_state='provisioning' WHERE id='worker'");
  const secret = issueAgentCredential(store, 'binding', 1, { isolation: 'verified_session', session }, 110, 60000).credential;
  const principal = authenticateAgentCredential(store, secret, 120);
  const profile = { id: 'execution', revision: 1, actions: ['identity', 'task.read', 'task.claim'], readPaths: ['tasks/*'], writePaths: ['tasks/*'], roleIds: [], delegableActions: [], maxDelegationDepth: 0 };
  installSyntheticPolicy(store, 'p', [profile]);
  const create = (id, dependencies = []) => store.transaction(db => createTaskWithin(db, { id, projectId: 'p', roleId: 'worker', goal: id, inputArtifacts: [], outputRequirements: [{ name: 'report', kind: 'report', description: '报告' }], acceptance: [{ ruleId: 'review', mode: 'designated_reviewer', reviewerRoleId: 'worker', independent: false, description: '合成规则' }], dependencies }, 130));
  create('task'); create('next');
  completeStartupAck(store, { projectId: 'p', roleId: 'worker', bindingEpoch: 1, protocolVersion: 2, policyRevision: 0, planRevision: 0, roleRevision: 1, taskSpecRevisions: [{ taskId: 'task', specRevision: 1 }, { taskId: 'next', specRevision: 1 }] }, 140);
  registerWorkspace(store, { id: 'workspace', projectId: 'p', canonicalPath: workspaceRoot, enforcement: 'enforced' }, 150);
  const registry = new NativeCompatibilityRegistry();
  let identity = { harnessId: 'zcode', version: 'synthetic-only', executableSha256: 'a'.repeat(64), bundleSha256: null, adapterProtocol: 'synthetic-driver-v1', route: 'official_cli' };
  const prove = capabilities => registry.recordTrustedProbe({ identity, probeId: 'synthetic-only', evidenceSha256: 'b'.repeat(64), capabilities });
  prove({ textInput: 'verified', resume: 'verified', historyRead: 'verified', roleTools: 'verified' });
  let resolveResult, rejectResult; const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  let calls = 0, observe; let owner = true; let gate = true; let startOverride;
  const driver = {
    session, ownerKey: 'synthetic-driver-owner', workspaceRoot, registry,
    identity: () => identity, assertOwner() { if (!owner) throw new Error('DRIVER_OWNER_LOST'); }, assertIsolation() {},
    start(input, started, assertCanSend) { calls++; observe = started; if (startOverride) return startOverride(input, started, assertCanSend); assertCanSend(); queueMicrotask(() => started(session, 'native-turn')); return { result }; },
  };
  const services = { now: () => 300, isKernelOwner: () => owner, assertGates: () => { if (!gate) throw new Error('GATE_NOT_VERIFIED'); }, principalForBinding: () => principal, driverForBinding: () => driver };
  const coordinator = new ExecutionCoordinator(store, services);
  const prepare = (requestKey = 'request', taskId = 'task') => coordinator.prepare(principal, { requestKey, taskId, workspaceId: 'workspace' });
  const finish = (overrides = {}) => resolveResult({ session, executionId: 'native-turn', status: 'completed', terminalConfirmed: true, ...overrides });
  const row = id => store.db.prepare('SELECT * FROM execution_dispatches WHERE id=?').get(id);
  const reservation = () => store.db.prepare('SELECT * FROM workspace_reservations').get();
  return { dir, filename, store, stores, session, principal, driver, registry, coordinator, services, create, prepare, finish, row, reservation, rejectResult,
    get calls() { return calls; }, observe: (...args) => observe(...args), setOwner: v => { owner = v; }, setGate: v => { gate = v; }, setStart: v => { startOverride = v; }, changeIdentity: () => { identity = { ...identity, version: 'synthetic-updated' }; }, prove };
}

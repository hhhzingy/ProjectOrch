// 可重复的故障回归资产：只运行合成驱动，在实际文件副作用后强制终止独立进程。
import fs from 'node:fs';
import path from 'node:path';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { issueAgentCredential, authenticateAgentCredential } from '../../../apps/kernel/dist/auth/agent-credential.js';
import { NativeCompatibilityRegistry } from '../../../apps/kernel/dist/native/compatibility.js';
import { ExecutionCoordinator } from '../../../apps/kernel/dist/execution/coordinator.js';

const store = openStore(process.argv[2]);
const stopScenario = process.argv[3] === 'stop';
const root = String(store.db.prepare("SELECT canonical_path FROM workspaces WHERE id='workspace'").get().canonical_path);
const session = { harnessId: 'zcode', hostId: 'host', profileId: 'synthetic-only', nativeConversationId: 'synthetic-native' };
const secret = issueAgentCredential(store, 'binding', 1, { isolation: 'verified_session', session }, 200, 60000).credential;
const principal = authenticateAgentCredential(store, secret, 250);
const identity = { harnessId: 'zcode', version: 'synthetic-only', executableSha256: 'a'.repeat(64), bundleSha256: null, adapterProtocol: 'synthetic-driver-v1', route: 'official_cli' };
const registry = new NativeCompatibilityRegistry();
registry.setAdapterCapabilities(identity, ['textInput', 'resume', 'historyRead', 'roleTools', 'nativeCancel']);
registry.recordTrustedProbe({ identity, probeId: 'synthetic-only', evidenceSha256: 'b'.repeat(64), capabilities: { textInput: 'verified', resume: 'verified', historyRead: 'verified', roleTools: 'verified', nativeCancel: 'verified' } });
const driver = {
  session, ownerKey: 'synthetic-crash-owner', workspaceRoot: root, registry,
  identity: () => identity, assertOwner() {}, assertIsolation() {},
  start(_input, started) {
    if (stopScenario) { queueMicrotask(() => started(session, 'native-turn')); return { result: new Promise(() => {}) }; }
    fs.writeFileSync(path.join(root, 'synthetic-side-effect.txt'), 'one external effect', { flag: 'wx' });
    fs.writeSync(1, 'CRASH_POINT:after-side-effect\n');
    process.kill(process.pid, 'SIGKILL');
    throw new Error('CRASH_DID_NOT_STOP_PROCESS');
  },
  requestStop() {
    fs.writeFileSync(path.join(root, 'synthetic-stop-effect.txt'), 'one stop effect', { flag: 'wx' });
    fs.writeSync(1, 'CRASH_POINT:after-stop-side-effect\n');
    process.kill(process.pid, 'SIGKILL');
    throw new Error('CRASH_DID_NOT_STOP_PROCESS');
  },
};
const coordinator = new ExecutionCoordinator(store, { now: () => 300, isKernelOwner: () => true, assertGates() {}, principalForBinding: () => principal, driverForBinding: () => driver });
const id = coordinator.prepare(principal, { requestKey: 'crash', taskId: 'task', workspaceId: 'workspace' });
const run = coordinator.run(id);
if (stopScenario) {
  await new Promise(resolve => setImmediate(resolve));
  store.db.prepare("INSERT INTO native_control_requests(id,project_id,attempt_id,binding_id,binding_epoch,expected_native_execution_id,task_spec_revision,kind,state,created_at) VALUES('stop','p',?,'binding',1,'native-turn',2,'stop','pending',300)").run(id);
  await coordinator.requestStop('stop');
}
await run;
throw new Error('CRASH_DID_NOT_OCCUR');

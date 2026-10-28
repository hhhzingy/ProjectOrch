/** T112（PR2-W2）：Codex线程工厂离线测试（真实A112随W2原生验收执行）。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import { CodexThreadFactory, detectCodexIdentity } from '../../../apps/kernel/dist/execution/codex-supervisor.js';
import { NativeCompatibilityRegistry } from '../../../apps/kernel/dist/native/compatibility.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

function syntheticCodexCli(dir, version = 'codex-cli 0.163.0-synthetic') {
  const script = path.join(dir, 'synthetic-codex.cmd');
  // Windows: .cmd包装node脚本输出version
  const inner = path.join(dir, 'synthetic-codex.cjs');
  fs.writeFileSync(inner, `console.log(${JSON.stringify(version)});\n`);
  fs.writeFileSync(script, `@echo off\r\n"${process.execPath}" "${inner}" %*\r\n`);
  return script;
}
function registryWith(identity) {
  const registry = new NativeCompatibilityRegistry();
  registry.recordTrustedProbe({ identity, probeId: 'synthetic-codex-factory', evidenceSha256: 'c'.repeat(64), capabilities: { textInput: 'verified', resume: 'verified', historyRead: 'verified' } });
  return registry;
}

test('T112离线：身份现场探针（--version+二进制哈希）；未注册身份拒绝', t => {
  const dir = temporaryDirectory(t, 'projectorch-t112-id-');
  const exe = syntheticCodexCli(dir);
  const identity = detectCodexIdentity(exe);
  assert.equal(identity.version, 'codex-cli 0.163.0-synthetic');
  assert.match(identity.executableSha256, /^[a-f0-9]{64}$/);
  // 未注册此真实身份的registry→拒绝
  const registry = registryWith({ harnessId: 'codex', version: '其他版本', executableSha256: 'f'.repeat(64), bundleSha256: null, adapterProtocol: 'codex-app-server-jsonl-v2', route: 'official_rpc' });
  const leaseDir = path.join(dir, 'leases'); fs.mkdirSync(leaseDir);
  const factory = new CodexThreadFactory({ executable: exe, cwd: dir, env: {}, leaseDirectory: leaseDir, registry });
  assert.throws(() => factory.assertCapabilities(), /NATIVE_CAPABILITY_UNVERIFIED/);
});

test('T112离线：合成adapter线程创建+章程——onStep边界（sent→observed）、官方threadId、marker观察', async t => {
  const dir = temporaryDirectory(t, 'projectorch-t112-ok-');
  const exe = syntheticCodexCli(dir);
  const full = { ...detectCodexIdentity(exe), harnessId: 'codex', bundleSha256: null, adapterProtocol: 'codex-app-server-jsonl-v2', route: 'official_rpc' };
  const registry = registryWith(full);
  const leaseDir = path.join(dir, 'leases'); fs.mkdirSync(leaseDir);
  const factory = new CodexThreadFactory({ executable: exe, cwd: dir, env: {}, leaseDirectory: leaseDir, registry, executionTimeoutMs:900000 });
  const steps = [];
  const adapter = {
    startThread: async () => ({ threadId: 'th_synthetic_' + 'a1b2c3d4' }),
    runTurn: async (text, marker, deadline) => { assert.equal(deadline,900000); return { threadId: 'th_synthetic_a1b2c3d4', markerSeen: text.includes('章程') && marker === 'T112_CHARTER_OK', status: 'completed' }; },
    close() {},
  };
  const outcome = await factory.createThreadWithCharter({ adapter, charter: 'Codex角色章程（合成）：确认T112_CHARTER_OK', marker: 'T112_CHARTER_OK', hostId: 'host-1', profileId: 'profile-1', onStep: s => steps.push(s) });
  assert.equal(outcome.nativeThreadId, 'th_synthetic_a1b2c3d4');
  assert.equal(outcome.charterMarkerSeen, true, '章程marker观察');
  const keys = steps.map(s => `${s.step}:${s.state}`);
  assert.ok(keys.includes('create-thread:sent') && keys.includes('create-thread:observed'), '创建边界');
  assert.ok(keys.includes('deliver-charter:sent') && keys.includes('deliver-charter:observed'), '章程边界');
  assert.equal(steps.filter(s => s.step === 'create-thread' && s.state === 'sent').length, 1, '单次发送不重试');
});

test('T112离线：adapter失败→failed/unknown如实；不伪造threadId', async t => {
  const dir = temporaryDirectory(t, 'projectorch-t112-fail-');
  const exe = syntheticCodexCli(dir);
  const registry = registryWith({ ...detectCodexIdentity(exe), harnessId: 'codex', bundleSha256: null, adapterProtocol: 'codex-app-server-jsonl-v2', route: 'official_rpc' });
  const leaseDir = path.join(dir, 'leases'); fs.mkdirSync(leaseDir);
  const factory = new CodexThreadFactory({ executable: exe, cwd: dir, env: {}, leaseDirectory: leaseDir, registry });
  const steps = [];
  const failing = { startThread: async () => { throw new Error('CODEX_THREAD_TIMEOUT'); }, runTurn: async () => { throw new Error('unreachable'); }, close() {} };
  await assert.rejects(() => factory.createThreadWithCharter({ adapter: failing, charter: 'x', marker: 'm', hostId: 'h', profileId: 'p', onStep: s => steps.push(s) }));
  assert.ok(steps.some(s => s.state === 'unknown'), '超时语义→unknown');
  assert.ok(!steps.some(s => s.state === 'observed'), '不伪造observed');
});

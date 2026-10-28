import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { CodexAdapter, codexAdapterProtocol } from '../../apps/kernel/dist/adapters/codex-adapter.js';
import { ZcodeAdapter } from '../../apps/kernel/dist/adapters/zcode-adapter.js';
import { NativeCompatibilityRegistry } from '../../apps/kernel/dist/native/compatibility.js';
import { zcodeTextAdapterProtocol } from '../../apps/kernel/dist/native/verified-zcode-session.js';
import { temporaryDirectory } from './temporary-directory.mjs';
const hash = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const worker = fileURLToPath(new URL('./zcode-cli-worker.mjs', import.meta.url));
const ref = { harnessId: 'zcode', hostId: 'synthetic', profileId: 'synthetic', nativeConversationId: 'id-without-sess-prefix' };
function registryFor(harnessId, bundle, protocol) {
  const registry = new NativeCompatibilityRegistry();
  const identity = { harnessId, version: 'synthetic-only', executableSha256: hash(process.execPath), bundleSha256: bundle ? hash(bundle) : null, adapterProtocol: protocol, route: bundle ? 'official_cli' : 'official_rpc' };
  registry.recordTrustedProbe({ identity, probeId: 'synthetic-not-acceptance', evidenceSha256: 'a'.repeat(64), capabilities: { textInput: 'verified', resume: 'verified', historyRead: 'verified', nativeCancel: 'verified', guide: 'verified', roleTools: 'verified' } });
  return { registry, identity };
}
function zcode(t, overrides = {}) {
  const dir = temporaryDirectory(t, 'projectorch-zcode-adapter-safe-');
  const options = { executable: process.execPath, bundle: worker, cwd: dir, env: {}, leaseDirectory: dir, compatibility: registryFor('zcode', worker, zcodeTextAdapterProtocol), timeoutMs: 2000, ...overrides };
  return { options, dir, adapter: new ZcodeAdapter(options, ref) };
}
function codex(t, mode = 'complete') {
  let adapter;
  // 必须先关闭owner再清理其lease目录，避免测试自己破坏owner身份。
  t.after(() => adapter?.close());
  const dir = temporaryDirectory(t, 'projectorch-codex-adapter-safe-');
  const log = path.join(dir, 'requests.log');
  const options = { executable: process.execPath, cwd: fileURLToPath(new URL('./fixtures/codex-managed/', import.meta.url)), env: { SYNTHETIC_MODE: mode, SYNTHETIC_LOG: log }, timeoutMs: 2000, leaseDirectory: dir, hostId: 'synthetic', profileId: 'synthetic', compatibility: registryFor('codex', null, codexAdapterProtocol) };
  adapter = new CodexAdapter(options);
  return { adapter, options, log, dir };
}
const turnsSent = log => fs.readFileSync(log, 'utf8').split('\n').filter(l => l === 'turn/start').length;
async function waitForTurn(adapter) {
  for (let i = 0; i < 100; i++) { if (adapter.execution.turnId) return adapter.execution.turnId; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('synthetic turn did not start');
}

test('ZCode生产入口复用单owner且总是同ID resume；未验证版本不外发', async t => {
  const { adapter, options } = zcode(t);
  const receipt = await adapter.runTurn('SYNTHETIC_OK', 'SYNTHETIC_OK');
  assert.equal(receipt.status, 'completed'); assert.equal(receipt.sessionId, ref.nativeConversationId); assert.ok(receipt.turnId);
  const other = new ZcodeAdapter(options, ref);
  await assert.rejects(other.runTurn('second', ''), /NATIVE_OWNER_OCCUPIED/);
  adapter.close();
  assert.equal((await other.runTurn('after-release', '')).status, 'completed'); other.close();
  const unverified = new ZcodeAdapter({ ...options, compatibility: undefined }, ref);
  await assert.rejects(unverified.runTurn('not-sent', ''), /NATIVE_COMPATIBILITY_PROBE_REQUIRED/);
});

test('ZCode错会话、isError、畸形和超时均unknown；同实例/新实例不可重发', async t => {
  for (const input of ['wrong-session', 'result-error', 'bad', 'silent']) {
    const { adapter, options } = zcode(t);
    const receipt = await adapter.runTurn(input, '', input === 'silent' ? 150 : 2000);
    assert.equal(receipt.status, 'unknown', input); assert.equal(receipt.exitConfirmed, true);
    await assert.rejects(adapter.runTurn('do-not-retry', ''), /CLI_OWNER_NOT_IDLE/);
    assert.throws(() => adapter.close(), /SESSION_OWNER_NOT_RELEASABLE/);
    const duplicate = new ZcodeAdapter(options, ref);
    await assert.rejects(duplicate.runTurn('do-not-retry', ''), /NATIVE_OWNER_OCCUPIED/);
  }
});

test('Codex并发初始化拒绝；提前通知正确关联，同一实例不创建替代线程', async t => {
  const { adapter } = codex(t);
  const first = adapter.startThread();
  await assert.rejects(adapter.startThread(), /ADAPTER_OWNER_NOT_IDLE/);
  assert.equal((await first).threadId, 'synthetic-thread');
  const receipt = await adapter.runTurn('synthetic', 'SYNTHETIC_OK', 1000);
  assert.equal(receipt.status, 'completed'); assert.equal(receipt.markerSeen, true); assert.equal(receipt.turnId, 'turn-1');
  await assert.rejects(adapter.startThread(), /ADAPTER_OWNER_NOT_IDLE/);
});

test('Codex未知结果跨实例保留owner，不接受其他线程终态', async t => {
  for (const mode of ['quiet', 'wrong-terminal']) {
    const { adapter, options, log } = codex(t, mode);
    await adapter.startThread();
    const pending = adapter.runTurn('synthetic', '', 150);
    await assert.rejects(adapter.runTurn('duplicate', ''), /ADAPTER_OWNER_NOT_IDLE/);
    assert.equal((await pending).status, 'unknown');
    await assert.rejects(adapter.runTurn('retry', ''), /ADAPTER_OWNER_NOT_IDLE/);
    await adapter.close();
    const other = new CodexAdapter(options);
    await assert.rejects(other.resumeThread('synthetic-thread'), /NATIVE_OWNER_OCCUPIED/);
    assert.equal(turnsSent(log), 1);
  }
});

test('Codex取消RPC只表示requested，只有匹配原生终态才interrupted', async t => {
  for (const mode of ['quiet', 'interrupt-terminal']) {
    const { adapter } = codex(t, mode);
    await adapter.startThread();
    const pending = adapter.runTurn('synthetic', '', mode === 'quiet' ? 400 : 4000);
    const turnId = await waitForTurn(adapter);
    assert.equal(await adapter.interrupt('old-turn'), 'rejected');
    assert.equal(await adapter.interrupt(turnId), 'requested');
    const receipt = await pending;
    assert.equal(receipt.status, mode === 'quiet' ? 'unknown' : 'interrupted');
  }
});

test('Codex仅同线程同turn历史终态可解锁unknown；错历史和工具isError拒绝', async t => {
  const { adapter } = codex(t, 'reconcile');
  await adapter.startThread();
  assert.equal((await adapter.runTurn('synthetic', '', 100)).status, 'unknown');
  assert.equal((await adapter.reconcileTurn()).status, 'completed'); assert.equal(adapter.phase, 'idle');
  await assert.rejects(adapter.callIdentityTool('synthetic'), /IDENTITY_RESULT_NOT_PROVEN/);
  const wrong = codex(t, 'history-mismatch').adapter;
  await wrong.startThread();
  await assert.rejects(wrong.readHistory(), /HISTORY_TARGET_UNPROVEN/);
  assert.equal(wrong.phase, 'unknown');
});

test('Codex无匹配兼容证据不连接，历史投影禁止伪造原生条目ID', async t => {
  const { adapter, options } = codex(t);
  const missing = new CodexAdapter({ ...options, compatibility: undefined });
  await assert.rejects(missing.startThread(), /NATIVE_COMPATIBILITY_PROBE_REQUIRED/); assert.equal(missing.connected, false);
  await adapter.startThread();
  assert.throws(() => adapter.historyAsNativeItems([{}], 'synthetic-thread'), /HISTORY_ITEM_ID_UNPROVEN/);
  assert.throws(() => adapter.historyAsNativeItems([{ id: 'a' }], 'other-thread'), /HISTORY_TARGET_UNPROVEN/);
  const first = adapter.historyAsNativeItems([{ id: 'a', status: 'completed' }], 'synthetic-thread')[0];
  const later = adapter.historyAsNativeItems([{ id: 'a', status: 'completed' }, { id: 'b', status: 'completed' }], 'synthetic-thread')[0];
  assert.equal(first.revision, later.revision);
});

test('ZCode业务入口更新字节后先禁用；spawn前失败不冒充unknown执行', async t => {
  const { options, dir } = zcode(t);
  const bundle = path.join(dir, 'own-fixture.mjs'); fs.copyFileSync(worker, bundle);
  const compatibility = registryFor('zcode', bundle, zcodeTextAdapterProtocol);
  const adapter = new ZcodeAdapter({ ...options, bundle, compatibility }, ref);
  assert.equal((await adapter.runTurn('before', '')).status, 'completed');
  fs.appendFileSync(bundle, '\n// test fixture update\n');
  await assert.rejects(adapter.runTurn('after', ''), /NATIVE_COMPATIBILITY_PROBE_REQUIRED/);
  assert.equal(adapter.phase, 'idle'); adapter.close();
  const missingCwd = new ZcodeAdapter({ ...options, cwd: path.join(dir, 'missing-cwd') }, ref);
  const failure = await missingCwd.runTurn('not-sent', '');
  assert.equal(failure.status, 'failed'); assert.equal(failure.failureCode, 'CLI_SPAWN_NOT_SENT');
  assert.equal(missingCwd.phase, 'idle'); missingCwd.close();
});

test('Codex恢复核验ID和空闲状态；缺启动回执按deadline返回unknown', async t => {
  for (const mode of ['resume-mismatch', 'resume-active']) {
    const { adapter } = codex(t, mode);
    await assert.rejects(adapter.resumeThread('synthetic-thread'), /RESUME_ID_MISMATCH|RESUME_EXECUTION_UNPROVEN/);
    assert.equal(adapter.phase, 'unknown');
  }
  const { adapter, log } = codex(t, 'no-start-reply');
  await adapter.startThread();
  const started = Date.now();
  assert.equal((await adapter.runTurn('synthetic', '', 100)).status, 'unknown');
  assert.ok(Date.now() - started < 1500, '本轮deadline不能等待完整RPC timeout');
  await assert.rejects(adapter.runTurn('retry', ''), /ADAPTER_OWNER_NOT_IDLE/);
  assert.equal(turnsSent(log), 1);
});

test('Codex每次外发重新查能力；明确不支持与未探测不能沿用缓存', async t => {
  const { adapter, options, log } = codex(t);
  await adapter.startThread();
  const { registry, identity } = options.compatibility;
  registry.recordTrustedProbe({ identity, probeId: 'synthetic-revoke', evidenceSha256: 'b'.repeat(64), capabilities: { textInput: 'unsupported' } });
  await assert.rejects(adapter.runTurn('not-sent', ''), /NATIVE_CAPABILITY_UNSUPPORTED/);
  await assert.rejects(adapter.readHistory(), /NATIVE_COMPATIBILITY_PROBE_REQUIRED/);
  assert.equal(turnsSent(log), 0);
});

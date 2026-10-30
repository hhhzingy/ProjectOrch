import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { NativeCompatibilityRegistry } from '../../apps/kernel/dist/native/compatibility.js';
import { loadCompatibilityMatrix, gateStartupIdentity, doctorReport, compatibilityNotice } from '../../apps/kernel/dist/doctor/index.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';
const identity = over => ({ harnessId: 'zcode', version: '0.17.0', executableSha256: 'a'.repeat(64), bundleSha256: 'b'.repeat(64), adapterProtocol: 'zcode-cli-jsonl-v2', route: 'official_cli', ...over });
const entry = () => ({ identity: identity({}), capabilities: { textInput: 'verified', resume: 'verified', historyRead: 'verified', roleTools: 'verified' }, evidence: 'synthetic-only', testedAt: '2026-10-24' });

test('新版及哈希变化仅提示未测，不停止发送/恢复/历史/角色工具', () => {
  const matrix = { schemaVersion: 1, entries: [entry()] }, registry = new NativeCompatibilityRegistry();
  gateStartupIdentity(registry, matrix, 'test-matrix', identity({}), 'old');
  const updated = identity({ version: 'future-99', executableSha256: 'c'.repeat(64) });
  const gate = gateStartupIdentity(registry, matrix, 'test-matrix', updated, 'new');
  assert.equal(gate.registered, false); assert.equal(gate.reason, 'not_previously_tested');
  for (const cap of ['textInput', 'resume', 'historyRead', 'roleTools']) {
    assert.equal(registry.decide(updated, cap).enabled, true);
    assert.equal(registry.decide(updated, cap).state, 'unverified');
  }
  const row = doctorReport({ now: 1, matrix, matrixPath: 'test-matrix', installed: [updated], registry }).harnesses[0];
  assert.equal(row.version, 'future-99'); assert.equal(row.inMatrix, false);
  assert.equal(row.testedVersions[0].version, '0.17.0');
  assert.ok(row.testedVersions[0].passedCapabilities.includes('roleTools'));
  assert.ok(!row.affectedWriteActions.some(a => a.includes('message_send')));
  assert.match(row.executableSha256Masked, /^c{12}…$/);
  assert.match(compatibilityNotice(matrix, updated), /已测试通过版本：0.17.0/);
  assert.doesNotMatch(compatibilityNotice(matrix, updated), /写动作停止|必须复验/);
});

test('实际驱动未实现的能力仍阻止对应操作，历史通过不能强行启用', () => {
  const matrix = { schemaVersion: 1, entries: [entry()] }, registry = new NativeCompatibilityRegistry(), current = identity({});
  gateStartupIdentity(registry, matrix, 'test', current, 'probe');
  registry.setAdapterCapabilities(current, ['resume', 'historyRead', 'roleTools']);
  const row = doctorReport({ now: 1, matrix, matrixPath: 'test', installed: [current], registry }).harnesses[0];
  assert.equal(registry.decide(current, 'textInput').enabled, false);
  assert.equal(registry.decide(current, 'resume').enabled, true);
  assert.ok(row.affectedWriteActions.some(a => a.includes('message_send')));
});

test('缺失及空测试记录不阻止接入，损坏的数据明确报错', t => {
  const dir = temporaryDirectory(t, 'projectorch-tested-version-'), file = path.join(dir, 'tests.json');
  assert.deepEqual(loadCompatibilityMatrix(file), { schemaVersion: 1, entries: [] });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, entries: [] }));
  assert.equal(loadCompatibilityMatrix(file).entries.length, 0);
  assert.equal(new NativeCompatibilityRegistry().decide(identity({}), 'textInput').enabled, true);
  fs.writeFileSync(file, '{"schemaVersion":1,"entries":null}');
  assert.throws(() => loadCompatibilityMatrix(file), /INVALID_COMPATIBILITY_MATRIX/);
});

test('不同 Harness 的测试记录隔离，未把 ZCode 通过当成 Codex 已测', () => {
  const matrix = { schemaVersion: 1, entries: [entry()] }, registry = new NativeCompatibilityRegistry();
  const codex = identity({ harnessId: 'codex', version: 'new-codex', bundleSha256: null, route: 'official_rpc', adapterProtocol: 'codex-app-server-jsonl-v2' });
  const row = doctorReport({ now: 1, matrix, matrixPath: 'test', installed: [codex], registry }).harnesses[0];
  assert.equal(row.testedVersions.length, 0);
  assert.equal(registry.decide(codex, 'textInput').enabled, true);
  assert.equal(registry.decide(codex, 'textInput').state, 'unverified');
});

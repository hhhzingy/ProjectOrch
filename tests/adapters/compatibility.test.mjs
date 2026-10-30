import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeCompatibilityRegistry } from '../../apps/kernel/dist/native/compatibility.js';
const installed = { harnessId: 'zcode', version: 'synthetic-1.0.0', executableSha256: 'a'.repeat(64), bundleSha256: 'b'.repeat(64), adapterProtocol: 'zcode-cli-jsonl-v2', route: 'official_cli' };
const proof = () => ({ identity: { ...installed }, probeId: 'synthetic-probe', evidenceSha256: 'c'.repeat(64), capabilities: { textInput: 'verified', queue: 'unsupported' } });

test('未测试版本和程序哈希变化不封禁已实现能力，也不继承已测标记', () => {
  const registry = new NativeCompatibilityRegistry();
  assert.deepEqual(registry.decide(installed, 'textInput'), { state: 'unverified', enabled: true, reason: 'runtime_capability_available' });
  registry.recordTrustedProbe(proof());
  assert.equal(registry.decide(installed, 'textInput').state, 'verified');
  for (const patch of [{ version: 'future-99' }, { executableSha256: 'd'.repeat(64) }, { bundleSha256: 'e'.repeat(64) }]) {
    assert.deepEqual(registry.decide({ ...installed, ...patch }, 'textInput'), { state: 'unverified', enabled: true, reason: 'runtime_capability_available' });
  }
});

test('历史测试记录不能启用未实现能力，也不能成为基本能力的版本白名单', () => {
  const registry = new NativeCompatibilityRegistry();
  registry.recordTrustedProbe({ ...proof(), capabilities: { textInput: 'unsupported', queue: 'verified' } });
  assert.equal(registry.decide(installed, 'textInput').enabled, true);
  assert.equal(registry.decide(installed, 'textInput').state, 'unverified');
  assert.deepEqual(registry.decide(installed, 'queue'), { enabled: false, state: 'unsupported', reason: 'adapter_capability_unavailable' });
  assert.throws(() => registry.decide({ ...installed, route: 'modified_runtime_copy' }, 'textInput'), /INVALID_OFFICIAL_NATIVE_IDENTITY/);
  assert.throws(() => registry.recordTrustedProbe({ ...proof(), capabilities: { invented: 'verified' } }), /INVALID_NATIVE_CAPABILITY_PROOF/);
});

test('驱动能力声明跨版本生效，复制隔离且不受测试记录覆盖', () => {
  const registry = new NativeCompatibilityRegistry(), caps = ['historyRead'];
  registry.setAdapterCapabilities(installed, caps); caps.push('textInput');
  registry.recordTrustedProbe(proof());
  assert.equal(registry.decide(installed, 'textInput').enabled, false);
  assert.equal(registry.decide({ ...installed, version: 'future' }, 'historyRead').enabled, true);
  assert.equal(registry.decide({ ...installed, harnessId: 'codex' }, 'textInput').enabled, false);
  assert.throws(() => registry.setAdapterCapabilities(installed, ['invented']), /INVALID_ADAPTER_CAPABILITIES/);
  assert.ok(Object.isFrozen(registry.decide(installed, 'historyRead')));
});

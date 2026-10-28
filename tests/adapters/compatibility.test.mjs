import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeCompatibilityRegistry } from '../../apps/kernel/dist/native/compatibility.js';
const installed = { harnessId: 'zcode', version: 'synthetic-1.0.0', executableSha256: 'a'.repeat(64), bundleSha256: 'b'.repeat(64), adapterProtocol: 'synthetic-official-jsonl-v1', route: 'official_cli' };
const proof = () => ({ identity: { ...installed }, probeId: 'synthetic-probe', evidenceSha256: 'c'.repeat(64), capabilities: { textInput: 'verified', queue: 'unsupported', nativeCancel: 'unsupported' } });
test('未知版本默认关闭，原生/Node/bundle/适配协议/入口更新后旧证据不可沿用', () => {
  const registry = new NativeCompatibilityRegistry(); assert.equal(registry.decide(installed, 'textInput').reason, 'probe_required');
  registry.recordTrustedProbe(proof()); assert.equal(registry.decide(installed, 'textInput').enabled, true);
  for (const patch of [{ version: 'synthetic-1.1.0' }, { executableSha256: 'd'.repeat(64) }, { bundleSha256: 'e'.repeat(64) }, { adapterProtocol: 'synthetic-official-jsonl-v2' }, { route: 'official_rpc' }]) {
    const decision = registry.decide({ ...installed, ...patch }, 'textInput'); assert.equal(decision.enabled, false); assert.equal(decision.reason, 'native_or_adapter_updated');
  }
  const updated = { ...installed, version: 'synthetic-1.1.0', bundleSha256: 'e'.repeat(64) };
  registry.recordTrustedProbe({ ...proof(), identity: updated }); assert.equal(registry.decide(updated, 'textInput').enabled, true);
});
test('官方不支持/未探测能力不放行，原生补丁入口和自造能力拒绝', () => {
  const registry = new NativeCompatibilityRegistry(); registry.recordTrustedProbe(proof());
  assert.deepEqual(registry.decide(installed, 'queue'), { enabled: false, state: 'unsupported', reason: 'unsupported_by_official_route' });
  assert.equal(registry.decide(installed, 'roleTools').state, 'unverified');
  assert.throws(() => registry.decide({ ...installed, route: 'modified_runtime_copy' }, 'textInput'), /INVALID_OFFICIAL_NATIVE_IDENTITY/);
  assert.throws(() => registry.recordTrustedProbe({ ...proof(), capabilities: { invented: 'verified' } }), /INVALID_NATIVE_CAPABILITY_PROOF/);
  assert.throws(() => registry.recordTrustedProbe({ ...proof(), evidenceSha256: '' }), /INVALID_NATIVE_PROOF/);
});
test('探针输入复制隔离，修改旧对象不能扩大已登记能力或跨Harness使用', () => {
  const registry = new NativeCompatibilityRegistry(); const input = proof(); registry.recordTrustedProbe(input);
  input.capabilities.queue = 'verified'; input.identity.version = 'changed';
  assert.equal(registry.decide(installed, 'queue').enabled, false);
  assert.equal(registry.decide({ ...installed, harnessId: 'codex' }, 'textInput').enabled, false);
  assert.ok(Object.isFrozen(registry.decide(installed, 'textInput')));
});

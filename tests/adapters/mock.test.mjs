import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { MockAdapter } from '../../packages/adapter-mock/dist/index.js';
import { beginObservation, observeFrame } from '../../packages/adapter-contract/dist/events.js';
import { negotiateAdapter } from '../../packages/contracts/dist/index.js';
import { frame, registerAdapterSuite, syntheticSession } from './shared-suite.mjs';

registerAdapterSuite('Mock Adapter', () => {
  const adapter = new MockAdapter();
  return { adapter, inject: (...frames) => adapter.enqueue(...frames.map(value => ({ kind: 'event', frame: value }))) };
});

test('错误注入、连接代次复用和替代会话均显式拒绝', () => {
  const adapter = new MockAdapter();
  adapter.connect(syntheticSession, 'epoch-1');
  assert.throws(() => adapter.connect(syntheticSession, 'epoch-2'), /ALREADY_CONNECTED/);
  adapter.enqueue({ kind: 'error' });
  assert.throws(() => adapter.next(), /SIMULATED_TRANSPORT_ERROR/);
  assert.throws(() => adapter.next(), /ADAPTER_OFFLINE/);
  assert.throws(() => adapter.connect(syntheticSession, 'epoch-1'), /REUSED_EPOCH/);
  assert.throws(() => adapter.connect({ ...syntheticSession, nativeConversationId: 'replacement' }, 'epoch-2'), /SESSION_REPLACEMENT_FORBIDDEN/);
  adapter.connect(syntheticSession, 'epoch-2');
  adapter.enqueue({ kind: 'disconnect' });
  assert.throws(() => adapter.next(), /ADAPTER_OFFLINE/);
});

test('输入与观察快照隔离，模拟结果保持 unverified', () => {
  const adapter = new MockAdapter();
  adapter.connect(syntheticSession, 'connection-1');
  const input = frame(1, 'execution.snapshot', { status: 'idle', executionId: null });
  adapter.enqueue({ kind: 'event', frame: input });
  input.data.status = 'succeeded';
  assert.equal(adapter.next().data.status, 'idle');
  assert.equal(adapter.provenance, 'synthetic');
  assert.equal(adapter.capabilityState, 'unverified');
  assert.equal(Object.isFrozen(beginObservation(syntheticSession, 'connection-1')), true);
});

test('畸形及未知事件不能解除核对或产生成功', () => {
  const state = beginObservation(syntheticSession, 'connection-1');
  const invalid = [null, [], {}, frame(0, 'execution.snapshot', { status: 'idle', executionId: null }), frame(1, 'execution.snapshot', { status: 'idle', executionId: 'wrong' }), frame(1, 'execution.snapshot', { status: 'succeeded', executionId: null }), frame(1, 'execution.snapshot', { status: 'idle', executionId: null, admin: true }), frame(1, 'future.success', {}), frame(1, 'execution.snapshot', { status: 'idle', executionId: null }, { fromRoleId: 'admin' })];
  for (const value of invalid) {
    const result = observeFrame(state, value);
    assert.equal(result.observation.status, 'unknown');
    assert.equal(result.observation.needsReconcile, true);
  }
});

test('模拟声明与未知能力无法通过既有能力协商', () => {
  const adapter = new MockAdapter();
  const declaration = JSON.parse(readFileSync(new URL('../../contracts/examples/capabilities.json', import.meta.url), 'utf8'));
  declaration.protocolVersion = 'draft-v2';
  declaration.nativeVersion = 'synthetic-not-native';
  for (const capability of Object.values(declaration.capabilities)) {
    capability.state = adapter.capabilityState;
    capability.evidenceRefs = [];
  }
  assert.throws(() => negotiateAdapter([2], declaration, ['attachExisting']), e => e.reason === 'CAPABILITY_NOT_VERIFIED');
  assert.throws(() => negotiateAdapter([2], declaration, ['unknownFeature']), e => e.reason === 'UNKNOWN_CAPABILITY');
});

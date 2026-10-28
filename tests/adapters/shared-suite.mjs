import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beginObservation, disconnectObservation, observeFrame } from '../../packages/adapter-contract/dist/events.js';

export const syntheticSession = Object.freeze({ harnessId: 'synthetic', hostId: 'test-host', profileId: 'test-profile', nativeConversationId: 'fixture-session' });
export const frame = (sequence, type, data, overrides = {}) => ({ session: syntheticSession, connectionEpoch: 'connection-1', sequence, type, data, ...overrides });
const snapshot = (sequence = 1, status = 'idle', executionId = null) => frame(sequence, 'execution.snapshot', { status, executionId });

/** 工厂返回 {adapter, inject}：inject 由测试环境控制事件，不是生产接口。 */
export function registerAdapterSuite(name, createRig) {
  const setup = () => {
    const rig = createRig();
    rig.adapter.connect(syntheticSession, 'connection-1');
    let state = beginObservation(syntheticSession, 'connection-1');
    return { ...rig, get state() { return state; }, read() { const input = rig.adapter.next(); assert.notEqual(input, null); const result = observeFrame(state, input); state = result.observation; return result; } };
  };
  test(`${name}: 快照核对后允许执行，终态仅接受当前执行`, () => {
    const rig = setup();
    rig.inject(snapshot(), frame(2, 'execution.started', { executionId: 'exec-1' }), frame(3, 'execution.completed', { executionId: 'exec-1', outcome: 'succeeded' }));
    assert.equal(rig.read().reason, 'SNAPSHOT');
    assert.equal(rig.read().observation.status, 'running');
    assert.equal(rig.read().observation.status, 'succeeded');
    assert.equal(rig.adapter.next(), null);
  });
  test(`${name}: 缺号、乱序、重复和未知事件均不能伪造成功`, () => {
    const rig = setup();
    rig.inject(snapshot(), frame(3, 'execution.completed', { executionId: 'exec-1', outcome: 'succeeded' }), frame(2, 'execution.started', { executionId: 'exec-1' }), frame(2, 'execution.started', { executionId: 'exec-1' }), frame(3, 'future.succeeded', {}));
    rig.read();
    assert.equal(rig.read().reason, 'SEQUENCE_GAP');
    assert.equal(rig.read().reason, 'SNAPSHOT_REQUIRED');
    assert.equal(rig.read().observation.status, 'unknown');
    assert.equal(rig.read().observation.needsReconcile, true);
    rig.inject(snapshot(4), frame(4, 'execution.completed', { executionId: 'old', outcome: 'succeeded' }));
    assert.equal(rig.read().observation.status, 'idle');
    assert.equal(rig.read().reason, 'DUPLICATE_OR_OLD');
  });
  test(`${name}: 不同会话、旧连接代次和旧执行不能完成当前执行`, () => {
    const rig = setup();
    rig.inject(snapshot(1, 'running', 'exec-current'), frame(2, 'execution.completed', { executionId: 'exec-current', outcome: 'succeeded' }, { session: { ...syntheticSession, profileId: 'other' } }), frame(2, 'execution.completed', { executionId: 'exec-current', outcome: 'succeeded' }, { connectionEpoch: 'old-connection' }), frame(2, 'execution.completed', { executionId: 'exec-old', outcome: 'succeeded' }));
    rig.read();
    assert.equal(rig.read().reason, 'OTHER_SESSION');
    assert.equal(rig.read().reason, 'STALE_CONNECTION');
    assert.equal(rig.read().reason, 'EXECUTION_TARGET_CHANGED');
    assert.equal(rig.state.status, 'unknown');
    assert.equal(rig.state.executionId, 'exec-current');
  });
  test(`${name}: 断连保留未知占用，同一会话新连接先核对`, () => {
    const rig = setup();
    rig.inject(snapshot(1, 'running', 'exec-1'));
    rig.read();
    rig.adapter.disconnect();
    assert.throws(() => rig.adapter.next(), /ADAPTER_OFFLINE/);
    const offline = disconnectObservation(rig.state);
    assert.equal(offline.executionId, 'exec-1');
    assert.equal(offline.status, 'unknown');
    assert.equal(observeFrame(offline, frame(2, 'execution.completed', { executionId: 'exec-1', outcome: 'succeeded' })).reason, 'OFFLINE');
    rig.adapter.connect(syntheticSession, 'connection-2');
    let state = beginObservation(syntheticSession, 'connection-2');
    rig.inject(frame(2, 'execution.completed', { executionId: 'exec-1', outcome: 'succeeded' }), frame(1, 'execution.completed', { executionId: 'exec-1', outcome: 'succeeded' }, { connectionEpoch: 'connection-2' }), { ...snapshot(2, 'running', 'exec-1'), connectionEpoch: 'connection-2' });
    assert.equal(observeFrame(state, rig.adapter.next()).reason, 'STALE_CONNECTION');
    const result = observeFrame(state, rig.adapter.next());
    assert.equal(result.reason, 'SNAPSHOT_REQUIRED');
    state = result.observation;
    assert.equal(observeFrame(state, rig.adapter.next()).observation.status, 'running');
  });
  test(`${name}: 失败终态保留失败，未知状态必须继续核对`, () => {
    const rig = setup();
    rig.inject(snapshot(), frame(2, 'execution.started', { executionId: 'exec-1' }), frame(3, 'execution.completed', { executionId: 'exec-1', outcome: 'failed' }), snapshot(4, 'unknown', 'exec-1'));
    rig.read(); rig.read();
    assert.equal(rig.read().observation.status, 'failed');
    assert.equal(rig.read().observation.needsReconcile, true);
  });
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { KernelObservationHost } from '../../apps/kernel/dist/adapters/observation-host.js';
import { MockAdapter } from '../../packages/adapter-mock/dist/index.js';
const session = { harnessId: 'synthetic', hostId: 'synthetic-host', profileId: 'synthetic-profile', nativeConversationId: 'synthetic-conversation' };
function fixture() {
  const adapter = new MockAdapter(); const host = new KernelObservationHost(adapter, session, 'synthetic-epoch-1');
  const event = (sequence, type, data, patch = {}) => ({ kind: 'event', frame: { session, connectionEpoch: 'synthetic-epoch-1', sequence, type, data, ...patch } });
  return { adapter, host, event };
}
test('内核观察消费合同事件，正常运行/完成不跳过新快照派发条件', () => {
  const { adapter, host, event } = fixture();
  assert.equal(host.observationAllowsDispatch, false);
  adapter.enqueue(event(1, 'execution.snapshot', { status: 'idle', executionId: null })); host.poll();
  assert.equal(host.observationAllowsDispatch, true);
  adapter.enqueue(event(2, 'execution.started', { executionId: 'synthetic-run' })); host.poll();
  assert.equal(host.snapshot.status, 'running'); assert.equal(host.observationAllowsDispatch, false);
  adapter.enqueue(event(3, 'execution.completed', { executionId: 'synthetic-run', outcome: 'succeeded' })); host.poll();
  assert.equal(host.snapshot.status, 'succeeded'); assert.equal(host.observationAllowsDispatch, false);
  adapter.enqueue(event(4, 'execution.snapshot', { status: 'idle', executionId: null })); host.poll();
  assert.equal(host.observationAllowsDispatch, true);
});
test('内核对乱序/未知/错目标/断连保守核对，不能将任意事件当成功', () => {
  for (const scenario of ['gap', 'unknown', 'wrong-target', 'disconnect', 'error']) {
    const { adapter, host, event } = fixture();
    adapter.enqueue(event(1, 'execution.snapshot', { status: 'running', executionId: 'synthetic-run' })); host.poll();
    if (scenario === 'disconnect' || scenario === 'error') adapter.enqueue({ kind: scenario });
    else adapter.enqueue(event(scenario === 'gap' ? 3 : 2, scenario === 'unknown' ? 'invented.success' : 'execution.completed', { executionId: scenario === 'wrong-target' ? 'other-run' : 'synthetic-run', outcome: 'succeeded' }));
    host.poll(); assert.equal(host.snapshot.status, 'unknown', scenario); assert.equal(host.observationAllowsDispatch, false);
  }
});
test('重连要求同会话新代次，旧事件无效且新代次必须先快照', () => {
  const { adapter, host, event } = fixture();
  host.disconnect();
  assert.throws(() => host.reconnect({ ...session, nativeConversationId: 'fork' }, 'epoch-2'));
  assert.throws(() => host.reconnect(session, 'synthetic-epoch-1'));
  host.reconnect(session, 'epoch-2');
  adapter.enqueue(event(1, 'execution.snapshot', { status: 'idle', executionId: null }));
  assert.equal(host.poll()[0].disposition, 'ignored'); assert.equal(host.observationAllowsDispatch, false);
  adapter.enqueue(event(1, 'execution.snapshot', { status: 'idle', executionId: null }, { connectionEpoch: 'epoch-2' })); host.poll();
  assert.equal(host.observationAllowsDispatch, true);
  assert.equal(adapter.capabilityState, 'unverified');
  assert.throws(() => host.poll(0));
});

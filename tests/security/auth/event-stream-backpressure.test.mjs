/** ZR-08背压专项：慢客户端（write永远false且从不drain）下回放有界；drain后继续；authorize撤销立即终止。内存库+合成响应对象，不涉网关。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { openEventStream } from '../../../apps/kernel/dist/http/event-stream.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';
import path from 'node:path';

function fakeResponse() {
  const state = { writes: 0, bytes: 0, destroyed: false, ended: false };
  const listeners = {};
  return {
    state,
    writeHead() {},
    write(text) { state.writes += 1; state.bytes += Buffer.byteLength(text); return false; },
    once(event, handler) { listeners[event] ??= []; listeners[event].push(handler); },
    off(event, handler) { listeners[event] = (listeners[event] ?? []).filter(f => f !== handler); },
    destroy() { if (state.destroyed) return; state.destroyed = true; for (const handler of listeners.close ?? []) handler(); },
    get destroyed() { return state.destroyed; },
    get writableEnded() { return state.ended; },
    emitDrain() { for (const handler of [...(listeners.drain ?? [])]) handler(); },
  };
}

function seedEvents(store, projectId, count) {
  const insert = store.db.prepare("INSERT INTO events(id,project_id,type,entity_id,entity_revision,causation_id,body_json,occurred_at) VALUES(?,?,?,?,?,?,?,?)");
  store.transaction(db => {
    for (let i = 1; i <= count; i++) insert.run(`evt-${i}`, projectId, 'synthetic.event', projectId, i, null, JSON.stringify({ i, pad: 'x'.repeat(64) }), i);
  });
}

test('慢客户端背压：600条历史在无drain时写入有界；drain后继续推进；authorize撤销立即终止', async t => {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-sse-backpressure-', () => { for (const s of stores) s.close(); });
  const store = openStore(path.join(dir, 'state.sqlite'));
  stores.push(store);
  store.transaction(db => db.prepare("INSERT INTO projects(id,name,host_id,canonical_root,objective,created_at) VALUES('p1','s','h','E:/synthetic/bp','o',0)").run());
  seedEvents(store, 'p1', 600);
  let authorized = true;
  const response = fakeResponse();
  openEventStream(response, { store, projectIds: ['p1'], fromSequence: 0, authorize: () => authorized, pollMs: 50, heartbeatMs: 1000 });
  await new Promise(r => setTimeout(r, 500));
  assert.ok(response.state.writes <= 3, `无drain时写入必须有界，实际 ${response.state.writes}`);
  assert.ok(response.state.bytes < 300 * 1024, `无drain时字节必须有界，实际 ${response.state.bytes}`);
  // 授权撤销：即使有积压也必须终止（流销毁，不再推进）
  authorized = false;
  await new Promise(r => setTimeout(r, 200));
  assert.equal(response.state.destroyed, true, 'authorize为false必须关闭流');
  // 新流：每次drain后继续推进直至完成回放
  authorized = true;
  const response2 = fakeResponse();
  openEventStream(response2, { store, projectIds: ['p1'], fromSequence: 0, authorize: () => authorized, pollMs: 20, heartbeatMs: 60_000 });
  for (let round = 0; round < 700 && !response2.state.destroyed; round++) { response2.emitDrain(); await new Promise(r => setImmediate(r)); }
  const finalWrites = response2.state.writes;
  assert.ok(finalWrites >= 601, `drain后应完成全部回放（600事件+retry），实际写入 ${finalWrites} 次`);
  assert.ok(finalWrites <= 610, `单pump互斥+游标推进不得重复发送，实际写入 ${finalWrites} 次`);
  assert.equal(response2.state.destroyed, false, '正常回放不得被销毁');
  response2.destroy();
});

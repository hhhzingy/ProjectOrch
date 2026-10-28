import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../packages/persistence/dist/index.js';
import { createProject } from '../../packages/domain/dist/projects/index.js';
import { createRole } from '../../packages/domain/dist/roles/index.js';
import { sendMessage } from '../../packages/domain/dist/messages/index.js';
import { conversationPage, updateNativeCursor, ingestNativeItems } from '../../packages/domain/dist/conversation/index.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-ingest-', () => { for (const s of stores) s.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const open = () => { const s = openStore(filename); stores.push(s); return s; };
  const store = open();
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: 'E:/synthetic/ing', objective: 'o' }, 100);
  createRole(store, { id: 'r1', projectId: 'p1', name: 'r', charter: 'c', permissionProfileId: 'worker' }, 101);
  store.transaction(db => db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s1','synthetic','h','p','n1')").run());
  store.transaction(db => db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('c1','p1','u','rq1',?,'project.pause','{}','completed',100)").run('0'.repeat(64)));
  return { store, open };
}
const item = (id, revision, occurredAt, text) => ({ itemId: id, revision, occurredAt, kind: 'native', content: { text } });

test('投影写入接线：UPSERT幂等、分页读取、与业务消息共存、跨重启持久（T022正式写入侧）', t => {
  const { store, open } = fixture(t);
  const first = ingestNativeItems(store, 's1', { epoch: 'epoch-1', cursor: 'rev-2', snapshotRevision: 'snap-1', items: [item('item-1', 'rev-1', 100, '第一条'), item('item-2', 'rev-2', 200, '第二条')] }, 150);
  assert.equal(first.upserted, 2);
  const page1 = conversationPage(store, 's1', { limit: 10 });
  assert.deepEqual(page1.items.map(i => i.itemId), ['item-1', 'item-2']);
  assert.equal(page1.gapDetected, false);
  // UPSERT：同PK重放更新内容不新增行
  const replay = ingestNativeItems(store, 's1', { epoch: 'epoch-1', cursor: 'rev-2', snapshotRevision: 'snap-1', items: [item('item-1', 'rev-1', 100, '第一条-更新')] }, 160);
  assert.equal(replay.upserted, 1, '重放仅含item-1');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM transcript_items WHERE session_id='s1'").get().n, 2, 'UPSERT不新增行');
  // 与业务消息共存：message事件在SSE流但conversationPage只聚合native条目
  const message = sendMessage(store, { id: 'm1', projectId: 'p1', commandId: 'c1', toRoleId: 'r1', kind: 'notice', body: '业务消息' }, 170);
  void message;
  const page = conversationPage(store, 's1');
  assert.equal(page.items.filter(i => i.source === 'message').length, 0, 'conversationPage为native投影视图');
  store.close();
  const reopened = open();
  assert.equal(conversationPage(reopened, 's1').items.length, 2, '跨重启持久');
});

test('游标推进与缺口检测联动：ingest推进cursor后gap消失', t => {
  const { store } = fixture(t);
  ingestNativeItems(store, 's1', { epoch: 'epoch-1', cursor: 'rev-1', snapshotRevision: 'snap-1', items: [item('item-1', 'rev-1', 100, '第一条')] }, 150);
  // 断言初始gap状态（cursor rev-1 == max rev-1 → 无缺口）
  assert.equal(conversationPage(store, 's1').gapDetected, false);
  // 后续ingest推进到rev-2仍无缺口；ingest一个落后cursor不回退
  ingestNativeItems(store, 's1', { epoch: 'epoch-1', cursor: 'rev-2', snapshotRevision: 'snap-2', items: [item('item-2', 'rev-2', 200, '第二条')] }, 160);
  assert.equal(conversationPage(store, 's1').items.length, 2);
  assert.equal(conversationPage(store, 's1').gapDetected, false);
});

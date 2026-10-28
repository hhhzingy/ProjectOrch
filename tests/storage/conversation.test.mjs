import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../packages/persistence/dist/index.js';
import { conversationPage, updateNativeCursor } from '../../packages/domain/dist/conversation/index.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-conversation-', () => { for (const s of stores) s.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const open = () => { const s = openStore(filename); stores.push(s); return s; };
  const store = open();
  store.transaction(db => {
    db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s1','synthetic','h','p','n1')").run();
    for (const [itemId, revision, occurredAt] of [['item-1', 'rev-1', 100], ['item-2', 'rev-2', 200], ['item-3', 'rev-3', 300]]) {
      db.prepare("INSERT INTO transcript_items(session_id,native_item_id,native_revision,visible_json) VALUES('s1',?,?,?)").run(itemId, revision, JSON.stringify({ kind: 'native', occurredAt, text: `内容${occurredAt}` }));
    }
    db.prepare("INSERT INTO native_cursors(session_id,epoch,cursor,snapshot_revision,observed_at) VALUES('s1','epoch-1','rev-3','snap-1',300)").run();
  });
  return { store, open };
}

test('对话面板：时间排序、分页水位、gap检测（R008增量与缺口恢复）', t => {
  const { store, open } = fixture(t);
  const page1 = conversationPage(store, 's1', { limit: 2 });
  assert.equal(page1.items.length, 2);
  assert.deepEqual(page1.items.map(item => item.itemId), ['item-1', 'item-2'], '按occurredAt排序');
  assert.ok(page1.nextCursor !== null);
  const page2 = conversationPage(store, 's1', { cursorOccurredAt: page1.nextCursor.occurredAt, cursorLastId: page1.nextCursor.lastId, limit: 2 });
  assert.deepEqual(page2.items.map(item => item.itemId), ['item-3']);
  assert.equal(page2.gapDetected, false, '游标与transcript一致无缺口');
  // 游标落后（断线期间漏收）：gapDetected提示需缺口恢复
  updateNativeCursor(store, 's1', 'epoch-1', 'rev-1', 'snap-1', 400);
  const stale = conversationPage(store, 's1');
  assert.equal(stale.gapDetected, true, '游标落后于transcript提示缺口恢复');
  assert.equal(stale.nativeCursor, 'rev-1');
  // 游标恢复一致
  updateNativeCursor(store, 's1', 'epoch-1', 'rev-3', 'snap-3', 500);
  assert.equal(conversationPage(store, 's1').gapDetected, false);
  // 会话隔离与缺失拒绝
  assert.throws(() => conversationPage(store, 's-missing'), /VIEW_SESSION_NOT_FOUND/);
  store.close();
  const reopened = open();
  assert.equal(conversationPage(reopened, 's1').items.length, 3, '跨重启持久');
});

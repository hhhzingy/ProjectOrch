import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../packages/persistence/dist/index.js';
import { createProject, pauseProjectForUser } from '../../packages/domain/dist/projects/index.js';
import { createRole } from '../../packages/domain/dist/roles/index.js';
import { sendMessage, markDelivered, acknowledgeMessage, resolveMessage, inboxRead } from '../../packages/domain/dist/messages/index.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-messages-', () => { for (const s of stores) s.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const open = () => { const s = openStore(filename); stores.push(s); return s; };
  const store = open();
  createProject(store, { id: 'p1', name: 'synthetic', hostId: 'host', canonicalRoot: 'E:/synthetic/msg', objective: 'o' }, 100);
  createRole(store, { id: 'r-worker', projectId: 'p1', name: 'worker', charter: 'c', permissionProfileId: 'worker' }, 101);
  store.transaction(db => db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('cmd1','p1','u','rq1',?,'project.pause','{}','completed',100)").run('0'.repeat(64)));
  return { store, open };
}
const send = (store, id, roleId = 'r-worker', at = 110) => sendMessage(store, { id, projectId: 'p1', commandId: 'cmd1', toRoleId: roleId, kind: 'task.notice', body: `body-${id}` }, at);

test('收件箱状态机：stored→delivered→acknowledged→resolved，各状态迁移记录在delivery_json（A036）', t => {
  const { store } = fixture(t);
  const message = send(store, 'm1');
  assert.equal(message.state, 'stored');
  assert.throws(() => acknowledgeMessage(store, 'p1', 'm1', 'r-worker', 111), /MESSAGE_TRANSITION_REJECTED/, '未投递不得确认');
  const delivered = markDelivered(store, 'p1', 'm1', { receipt: 'transport-1' }, 112);
  assert.equal(delivered.state, 'delivered');
  const acknowledged = acknowledgeMessage(store, 'p1', 'm1', 'r-worker', 113);
  assert.equal(acknowledged.state, 'acknowledged');
  const resolved = resolveMessage(store, 'p1', 'm1', 'r-worker', 114);
  assert.equal(resolved.state, 'resolved');
  const delivery = JSON.parse(store.db.prepare("SELECT delivery_json FROM messages WHERE id='m1'").get().delivery_json);
  assert.deepEqual(delivery.transitions.map(step => step.state), ['stored', 'delivered', 'acknowledged', 'resolved']);
  assert.deepEqual(delivery.transitions[1].receipt, { receipt: 'transport-1' }, '回执持久');
  assert.throws(() => markDelivered(store, 'p1', 'm1', {}, 115), /MESSAGE_TRANSITION_REJECTED/, 'resolved为终态');
});

test('非接收角色不得确认或处理；未知消息与角色拒绝（A036安全面）', t => {
  const { store } = fixture(t);
  createRole(store, { id: 'r-other', projectId: 'p1', name: 'other', charter: 'c', permissionProfileId: 'worker' }, 102);
  send(store, 'm2');
  markDelivered(store, 'p1', 'm2', {}, 120);
  assert.throws(() => acknowledgeMessage(store, 'p1', 'm2', 'r-other', 121), /MESSAGE_NOT_RECIPIENT/, '非接收者不得确认');
  assert.throws(() => resolveMessage(store, 'p1', 'm2', 'r-other', 122), /MESSAGE_NOT_RECIPIENT/);
  assert.throws(() => acknowledgeMessage(store, 'p1', 'missing', 'r-worker', 123), /MESSAGE_NOT_FOUND/);
  assert.throws(() => sendMessage(store, { id: 'm3', projectId: 'p1', commandId: 'cmd1', toRoleId: 'r-missing', kind: 'k', body: 'b' }, 124), /MESSAGE_ROLE_NOT_FOUND/);
});

test('停用接收角色：待办保持原状态可追踪、不误报已处理；重启用后恢复流转', t => {
  const { store, open } = fixture(t);
  send(store, 'm4');
  markDelivered(store, 'p1', 'm4', {}, 130);
  setRoleDisabled(store, 131);
  assert.throws(() => acknowledgeMessage(store, 'p1', 'm4', 'r-worker', 132), /MESSAGE_ROLE_NOT_ENABLED/, '停用角色不得确认（待办不误报已处理）');
  const inbox = inboxRead(store, 'p1', 'r-worker', { states: ['delivered'] });
  assert.equal(inbox.items.length, 1, '停用期间收件箱仍可读、可追踪');
  assert.equal(inbox.items[0].state, 'delivered');
  store.db.exec("UPDATE roles SET desired_state='enabled' WHERE id='r-worker'");
  assert.equal(acknowledgeMessage(store, 'p1', 'm4', 'r-worker', 133).state, 'acknowledged', '重启用后恢复流转');
});
function setRoleDisabled(store, now) {
  store.db.prepare("UPDATE roles SET desired_state='disabled',revision=revision+1 WHERE id='r-worker'").run();
  const row = store.db.prepare("SELECT desired_state,binding_state FROM roles WHERE id='r-worker'").get();
  store.db.prepare("INSERT INTO role_revisions(role_id,project_id,revision,snapshot_json) VALUES('r-worker','p1',(SELECT revision FROM roles WHERE id='r-worker'),?)").run(JSON.stringify({ desiredState: row.desired_state, bindingState: row.binding_state }));
  void now;
}

test('收件箱分页：仅本人消息、状态过滤、cursor翻页、跨重启持久', t => {
  const { store, open } = fixture(t);
  createRole(store, { id: 'r-b', projectId: 'p1', name: 'b', charter: 'c', permissionProfileId: 'worker' }, 140);
  for (const [id, at] of [['m-a', 150], ['m-b', 151], ['m-c', 152]]) send(store, id, 'r-worker', at);
  send(store, 'm-other', 'r-b', 153);
  const page1 = inboxRead(store, 'p1', 'r-worker', { limit: 2 });
  assert.equal(page1.items.length, 2);
  assert.deepEqual(page1.items.map(m => m.id), ['m-a', 'm-b']);
  assert.equal(typeof page1.nextCursor, 'string');
  const page2 = inboxRead(store, 'p1', 'r-worker', { limit: 2, cursor: page1.nextCursor });
  assert.deepEqual(page2.items.map(m => m.id), ['m-c']);
  assert.equal(page2.nextCursor, null);
  markDelivered(store, 'p1', 'm-a', {}, 160);
  const deliveredOnly = inboxRead(store, 'p1', 'r-worker', { states: ['delivered'] });
  assert.deepEqual(deliveredOnly.items.map(m => m.id), ['m-a']);
  const otherInbox = inboxRead(store, 'p1', 'r-b');
  assert.deepEqual(otherInbox.items.map(m => m.id), ['m-other'], '收件箱仅本人消息');
  store.close();
  const reopened = open();
  assert.equal(inboxRead(reopened, 'p1', 'r-worker').items.length, 3, '重启后消息持久');
});

test('同毫秒收件箱不漏页，游标不可跨角色/筛选复用，快照变化要求重读', t => {
  const { store } = fixture(t);
  createRole(store, { id: 'r-peer', projectId: 'p1', name: 'peer', charter: 'c', permissionProfileId: 'worker' }, 140);
  for (const id of ['same-a', 'same-b', 'same-c']) send(store, id, 'r-worker', 150);
  const first = inboxRead(store, 'p1', 'r-worker', { limit: 1 });
  const second = inboxRead(store, 'p1', 'r-worker', { limit: 1, cursor: first.nextCursor });
  const third = inboxRead(store, 'p1', 'r-worker', { limit: 1, cursor: second.nextCursor });
  assert.deepEqual([...first.items, ...second.items, ...third.items].map(item => item.id), ['same-a', 'same-b', 'same-c']);
  assert.equal(third.nextCursor, null);
  assert.throws(() => inboxRead(store, 'p1', 'r-peer', { cursor: first.nextCursor }), /INBOX_CURSOR_STALE/);
  assert.throws(() => inboxRead(store, 'p1', 'r-worker', { states: ['stored'], cursor: first.nextCursor }), /INBOX_CURSOR_STALE/);
  assert.throws(() => inboxRead(store, 'p1', 'r-worker', { cursor: 150 }), /INVALID_INBOX_CURSOR/);
  markDelivered(store, 'p1', 'same-a', {}, 160);
  assert.throws(() => inboxRead(store, 'p1', 'r-worker', { cursor: first.nextCursor }), /INBOX_CURSOR_STALE/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../packages/persistence/dist/index.js';
import { createProject } from '../../packages/domain/dist/projects/index.js';
import { createRole } from '../../packages/domain/dist/roles/index.js';
import { sendMessage, markDelivered, acknowledgeMessage, inboxRead, dispatchQueuedForEnabledRoles, wakeBacklog } from '../../packages/domain/dist/messages/index.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-conditional-', () => { for (const s of stores) s.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const open = () => { const s = openStore(filename); stores.push(s); return s; };
  const store = open();
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: 'E:/synthetic/cond', objective: 'o' }, 100);
  createRole(store, { id: 'r-a', projectId: 'p1', name: 'a', charter: 'c', permissionProfileId: 'worker' }, 101);
  createRole(store, { id: 'r-b', projectId: 'p1', name: 'b', charter: 'c', permissionProfileId: 'worker' }, 102);
  store.transaction(db => db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('cmd1','p1','u','rq1',?,'project.pause','{}','completed',100)").run('0'.repeat(64)));
  return { store, open };
}

test('条件投递：停用角色消息保持stored可追踪；启用后dispatch放行→投递→确认（T025/A037准备）', t => {
  const { store } = fixture(t);
  sendMessage(store, { id: 'm-block', projectId: 'p1', commandId: 'cmd1', toRoleId: 'r-a', kind: 'task.notice', body: '停用期间到达' }, 110);
  store.db.prepare("UPDATE roles SET desired_state='disabled' WHERE id='r-a'").run();
  // 停用期间dispatch不投递
  const blocked = dispatchQueuedForEnabledRoles(store, 'p1', 120);
  assert.deepEqual(blocked, { dispatched: 0, blocked: 1 }, '停用角色消息计入blocked不投递');
  assert.equal(inboxRead(store, 'p1', 'r-a', { states: ['stored'] }).items.length, 1, '停用积压可追踪');
  // 启用后dispatch放行
  store.db.prepare("UPDATE roles SET desired_state='enabled' WHERE id='r-a'").run();
  const dispatched = dispatchQueuedForEnabledRoles(store, 'p1', 121);
  assert.equal(dispatched.dispatched, 1);
  assert.equal(store.db.prepare("SELECT state FROM messages WHERE id='m-block'").get().state, 'queued');
  // queued→delivered→acknowledged全链
  markDelivered(store, 'p1', 'm-block', { transport: 't1' }, 130);
  assert.equal(acknowledgeMessage(store, 'p1', 'm-block', 'r-a', 131).state, 'acknowledged');
});

test('唤醒待办：仅启用角色计数；dispatch幂等（重复调用不重复放行）', t => {
  const { store, open } = fixture(t);
  sendMessage(store, { id: 'm1', projectId: 'p1', commandId: 'cmd1', toRoleId: 'r-a', kind: 'k', body: 'b' }, 110);
  sendMessage(store, { id: 'm2', projectId: 'p1', commandId: 'cmd1', toRoleId: 'r-a', kind: 'k', body: 'b' }, 111);
  sendMessage(store, { id: 'm3', projectId: 'p1', commandId: 'cmd1', toRoleId: 'r-b', kind: 'k', body: 'b' }, 112);
  const backlog = wakeBacklog(store, 'p1');
  assert.deepEqual(backlog, [{ roleId: 'r-a', stored: 2 }, { roleId: 'r-b', stored: 1 }]);
  dispatchQueuedForEnabledRoles(store, 'p1', 120);
  dispatchQueuedForEnabledRoles(store, 'p1', 121);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE state='queued'").get().n, 3, '重复dispatch幂等');
  assert.deepEqual(wakeBacklog(store, 'p1'), [], '放行后唤醒清单清空');
  store.close();
  const reopened = open();
  assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE state='queued'").get().n, 3, '重启后状态持久');
});

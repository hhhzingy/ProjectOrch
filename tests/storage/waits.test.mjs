import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../packages/persistence/dist/index.js';
import { createProject } from '../../packages/domain/dist/projects/index.js';
import { createTask } from '../../packages/domain/dist/tasks/index.js';
import { createWait, resolveWait, cancelWait, expiredWaits, readWait } from '../../packages/domain/dist/waits/index.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-waits-', () => { for (const s of stores) s.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const open = () => { const s = openStore(filename); stores.push(s); return s; };
  const store = open();
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: 'E:/synthetic/waits', objective: 'o' }, 100);
  createTask(store, { id: 't1', projectId: 'p1', goal: 'g1' }, 101);
  createTask(store, { id: 't2', projectId: 'p1', goal: 'g2' }, 102);
  for (const [id, state] of [['t1', 'waiting'], ['t2', 'waiting']]) store.db.prepare("UPDATE tasks SET state=? WHERE id=?").run(state, id);
  store.transaction(db => {
    db.prepare("INSERT INTO roles(id,project_id,name,charter,permission_profile,desired_state,binding_state) VALUES('r1','p1','r','c','worker','enabled','unbound')").run();
    db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s1','synthetic','h','p','n1')").run();
    db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b1','p1','r1','s1',1,100)").run();
    for (const [attemptId, taskId] of [['at1', 't1'], ['at2', 't2']]) {
      const exists = db.prepare("SELECT 1 FROM task_revisions WHERE task_id=? AND project_id='p1' AND revision=1").get(taskId);
      if (!exists) db.prepare("INSERT INTO task_revisions(task_id,project_id,revision,snapshot_json) VALUES(?, 'p1', 1, '{}')").run(taskId);
      db.prepare("INSERT INTO attempts(id,project_id,task_id,task_revision,binding_id,binding_epoch,state,started_at) VALUES(?, 'p1', ?, 1, 'b1', 1, 'waiting_input', 100)").run(attemptId, taskId);
    }
  });
  return { store, open };
}
const target = { kind: 'question', questionId: 'q1' };

test('创建等待：任务waiting态+deadline未来+互等环拒绝（T032/A047准备）', t => {
  const { store } = fixture(t);
  const wait = createWait(store, { id: 'w1', projectId: 'p1', taskId: 't1', taskRevision: 1, attemptId: 'at1', bindingId: 'b1', bindingEpoch: 1, target, deadline: 500, onTimeout: 'raise_issue' }, 110);
  assert.equal(wait.state, 'waiting');
  assert.deepEqual(wait.target, target);
  // 互等：t2等待同一target→环拒绝
  assert.throws(() => createWait(store, { id: 'w2', projectId: 'p1', taskId: 't2', taskRevision: 1, attemptId: 'at2', bindingId: 'b1', bindingEpoch: 1, target, deadline: 500, onTimeout: 'cancel_attempt' }, 111), /WAIT_DEADLOCK/, '互等环拒绝');
  // 同任务重复等待同一target允许（重试场景）——不同id
  for (const bad of [
    { id: 'w3', projectId: 'p1', taskId: 't-missing', taskRevision: 1, attemptId: 'at1', bindingId: 'b1', bindingEpoch: 1, target, deadline: 500, onTimeout: 'raise_issue' },
    { id: 'w3', projectId: 'p1', taskId: 't1', taskRevision: 9, attemptId: 'at1', bindingId: 'b1', bindingEpoch: 1, target, deadline: 500, onTimeout: 'raise_issue' },
    { id: 'w3', projectId: 'p1', taskId: 't1', taskRevision: 1, attemptId: 'at-missing', bindingEpoch: 1, target, deadline: 500, onTimeout: 'raise_issue' },
    { id: 'w3', projectId: 'p1', taskId: 't1', taskRevision: 1, attemptId: 'at1', bindingId: 'b1', bindingEpoch: 1, target: { kind: 'bogus', x: 1 }, deadline: 500, onTimeout: 'raise_issue' },
    { id: 'w3', projectId: 'p1', taskId: 't1', taskRevision: 1, attemptId: 'at1', bindingId: 'b1', bindingEpoch: 1, target, deadline: 90, onTimeout: 'raise_issue' },
    { id: 'w3', projectId: 'p1', taskId: 't1', taskRevision: 1, attemptId: 'at1', bindingId: 'b1', bindingEpoch: 1, target, deadline: 500, onTimeout: 'whatever' },
  ]) assert.throws(() => createWait(store, bad, 112), /WAIT_|INVALID_WAIT_/);
});

test('取消请求与停止确认分离：cancelled只表请求撤回（R021）；resolved终态', t => {
  const { store } = fixture(t);
  createWait(store, { id: 'w-a', projectId: 'p1', taskId: 't1', taskRevision: 1, attemptId: 'at1', bindingId: 'b1', bindingEpoch: 1, target: { kind: 'issue', caseId: 'case-1' }, deadline: 500, onTimeout: 'cancel_attempt' }, 110);
  const cancelled = cancelWait(store, 'p1', 'w-a', 111);
  assert.equal(cancelled.cancelRequested, true, '取消请求标记');
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(readWait(store, 'p1', 'w-a').state, 'cancelled');
  assert.throws(() => resolveWait(store, 'p1', 'w-a', 112), /WAIT_TRANSITION_REJECTED/, 'cancelled不可再resolved');
  // resolved终态
  createWait(store, { id: 'w-b', projectId: 'p1', taskId: 't1', taskRevision: 1, attemptId: 'at1', bindingId: 'b1', bindingEpoch: 1, target: { kind: 'issue', caseId: 'case-1' }, deadline: 500, onTimeout: 'raise_issue' }, 113);
  assert.equal(resolveWait(store, 'p1', 'w-b', 114).state, 'resolved');
  assert.throws(() => cancelWait(store, 'p1', 'w-b', 115), /WAIT_TRANSITION_REJECTED/);
});

test('超时处置清单：deadline已过的waiting按on_timeout分类返回', t => {
  const { store, open } = fixture(t);
  createTask(store, { id: 't3', projectId: 'p1', goal: 'g3' }, 103);
  store.db.prepare("UPDATE tasks SET state='waiting' WHERE id='t3'").run();
  store.transaction(db => {
    db.prepare("INSERT OR IGNORE INTO task_revisions(task_id,project_id,revision,snapshot_json) VALUES('t3','p1',1,'{}')").run();
    db.prepare("INSERT INTO attempts(id,project_id,task_id,task_revision,binding_id,binding_epoch,state,started_at) VALUES('at3','p1','t3',1,'b1',1,'running',100)").run();
  });
  createWait(store, { id: 'w-raise', projectId: 'p1', taskId: 't1', taskRevision: 1, attemptId: 'at1', bindingId: 'b1', bindingEpoch: 1, target: { kind: 'issue', caseId: 'case-r' }, deadline: 200, onTimeout: 'raise_issue' }, 110);
  createWait(store, { id: 'w-cancel', projectId: 'p1', taskId: 't2', taskRevision: 1, attemptId: 'at2', bindingId: 'b1', bindingEpoch: 1, target: { kind: 'issue', caseId: 'case-c' }, deadline: 300, onTimeout: 'cancel_attempt' }, 111);
  createWait(store, { id: 'w-future', projectId: 'p1', taskId: 't3', taskRevision: 1, attemptId: 'at3', bindingId: 'b1', bindingEpoch: 1, target: { kind: 'issue', caseId: 'case-f' }, deadline: 9000, onTimeout: 'raise_issue' }, 112);
  const expired = expiredWaits(store, 'p1', 400);
  assert.equal(expired.length, 2, '仅过期的两个');
  assert.deepEqual(expired.map(entry => entry.waitId).sort(), ['w-cancel', 'w-raise']);
  assert.deepEqual(expired.map(entry => entry.onTimeout).sort(), ['cancel_attempt', 'raise_issue']);
  // resolved的不再进超时清单
  resolveWait(store, 'p1', 'w-raise', 401);
  assert.equal(expiredWaits(store, 'p1', 500).length, 1);
  store.close();
  const reopened = open();
  assert.equal(expiredWaits(reopened, 'p1', 400).length, 1, '跨重启持久');
});

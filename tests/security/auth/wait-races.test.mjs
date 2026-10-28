import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { createRole } from '../../../packages/domain/dist/roles/index.js';
import { createTask } from '../../../packages/domain/dist/tasks/index.js';
import { askQuestion, answerQuestion } from '../../../packages/domain/dist/questions/index.js';
import { createWait, cancelWait, resolveWaitByQuestion, readWait } from '../../../packages/domain/dist/waits/index.js';
import { submitResult } from '../../../packages/domain/dist/results/index.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-a047-', () => { for (const s of stores.splice(0)) { try { s.close(); } catch { /* 已关闭 */ } } });
  const store = openStore(path.join(dir, 'state.sqlite'));
  stores.push(store);
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: 'E:/synthetic/a047', objective: 'o' }, 100);
  createRole(store, { id: 'r-w', projectId: 'p1', name: 'worker', charter: 'c', permissionProfileId: 'worker' }, 101);
  createTask(store, { id: 't-1', projectId: 'p1', goal: 'g' }, 110);
  store.transaction(db => db.prepare("UPDATE tasks SET state='waiting' WHERE id='t-1'").run());
  store.transaction(db => db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s1','synthetic','host','profile','native-1')").run());
  store.transaction(db => db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b1','p1','r-w','s1',1,120)").run());
  store.db.prepare("INSERT INTO attempts(id,project_id,task_id,task_revision,binding_id,binding_epoch,execution_kind,state,started_at) VALUES('at-1','p1','t-1',1,'b1',1,'native','waiting_input',125)").run();
  return { store };
}

test('A047：B答复及时解阻；不能等任务完成才投递回答（回答与提交结果并发）', t => {
  const { store } = fixture(t);
  askQuestion(store, { id: 'q1', projectId: 'p1', taskId: 't-1', taskRevision: 1, attemptId: 'at-1', bindingId: 'b1', bindingEpoch: 1, prompt: '方案?', answererKind: 'role', answererRoleId: 'r-w', deadline: 99999 }, 130);
  createWait(store, { id: 'w1', projectId: 'p1', taskId: 't-1', taskRevision: 1, attemptId: 'at-1', bindingId: 'b1', bindingEpoch: 1, target: { kind: 'question', questionId: 'q1' }, deadline: 99999, onTimeout: 'raise_issue' }, 135);
  // 并发提交结果：B答复前任务也可提交（回复不等待任务完成，双向独立）
  store.transaction(db => db.prepare("UPDATE tasks SET spec_revision=1 WHERE id='t-1'").run());
  const result = submitResult(store, { id: 'res-1', projectId: 'p1', taskId: 't-1', taskRevision: 1, attemptId: 'at-1', outcome: 'succeeded', summary: '带开放问题的中间产出' }, 140);
  assert.equal(result.eligibility, 'current', '结果提交与开放问题独立');
  // B答复：及时解阻（不等任务完成态）
  answerQuestion(store, { projectId: 'p1', questionId: 'q1', answer: { choice: 'B' }, principal: { kind: 'bound_agent', roleId: 'r-w' } }, 150);
  const resolved = resolveWaitByQuestion(store, { projectId: 'p1', questionId: 'q1', answer: { choice: 'B' } }, 155);
  assert.equal(resolved.unblocked, true, '答复及时解阻');
});

test('A047：旧取消回执迟到不取消新尝试（resolved终态拒绝重复取消；新等待不受影响）', t => {
  const { store } = fixture(t);
  askQuestion(store, { id: 'q1', projectId: 'p1', taskId: 't-1', taskRevision: 1, attemptId: 'at-1', bindingId: 'b1', bindingEpoch: 1, prompt: 'q', answererKind: 'role', answererRoleId: 'r-w', deadline: 99999 }, 130);
  createWait(store, { id: 'w1', projectId: 'p1', taskId: 't-1', taskRevision: 1, attemptId: 'at-1', bindingId: 'b1', bindingEpoch: 1, target: { kind: 'question', questionId: 'q1' }, deadline: 99999, onTimeout: 'cancel_attempt' }, 135);
  // B答复解阻旧等待
  answerQuestion(store, { projectId: 'p1', questionId: 'q1', answer: { choice: 'B' }, principal: { kind: 'bound_agent', roleId: 'r-w' } }, 140);
  resolveWaitByQuestion(store, { projectId: 'p1', questionId: 'q1', answer: { choice: 'B' } }, 145);
  // 旧取消回执迟到：对已resolved等待的取消→显式拒绝（不取消新尝试）
  assert.throws(() => cancelWait(store, 'p1', 'w1', 150), /WAIT_TRANSITION_REJECTED/, '迟到回执不取消已解阻等待');
  // 新尝试的新等待独立存在：旧等待状态机不影响
  store.db.prepare("UPDATE attempts SET state='failed' WHERE id='at-1'").run();
  store.db.prepare("INSERT INTO attempts(id,project_id,task_id,task_revision,binding_id,binding_epoch,execution_kind,state,started_at) VALUES('at-2','p1','t-1',1,'b1',1,'native','waiting_input',160)").run();
  askQuestion(store, { id: 'q2', projectId: 'p1', taskId: 't-1', taskRevision: 1, attemptId: 'at-2', bindingId: 'b1', bindingEpoch: 1, prompt: '重问', answererKind: 'user', deadline: 99999 }, 165);
  createWait(store, { id: 'w2', projectId: 'p1', taskId: 't-1', taskRevision: 1, attemptId: 'at-2', bindingId: 'b1', bindingEpoch: 1, target: { kind: 'question', questionId: 'q2' }, deadline: 99999, onTimeout: 'raise_issue' }, 170);
  assert.equal(readWait(store, 'p1', 'w2').state, 'waiting', '新尝试等待不受旧取消回执影响');
  const fresh = cancelWait(store, 'p1', 'w2', 175);
  assert.equal(fresh.cancelRequested, true, '新等待自身取消正常（取消≠停止确认R021）');
});

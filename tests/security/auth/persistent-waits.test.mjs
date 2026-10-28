import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { createRole } from '../../../packages/domain/dist/roles/index.js';
import { createTask } from '../../../packages/domain/dist/tasks/index.js';
import { askQuestion, answerQuestion, expireOpenQuestions, readQuestion } from '../../../packages/domain/dist/questions/index.js';
import { createWait, resolveWaitByQuestion, processExpiredWaits, readWait } from '../../../packages/domain/dist/waits/index.js';
import { raiseGoalHold, adjudicateGoalHold, readGoalHold } from '../../../packages/domain/dist/goal-holds/index.js';
import { evaluateDispatch } from '../../../packages/domain/dist/dispatch-guard/index.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-t068-', () => { for (const s of stores.splice(0)) { try { s.close(); } catch { /* 已关闭 */ } } });
  const filename = path.join(dir, 'state.sqlite');
  const open = () => { const s = openStore(filename); stores.push(s); return s; };
  const store = open();
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: 'E:/synthetic/t068', objective: 'o' }, 100);
  createRole(store, { id: 'r-w', projectId: 'p1', name: 'worker', charter: 'c', permissionProfileId: 'worker' }, 101);
  createTask(store, { id: 't-1', projectId: 'p1', goal: 'g' }, 110);
  store.transaction(db => db.prepare("UPDATE tasks SET state='waiting' WHERE id='t-1'").run());
  store.transaction(db => db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s1','synthetic','host','profile','native-1')").run());
  store.transaction(db => db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b1','p1','r-w','s1',1,120)").run());
  store.db.prepare("INSERT INTO attempts(id,project_id,task_id,task_revision,binding_id,binding_epoch,execution_kind,state,started_at) VALUES('at-1','p1','t-1',1,'b1',1,'native','waiting_input',125)").run();
  return { store, open };
}

test('A092：重启后回答解阻一次；并发回复与超时单事务竞争', t => {
  const { store, open } = fixture(t);
  askQuestion(store, { id: 'q1', projectId: 'p1', taskId: 't-1', taskRevision: 1, attemptId: 'at-1', bindingId: 'b1', bindingEpoch: 1, prompt: '用哪个方案？', answererKind: 'user', deadline: 99999 }, 130);
  createWait(store, { id: 'w1', projectId: 'p1', taskId: 't-1', taskRevision: 1, attemptId: 'at-1', bindingId: 'b1', bindingEpoch: 1, target: { kind: 'question', questionId: 'q1' }, deadline: 99999, onTimeout: 'raise_issue' }, 135);
  // 重启（重开存储）后回答
  const reopened = open();
  const answered = answerQuestion(reopened, { projectId: 'p1', questionId: 'q1', answer: { choice: 'B' }, principal: { kind: 'authenticated_user' } }, 200);
  assert.equal(answered.state, 'answered');
  const resolved = resolveWaitByQuestion(reopened, { projectId: 'p1', questionId: 'q1', answer: { choice: 'B' } }, 205);
  assert.deepEqual(resolved, { unblocked: true, waitState: 'resolved' }, '重启后回答解阻');
  // 只解阻一次：等待已resolved，后续同问题回答不再解阻
  assert.equal(readWait(reopened, 'p1', 'w1').state, 'resolved');
  const second = resolveWaitByQuestion(reopened, { projectId: 'p1', questionId: 'q1', answer: { choice: 'C' } }, 215);
  assert.equal(second.unblocked, false, '同问题只解阻一次');
  // 回答不等待任务完成（任务仍waiting，回答已持久）
  assert.equal(reopened.db.prepare("SELECT state FROM tasks WHERE id='t-1'").get().state, 'waiting');
  assert.equal(readQuestion(reopened, 'p1', 'q1').answer.choice, 'B');
  void store;
});

test('等待解阻核对规格版本而非任务状态版本；未认证答案不能直接变成有效答复',t=>{
 const {store}=fixture(t);askQuestion(store,{id:'q-spec',projectId:'p1',taskId:'t-1',taskRevision:1,attemptId:'at-1',bindingId:'b1',bindingEpoch:1,prompt:'synthetic',answererKind:'user',deadline:99999},130);
 createWait(store,{id:'w-spec',projectId:'p1',taskId:'t-1',taskRevision:1,attemptId:'at-1',bindingId:'b1',bindingEpoch:1,target:{kind:'question',questionId:'q-spec'},deadline:99999,onTimeout:'raise_issue'},135);
 assert.deepEqual(resolveWaitByQuestion(store,{projectId:'p1',questionId:'q-spec',answer:{choice:'unapproved'}},140),{unblocked:false,waitState:null});assert.equal(readQuestion(store,'p1','q-spec').answer,null);
 store.db.prepare("UPDATE tasks SET revision=revision+5 WHERE id='t-1'").run();answerQuestion(store,{projectId:'p1',questionId:'q-spec',answer:{choice:'accepted'},principal:{kind:'authenticated_user'}},150);
 assert.throws(()=>resolveWaitByQuestion(store,{projectId:'p1',questionId:'q-spec',answer:{choice:'replacement'}},155),/WAIT_ANSWER_IMMUTABLE/);
 assert.deepEqual(resolveWaitByQuestion(store,{projectId:'p1',questionId:'q-spec',answer:{choice:'accepted'}},160),{unblocked:true,waitState:'resolved'});assert.equal(readQuestion(store,'p1','q-spec').answer.choice,'accepted');
});

test('截止时间本身生效，不依赖超时扫描先运行；不存在的问题不能解阻等待',t=>{
 const {store}=fixture(t);askQuestion(store,{id:'q-deadline',projectId:'p1',taskId:'t-1',taskRevision:1,attemptId:'at-1',bindingId:'b1',bindingEpoch:1,prompt:'deadline',answererKind:'user',deadline:200},130);
 assert.throws(()=>answerQuestion(store,{projectId:'p1',questionId:'q-deadline',answer:{choice:'late'},principal:{kind:'authenticated_user'}},200),/QUESTION_DEADLINE_EXPIRED/);assert.equal(readQuestion(store,'p1','q-deadline').answer,null);
 createWait(store,{id:'w-missing',projectId:'p1',taskId:'t-1',taskRevision:1,attemptId:'at-1',bindingId:'b1',bindingEpoch:1,target:{kind:'question',questionId:'missing'},deadline:99999,onTimeout:'raise_issue'},135);
 assert.throws(()=>resolveWaitByQuestion(store,{projectId:'p1',questionId:'missing',answer:{choice:'none'}},140),/WAIT_QUESTION_TARGET_MISMATCH/);assert.equal(readWait(store,'p1','w-missing').state,'waiting');
});

test('A092：换绑/改规格后旧答案不解阻新尝试（wait标stale）；超时与回答竞争', t => {
  const { store, open } = fixture(t);
  askQuestion(store, { id: 'q-old', projectId: 'p1', taskId: 't-1', taskRevision: 1, attemptId: 'at-1', bindingId: 'b1', bindingEpoch: 1, prompt: '旧问题', answererKind: 'role', answererRoleId: 'r-w', deadline: 99999 }, 130);
  createWait(store, { id: 'w-old', projectId: 'p1', taskId: 't-1', taskRevision: 1, attemptId: 'at-1', bindingId: 'b1', bindingEpoch: 1, target: { kind: 'question', questionId: 'q-old' }, deadline: 99999, onTimeout: 'raise_issue' }, 135);
  // 换绑：新epoch绑定+新attempt（旧binding结束）
  store.db.prepare("UPDATE role_bindings SET ended_at=300 WHERE id='b1'").run();
  store.transaction(db => db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b2','p1','r-w','s1',2,300)").run());
  store.db.prepare("UPDATE attempts SET state='succeeded' WHERE id='at-1'").run();
  store.db.prepare("INSERT INTO attempts(id,project_id,task_id,task_revision,binding_id,binding_epoch,execution_kind,state,started_at) VALUES('at-2','p1','t-1',1,'b2',2,'native','waiting_input',310)").run();
  // 旧答案迟来：不解阻（wait标stale，答案带late标记仅记录）
  const late = resolveWaitByQuestion(store, { projectId: 'p1', questionId: 'q-old', answer: { choice: 'OLD' } }, 320);
  assert.deepEqual(late, { unblocked: false, waitState: 'stale' }, '旧绑定后回答不解阻');
  assert.equal(readWait(store, 'p1', 'w-old').state, 'stale');
  assert.equal(readQuestion(store, 'p1', 'q-old').answer.late, true, '迟回答案仅记录');
  // 改规格：wait绑旧revision→迟答案stale
  askQuestion(store, { id: 'q-r2', projectId: 'p1', taskId: 't-1', taskRevision: 1, attemptId: 'at-2', bindingId: 'b2', bindingEpoch: 2, prompt: 'r2', answererKind: 'role', answererRoleId: 'r-w', deadline: 99999 }, 330);
  createWait(store, { id: 'w-r2', projectId: 'p1', taskId: 't-1', taskRevision: 1, attemptId: 'at-2', bindingId: 'b2', bindingEpoch: 2, target: { kind: 'question', questionId: 'q-r2' }, deadline: 99999, onTimeout: 'cancel_attempt' }, 335);
  store.db.prepare("UPDATE tasks SET spec_revision=2,revision=revision+1 WHERE id='t-1'").run();
  const stale = resolveWaitByQuestion(store, { projectId: 'p1', questionId: 'q-r2', answer: { ok: 1 } }, 340);
  assert.equal(stale.unblocked, false, '改规格后旧revision答案不解阻');
  // 超时与回答竞争：先超时则回答只记录不解阻
  const expired = processExpiredWaits(store, 'p1', 100000);
  assert.equal(expired.length, 0, 'deadline未到的waiting不处置');
  store.db.prepare("UPDATE waits SET deadline=500 WHERE id='w-r2'").run();
  store.transaction(db => db.prepare("UPDATE waits SET state='waiting' WHERE id='w-r2' AND state='stale'").run());
  void open;
});

test('A093：伪造user来源/回答拒绝；未知范围hold先限制派发；负责人裁决不解用户暂停不提权', t => {
  const { store, open } = fixture(t);
  // 代理冒充user回答→FORGED_USER_ANSWER
  askQuestion(store, { id: 'q-u', projectId: 'p1', taskId: 't-1', taskRevision: 1, attemptId: 'at-1', bindingId: 'b1', bindingEpoch: 1, prompt: '需要用户决定', answererKind: 'user', deadline: 99999 }, 130);
  assert.throws(() => answerQuestion(store, { projectId: 'p1', questionId: 'q-u', answer: { x: 1 }, principal: { kind: 'bound_agent', roleId: 'r-w' } }, 140), /FORGED_USER_ANSWER/, '代理冒充用户回答拒绝');
  // 代理冒充user来源建hold→FORGED_USER_SOURCE（不提升授权）
  assert.throws(() => raiseGoalHold(store, { id: 'h-fake', projectId: 'p1', sourceKind: 'authenticated_user', principal: { kind: 'bound_agent', roleId: 'r-w' }, provenance: { claimed: 'user' }, affectedTaskIds: ['t-1'], scopeKnown: true }, 145), /FORGED_USER_SOURCE/);
  // 原端未核实hold：scope未知→派发被限制（DISPATCH_HELD）
  const hold = raiseGoalHold(store, { id: 'h1', projectId: 'p1', sourceKind: 'native_unverified', principal: { kind: 'kernel' }, provenance: { observed: 'goal-changed' }, affectedTaskIds: [], scopeKnown: false }, 150);
  assert.equal(hold.scopeKnown, false);
  const dispatch = evaluateDispatch(store, { projectId: 'p1', roleId: 'r-w', bindingEpoch: 1, taskId: 't-1', taskRevision: 1 });
  assert.ok(dispatch.denials.some(d => d.code === 'DISPATCH_HELD'), '未知范围hold限制新自动动作');
  // 负责人裁决：await_user→resolved（范围由负责人定）；用户暂停不被解除
  store.db.exec("UPDATE projects SET user_paused=1 WHERE id='p1'");
  const awaiting = adjudicateGoalHold(store, { projectId: 'p1', holdId: 'h1', expectedRevision: 0, decision: 'await_user', principal: { kind: 'bound_agent', roleId: 'r-w' } }, 160);
  assert.equal(awaiting.state, 'awaiting_user');
  const resolved = adjudicateGoalHold(store, { projectId: 'p1', holdId: 'h1', expectedRevision: 1, decision: 'resolve', affectedTaskIds: ['t-1'], principal: { kind: 'authenticated_user' } }, 170);
  assert.deepEqual(resolved.affectedTaskIds, ['t-1'], '负责人裁决影响范围');
  assert.equal(store.db.prepare("SELECT user_paused FROM projects WHERE id='p1'").get().user_paused, 1, '解除hold不解除用户暂停');
  assert.equal(readGoalHold(store, 'p1', 'h1').state, 'resolved');
  // 用户暂停依然限制派发（授权面不变）
  const paused = evaluateDispatch(store, { projectId: 'p1', roleId: 'r-w', bindingEpoch: 1, taskId: 't-1', taskRevision: 1 });
  assert.ok(paused.denials.some(d => d.code === 'USER_PAUSED'));
  void open;
});

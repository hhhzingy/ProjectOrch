import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore, defaultMigrations } from '../../packages/persistence/dist/index.js';
import fs from 'node:fs';
import { createProject } from '../../packages/domain/dist/projects/index.js';
import { createTask } from '../../packages/domain/dist/tasks/index.js';
import { submitResult, decideAcceptance, readResult } from '../../packages/domain/dist/results/index.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';

function fixture(t, initialOptions = {}) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-results-', () => { for (const s of stores) s.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const open = (options = {}) => { const s = openStore(filename, options); stores.push(s); return s; };
  const store = open(initialOptions);
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: 'E:/synthetic/results', objective: 'o' }, 100);
  if (initialOptions.migrations && initialOptions.migrations.length < 9) {
    // 迁移测试必须按旧表结构保存原始字节，不能用只面向最新schema的领域API造旧库。
    store.transaction(db => {
      db.prepare("INSERT INTO tasks(id,project_id,goal,state,revision,spec_revision,plan_revision,acceptance_json) VALUES('t1','p1','g','draft',1,1,0,'[]')").run();
      db.prepare("INSERT INTO task_revisions(task_id,project_id,revision,snapshot_json) VALUES('t1','p1',1,'{}')").run();
    });
  } else createTask(store, { id: 't1', projectId: 'p1', goal: 'g' }, 101);
  store.transaction(db => db.prepare("INSERT INTO roles(id,project_id,name,charter,permission_profile,desired_state,binding_state) VALUES('r1','p1','r','c','worker','enabled','unbound')").run());
  store.transaction(db => db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s1','synthetic','h','p','n1')").run());
  store.transaction(db => db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b1','p1','r1','s1',1,100)").run());
  store.transaction(db => db.prepare("UPDATE tasks SET spec_revision=1 WHERE id='t1'").run());
  return { store, open };
}
const seedAttempt = (store, id, revision) => store.transaction(db => {
  const exists = db.prepare("SELECT 1 FROM task_revisions WHERE task_id='t1' AND project_id='p1' AND revision=?").get(revision);
  if (!exists) db.prepare("INSERT INTO task_revisions(task_id,project_id,revision,snapshot_json) VALUES('t1','p1',?,'{}')").run(revision);
  db.prepare("INSERT INTO attempts(id,project_id,task_id,task_revision,binding_id,binding_epoch,state,started_at) VALUES(?, 'p1','t1',?,'b1',1,'succeeded',100)").run(id, revision);
});
const succeed = (store, id, revision = 1, attemptId = 'at1') => submitResult(store, { id, projectId: 'p1', taskId: 't1', taskRevision: revision, attemptId, outcome: 'succeeded', outputs: [{ name: 'out', kind: 'report', description: '报告' }], summary: '完成' }, 120);

test('同规格新尝试使旧成果过期；迟到旧结果仍只保留历史，不能验收', t => {
  const { store, open } = fixture(t);
  seedAttempt(store, 'at-old', 1); succeed(store, 'res-old', 1, 'at-old');
  seedAttempt(store, 'at-new', 1);
  assert.equal(readResult(store, 'p1', 'res-old').eligibility, 'stale');
  assert.equal(succeed(store, 'res-late', 1, 'at-old').eligibility, 'stale');
  assert.equal(succeed(store, 'res-new', 1, 'at-new').eligibility, 'current');
  assert.throws(() => decideAcceptance(store, { id: 'acc-late', projectId: 'p1', resultId: 'res-late', decision: 'accept', reviewerPrincipalId: 'user', evidence: [{}] }, 200), /REQUIRES_CURRENT|NOT_CURRENT|STALE_SPEC/);
  store.close();
  assert.equal(readResult(open(), 'p1', 'res-late').eligibility, 'stale');
});

test('旧绑定结束使未验收成果过期；即使直接SQL也不能把旧执行结果重新验收', t => {
  const { store } = fixture(t);
  seedAttempt(store, 'at-old', 1); succeed(store, 'res-before', 1, 'at-old');
  store.db.exec("UPDATE role_bindings SET ended_at=150 WHERE id='b1'");
  assert.equal(readResult(store, 'p1', 'res-before').eligibility, 'stale');
  assert.equal(succeed(store, 'res-after', 1, 'at-old').eligibility, 'stale');
  store.db.exec("UPDATE results SET eligibility='current' WHERE id='res-after'");
  assert.throws(() => store.db.exec("INSERT INTO acceptances(id,project_id,result_id,task_revision,decision,reviewer_principal_id,evidence_json,created_at) VALUES('raw-accept','p1','res-after',1,'accept','user','{}',200)"), /RESULT_EXECUTION_NOT_CURRENT/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM acceptances').get().n, 0);
});

test('成功自报不能替代成功终态；running、unknown、failed和interrupted均不accept', t => {
  const { store } = fixture(t);
  seedAttempt(store, 'at1', 1); succeed(store, 'res1', 1, 'at1');
  for (const state of ['running', 'unknown', 'failed', 'interrupted']) {
    store.db.prepare("UPDATE attempts SET state=? WHERE id='at1'").run(state);
    assert.throws(() => decideAcceptance(store, { id: 'bad-' + state, projectId: 'p1', resultId: 'res1', decision: 'accept', reviewerPrincipalId: 'user', evidence: [{}] }, 200), /RESULT_EXECUTION_NOT_CURRENT/, state);
  }
  store.db.exec("UPDATE attempts SET state='succeeded' WHERE id='at1'");
  decideAcceptance(store, { id: 'good', projectId: 'p1', resultId: 'res1', decision: 'accept', reviewerPrincipalId: 'user', evidence: [{}] }, 201);
  store.db.exec("UPDATE role_bindings SET ended_at=202 WHERE id='b1'");
  assert.equal(readResult(store, 'p1', 'res1').eligibility, 'current', '既有验收历史保留');
});

test('迁移6→7有备份且保留已验收记录，只使旧绑定未验收结果过期', t => {
  const { store, open } = fixture(t, { migrations: defaultMigrations().slice(0, 6) });
  seedAttempt(store, 'at1', 1); succeed(store, 'accepted', 1, 'at1');
  decideAcceptance(store, { id: 'acc', projectId: 'p1', resultId: 'accepted', decision: 'accept', reviewerPrincipalId: 'user', evidence: [{}] }, 130);
  succeed(store, 'unaccepted', 1, 'at1');
  store.db.exec("UPDATE role_bindings SET ended_at=140 WHERE id='b1'");
  assert.equal(readResult(store, 'p1', 'unaccepted').eligibility, 'current', '旧版本尚无绑定资格约束');
  store.close();
  const upgraded = open({ migrations: defaultMigrations().slice(0, 7) });
  assert.ok(upgraded.migrationBackup && fs.existsSync(upgraded.migrationBackup));
  assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version, 7);
  assert.equal(readResult(upgraded, 'p1', 'unaccepted').eligibility, 'stale');
  assert.equal(readResult(upgraded, 'p1', 'accepted').eligibility, 'current');
  assert.equal(upgraded.db.prepare("SELECT COUNT(*) AS n FROM acceptances WHERE id='acc'").get().n, 1);
});

test('结果与验收分离：缺证据不accept、succeeded+current+证据才accept（A044）', t => {
  const { store } = fixture(t);
  seedAttempt(store, 'at1', 1);
  succeed(store, 'res1', 1);
  assert.equal(readResult(store, 'p1', 'res1').eligibility, 'current', 'spec_revision匹配时结果current');
  assert.throws(() => decideAcceptance(store, { id: 'acc0', projectId: 'p1', resultId: 'res1', decision: 'accept', reviewerPrincipalId: 'manager', evidence: [] }, 125), /ACCEPTANCE_EVIDENCE_REQUIRED/, '缺证据不accept');
  const needs = decideAcceptance(store, { id: 'acc-needs', projectId: 'p1', resultId: 'res1', decision: 'needs_evidence', reviewerPrincipalId: 'manager', evidence: null }, 126);
  assert.equal(needs.decision, 'needs_evidence', 'needs_evidence合法且不需证据');
  const accepted = decideAcceptance(store, { id: 'acc1', projectId: 'p1', resultId: 'res1', decision: 'accept', reviewerPrincipalId: 'manager', evidence: { checks: [{ kind: 'manual', passed: true }] } }, 127);
  assert.equal(accepted.decision, 'accept');
  assert.throws(() => decideAcceptance(store, { id: 'acc2', projectId: 'p1', resultId: 'res1', decision: 'accept', reviewerPrincipalId: 'manager', evidence: { checks: [] } }, 128), /ACCEPTANCE_ALREADY_ACCEPTED/, '重复验收幂等拒绝');
});

test('验收幂等与过期：spec推进旧结果自动stale（触发器权威）、disputed拒绝（A045）', t => {
  const { store } = fixture(t);
  seedAttempt(store, 'at1', 1);
  succeed(store, 'res-old', 1, 'at1');
  assert.equal(readResult(store, 'p1', 'res-old').eligibility, 'current');
  store.db.prepare("UPDATE tasks SET spec_revision=2 WHERE id='t1'").run();
  assert.equal(readResult(store, 'p1', 'res-old').eligibility, 'stale', '旧结果显式过期');
  assert.throws(() => decideAcceptance(store, { id: 'acc-old', projectId: 'p1', resultId: 'res-old', decision: 'accept', reviewerPrincipalId: 'manager', evidence: { checks: [] } }, 131), /ACCEPTANCE_REQUIRES_CURRENT|STALE_SPEC/, '过期结果不accept');
  seedAttempt(store, 'at2', 2);
  succeed(store, 'res-new', 2, 'at2');
  assert.equal(readResult(store, 'p1', 'res-new').eligibility, 'current');
  decideAcceptance(store, { id: 'acc-reject', projectId: 'p1', resultId: 'res-new', decision: 'reject', reviewerPrincipalId: 'manager', evidence: { reason: '复核退回：缺实现' } }, 132);
  assert.equal(readResult(store, 'p1', 'res-new').eligibility, 'disputed', '退回→disputed');
  assert.throws(() => decideAcceptance(store, { id: 'acc-dis', projectId: 'p1', resultId: 'res-new', decision: 'accept', reviewerPrincipalId: 'manager', evidence: { checks: [] } }, 133), /RESULT_DISPUTED|STALE_SPEC/);
});

test('提交校验：缺失任务/revision/attempt拒绝；非succeeded不accept；跨重启持久', t => {
  const { store, open } = fixture(t);
  seedAttempt(store, 'at1', 1);
  seedAttempt(store, 'at2', 2);
  store.db.prepare("UPDATE tasks SET spec_revision=2 WHERE id='t1'").run();
  for (const bad of [
    { id: 'r-x', projectId: 'p-other', taskId: 't1', taskRevision: 1, attemptId: 'at1', outcome: 'succeeded', summary: 's' },
    { id: 'r-x', projectId: 'p1', taskId: 't-missing', taskRevision: 1, attemptId: 'at1', outcome: 'succeeded', summary: 's' },
    { id: 'r-x', projectId: 'p1', taskId: 't1', taskRevision: 9, attemptId: 'at1', outcome: 'succeeded', summary: 's' },
    { id: 'r-x', projectId: 'p1', taskId: 't1', taskRevision: 1, attemptId: 'at-missing', outcome: 'succeeded', summary: 's' },
    { id: 'r-x', projectId: 'p1', taskId: 't1', taskRevision: 1, attemptId: 'at1', outcome: 'weird', summary: 's' },
  ]) assert.throws(() => submitResult(store, bad, 110), /RESULT_|INVALID_RESULT_/);
  succeed(store, 'res-p', 2, 'at2');
  const failed = submitResult(store, { id: 'res-f', projectId: 'p1', taskId: 't1', taskRevision: 2, attemptId: 'at2', outcome: 'failed', summary: '失败' }, 210);
  assert.throws(() => decideAcceptance(store, { id: 'acc-f', projectId: 'p1', resultId: failed.id, decision: 'accept', reviewerPrincipalId: 'manager', evidence: { checks: [] } }, 211), /ACCEPTANCE_REQUIRES_SUCCEEDED|STALE_SPEC/, '非succeeded不accept');
  store.close();
  const reopened = open();
  assert.equal(readResult(reopened, 'p1', 'res-p').eligibility, 'current', '跨重启持久');
});

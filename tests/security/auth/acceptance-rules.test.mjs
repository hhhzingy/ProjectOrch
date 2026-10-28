import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { createRole } from '../../../packages/domain/dist/roles/index.js';
import { createTask } from '../../../packages/domain/dist/tasks/index.js';
import { submitResult, decideAcceptance, registerCheckDefinition, recordCheckRun } from '../../../packages/domain/dist/results/index.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-acceptance-rules-', () => { for (const s of stores.splice(0)) { try { s.close(); } catch { /* 已关闭 */ } } });
  const filename = path.join(dir, 'state.sqlite');
  const store = openStore(filename);
  stores.push(store);
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: 'E:/synthetic/rules', objective: 'o' }, 100);
  createRole(store, { id: 'r-exec', projectId: 'p1', name: 'executor', charter: 'c', permissionProfileId: 'worker' }, 101);
  createRole(store, { id: 'r-rev', projectId: 'p1', name: 'reviewer', charter: 'c', permissionProfileId: 'worker' }, 102);
  createTask(store, { id: 't-1', projectId: 'p1', goal: 'g', acceptance: [{ kind: 'manual' }] }, 110);
  // 合成attempt（T028正式链前的执行者身份载体）：执行角色r-exec
  store.transaction(db => db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s1','synthetic','host','profile','native-1')").run());
  store.transaction(db => db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b-exec','p1','r-exec','s1',1,105)").run());
  store.db.prepare("INSERT INTO attempts(id,project_id,task_id,task_revision,binding_id,binding_epoch,execution_kind,state,started_at) VALUES('at-1','p1','t-1',1,'b-exec',1,'native','succeeded',120)").run();
  store.transaction(db => db.prepare("UPDATE tasks SET spec_revision=1 WHERE id='t-1'").run());
  const result = submitResult(store, { id: 'res-1', projectId: 'p1', taskId: 't-1', taskRevision: 1, attemptId: 'at-1', outcome: 'succeeded', summary: '执行者自报成功' }, 130);
  assert.equal(result.outcome, 'succeeded');
  return { store };
}
const reviewer = { id: 'p-rev', kind: 'bound_agent', roleId: 'r-rev' };
const executor = { id: 'p-exec', kind: 'bound_agent', roleId: 'r-exec' };
const rule = { mode: 'designated_reviewer', reviewerRoleId: 'r-rev', independent: true };

test('A088：缺复核者/错裁决者/自授权拒绝；执行者成功文字不构成授权', t => {
  const { store } = fixture(t);
  const evidence = [{ review: 'independent', sha256: 'a'.repeat(64) }];
  // 缺复核者主体→FORBIDDEN
  assert.throws(() => decideAcceptance(store, { id: 'a1', projectId: 'p1', resultId: 'res-1', decision: 'accept', reviewerPrincipalId: 'p-rev', evidence, rule }, 210), /FORBIDDEN/);
  // 自授权：规则指定裁决者=执行者本人角色且要求独立→SELF_REVIEW（执行者成功文字不替代复核）
  const selfRule = { mode: 'designated_reviewer', reviewerRoleId: 'r-exec', independent: true };
  assert.throws(() => decideAcceptance(store, { id: 'a2', projectId: 'p1', resultId: 'res-1', decision: 'accept', reviewerPrincipalId: 'p-exec', evidence, rule: selfRule, principal: executor }, 220), /SELF_REVIEW/);
  // 非指定角色→WRONG_REVIEWER
  assert.throws(() => decideAcceptance(store, { id: 'a3', projectId: 'p1', resultId: 'res-1', decision: 'accept', reviewerPrincipalId: 'p-other', evidence, rule, principal: { id: 'p-other', kind: 'bound_agent', roleId: 'r-other' } }, 230), /WRONG_REVIEWER/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM acceptances WHERE result_id='res-1' AND decision='accept'").get().n, 0, '无非法accept落库');
});

test('A088：受控检查版本——过期check/错结果/禁用定义拒绝；通过检查执行且失败不被自报覆盖', t => {
  const { store } = fixture(t);
  registerCheckDefinition(store, { projectId: 'p1', id: 'chk-1', version: 'v1', definition: { kind: 'script' } }, 140);
  registerCheckDefinition(store, { projectId: 'p1', id: 'chk-1', version: 'v0', definition: { kind: 'script' }, enabled: false }, 141);
  // 过期check版本（禁用）登记被拒
  assert.throws(() => recordCheckRun(store, { id: 'run-bad', projectId: 'p1', resultId: 'res-1', checkId: 'chk-1', checkVersion: 'v0', targetSpecRevision: 1, outcome: 'passed', evidence: {} }, 145), /CHECK_DEFINITION_NOT_ENABLED/);
  // 规则绑定受控检查：无检查→CHECK_NOT_PASSED
  const checkRule = { mode: 'automated_check', checkDefinitionId: 'chk-1', checkVersion: 'v1' };
  assert.throws(() => decideAcceptance(store, { id: 'b1', projectId: 'p1', resultId: 'res-1', decision: 'accept', reviewerPrincipalId: 'sys', evidence: [{ ok: 1 }], rule: checkRule, principal: reviewer }, 240), /CHECK_NOT_PASSED/);
  // 错结果绑定→CHECK_NOT_PASSED
  assert.throws(() => decideAcceptance(store, { id: 'b2', projectId: 'p1', resultId: 'res-1', decision: 'accept', reviewerPrincipalId: 'sys', evidence: [{ ok: 1 }], rule: checkRule, principal: reviewer, check: { resultId: 'res-other', definitionId: 'chk-1', version: 'v1', targetSpecRevision: 1 } }, 250), /CHECK_NOT_PASSED/);
  // 检查失败落库后：失败不被自报覆盖（再传check仍拒绝）
  recordCheckRun(store, { id: 'run-fail', projectId: 'p1', resultId: 'res-1', checkId: 'chk-1', checkVersion: 'v1', targetSpecRevision: 1, outcome: 'failed', evidence: { reason: '用例X失败' } }, 150);
  assert.throws(() => decideAcceptance(store, { id: 'b3', projectId: 'p1', resultId: 'res-1', decision: 'accept', reviewerPrincipalId: 'sys', evidence: [{ ok: 1 }], rule: checkRule, principal: reviewer, check: { resultId: 'res-1', definitionId: 'chk-1', version: 'v1', targetSpecRevision: 1 } }, 260), /CHECK_NOT_PASSED/);
  // 检查通过（新run）→合法授权路径放行（配合指定裁决者复核证据）
  recordCheckRun(store, { id: 'run-pass', projectId: 'p1', resultId: 'res-1', checkId: 'chk-1', checkVersion: 'v1', targetSpecRevision: 1, outcome: 'passed', evidence: { suite: 'full', passed: true } }, 155);
  const bothRule = { mode: 'designated_reviewer', reviewerRoleId: 'r-rev', independent: true, checkDefinitionId: 'chk-1', checkVersion: 'v1' };
  const accepted = decideAcceptance(store, { id: 'b4', projectId: 'p1', resultId: 'res-1', decision: 'accept', reviewerPrincipalId: 'p-rev', evidence: [{ review: 'independent' }], rule: bothRule, principal: reviewer, check: { resultId: 'res-1', definitionId: 'chk-1', version: 'v1', targetSpecRevision: 1 } }, 270);
  assert.equal(accepted.decision, 'accept');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM acceptances WHERE result_id='res-1' AND decision='accept'").get().n, 1, '一次合法accept');
});

test('A088：user模式仅限已认证用户；agent主体UNTRUSTED_USER', t => {
  const { store } = fixture(t);
  const userRule = { mode: 'user' };
  assert.throws(() => decideAcceptance(store, { id: 'c1', projectId: 'p1', resultId: 'res-1', decision: 'accept', reviewerPrincipalId: 'u', evidence: [{ ok: 1 }], rule: userRule, principal: reviewer }, 280), /UNTRUSTED_USER/);
  const ok = decideAcceptance(store, { id: 'c2', projectId: 'p1', resultId: 'res-1', decision: 'needs_evidence', reviewerPrincipalId: 'user-1', rule: userRule, principal: { id: 'user-1', kind: 'authenticated_user' }, evidence: null }, 290);
  assert.equal(ok.decision, 'needs_evidence', '已认证用户可裁决needs_evidence');
});

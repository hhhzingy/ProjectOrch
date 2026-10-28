import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../packages/persistence/dist/index.js';
import { createProject } from '../../packages/domain/dist/projects/index.js';
import { createTask } from '../../packages/domain/dist/tasks/index.js';
import { createRole as ensureRole } from '../../packages/domain/dist/roles/index.js';
import { budgetView, checkBudget, fairInterleave } from '../../packages/domain/dist/budget/index.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-budget-', () => { for (const s of stores) s.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const open = () => { const s = openStore(filename); stores.push(s); return s; };
  const store = open();
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: 'E:/synthetic/budget', objective: 'o' }, 100);
  return { store };
}

test('预算视图：权威表实时计数（attempts/outbox重试/changesets管理循环）；unknown显式', t => {
  const { store } = fixture(t);
  createTask(store, { id: 't1', projectId: 'p1', goal: 'g' }, 101);
  store.transaction(db => {
    db.prepare("INSERT INTO roles(id,project_id,name,charter,permission_profile,desired_state,binding_state) VALUES('r1','p1','r','c','worker','enabled','unbound')").run();
    db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s1','synthetic','h','p','n1')").run();
    db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b1','p1','r1','s1',1,100)").run();
    db.prepare("INSERT INTO attempts(id,project_id,task_id,task_revision,binding_id,binding_epoch,state,started_at) VALUES('at1','p1','t1',1,'b1',1,'succeeded',100)").run();
    db.prepare("INSERT INTO attempts(id,project_id,task_id,task_revision,binding_id,binding_epoch,state,started_at) VALUES('at2','p1','t1',1,'b1',1,'failed',101)").run();
    db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('c1','p1','u','rq1',?,'project.pause','{}','completed',100)").run('0'.repeat(64));
    db.prepare("INSERT INTO outbox(id,command_id,operation_key,payload_json,state,next_attempt_at,attempts) VALUES('op1','c1','k1','{}','uncertain',100,3)").run();
    db.prepare("INSERT INTO changesets(id,project_id,command_id,case_id,expected_plan_revision,operations_json,state) VALUES('cs1','p1','c1',NULL,0,'[]','applied')").run();
  });
  const budget = budgetView(store, 'p1', 'r1');
  assert.deepEqual({ attempts: budget.attempts, outboxRetries: budget.outboxRetries, adminCycles: budget.adminCycles }, { attempts: 2, outboxRetries: 0, adminCycles: 0 });
  assert.deepEqual(budget.unattributedProject,{outboxRetries:3,adminCycles:1},'无角色归因的用户/历史用量单列，不能重复计给每个角色');
  assert.deepEqual(budget.unknownCosts, ['model_usage'], '模型费用显式unknown不伪造');
});

test('上限判定：超限明确拒绝（逐类）；未设上限不限制', t => {
  const budget = { roleId: 'r1', attempts: 5, outboxRetries: 2, adminCycles: 1, unknownCosts: ['model_usage'] };
  assert.deepEqual(checkBudget(budget, { maxAttemptsPerRole: 4 }), { allowed: false, reason: 'LIMIT_EXCEEDED', kind: 'attempts', current: 5, limit: 4 });
  assert.deepEqual(checkBudget(budget, { maxAttemptsPerRole: 5 }), { allowed: true });
  assert.deepEqual(checkBudget(budget, {}), { allowed: true }, '未设上限不限制');
  const retry = checkBudget(budget, { maxOutboxRetriesPerRole: 1 });
  assert.equal(retry.allowed, false);
  if (!retry.allowed) assert.equal(retry.kind, 'outboxRetries');
});

test('公平序：管理与执行严格交替不饿死；单队列顺序续排', () => {
  const items = ids => ids.map(id => ({ roleId: id, isManagement: id.startsWith('m') }));
  const inter = fairInterleave([...items(['m1', 'm2']), ...items(['e1', 'e2', 'e3'])]);
  const roles = inter.map(item => item.roleId);
  assert.equal(roles.length, 5);
  assert.equal(roles[0], 'm1', '管理者先行');
  assert.equal(roles[2], 'm2', '交替不饿死');
  assert.deepEqual(roles.filter(id => id.startsWith('m')), ['m1', 'm2'], '管理全部被服务');
  assert.deepEqual(roles.filter(id => id.startsWith('e')), ['e1', 'e2', 'e3'], '执行全部被服务');
  // 管理队列为空：执行顺序续排
  const execOnly = fairInterleave(items(['e1', 'e2']));
  assert.deepEqual(execOnly.map(item => item.roleId), ['e1', 'e2']);
  // 执行队列为空：管理顺序续排
  const mgmtOnly = fairInterleave(items(['m1', 'm2']));
  assert.deepEqual(mgmtOnly.map(item => item.roleId), ['m1', 'm2']);
});

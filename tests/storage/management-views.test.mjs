import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../packages/persistence/dist/index.js';
import { createProject, pauseProjectForUser } from '../../packages/domain/dist/projects/index.js';
import { createRole } from '../../packages/domain/dist/roles/index.js';
import { sendMessage } from '../../packages/domain/dist/messages/index.js';
import { raiseIssue } from '../../packages/domain/dist/issues/index.js';
import { applyChangeset } from '../../packages/domain/dist/changesets/index.js';
import { managementOverview } from '../../packages/domain/dist/views/index.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-mgmt-views-', () => { for (const s of stores) s.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const open = () => { const s = openStore(filename); stores.push(s); return s; };
  const store = open();
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: 'E:/synthetic/mgmt', objective: 'o' }, 100);
  createRole(store, { id: 'r-active', projectId: 'p1', name: 'active', charter: 'c', permissionProfileId: 'worker' }, 101);
  createRole(store, { id: 'r-idle', projectId: 'p1', name: 'idle', charter: 'c', permissionProfileId: 'worker' }, 102);
  store.transaction(db => db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('cmd1','p1','manager','rq1',?,'management.apply_changes','{}','stored',100)").run('0'.repeat(64)));
  return { store, open };
}

test('管理总览：暂停态/未决异常/需关注变更集/非enabled角色/消息积压一屏聚合（T047准备）', t => {
  const { store, open } = fixture(t);
  store.db.prepare("UPDATE roles SET desired_state='paused' WHERE id='r-idle'").run();
  sendMessage(store, { id: 'm1', projectId: 'p1', commandId: 'cmd1', toRoleId: 'r-active', kind: 'k', body: '积压' }, 110);
  raiseIssue(store, { id: 'case-1', projectId: 'p1', fingerprint: 'fp-1', evidence: { detail: '超时' } }, 120);
  store.transaction(db => db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('cmd-ok','p1','manager','rq-ok',?,'management.apply_changes','{}','stored',100)").run('0'.repeat(64)));
  applyChangeset(store, 'cmd-ok', { schemaVersion: 2, requestId: 'cs-1', projectId: 'p1', expectedPlanRevision: 0, reason: 'r', operations: [{ type: 'plan.revise', objective: '新目标', affectedTaskIds: [], rationale: 'r' }] }, 130);
  store.transaction(db => db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('cmd-fail','p1','manager','rq-fail',?,'management.apply_changes','{}','stored',100)").run('0'.repeat(64)));
  try { applyChangeset(store, 'cmd-fail', { schemaVersion: 2, requestId: 'cs-2', projectId: 'p1', expectedPlanRevision: 1, reason: 'r', operations: [{ type: 'role.pause', roleId: 'r-missing', expectedRevision: 0, reason: 'x', currentWorkPolicy: 'finish' }] }, 131); } catch { /* 预期失败留痕 */ }
  pauseProjectForUser(store, 'p1', 140);
  const overview = managementOverview(store, 'p1');
  assert.equal(overview.userPaused, true);
  assert.equal(overview.planRevision, 1);
  assert.deepEqual(overview.openIssues.map(i => i.caseId), ['case-1']);
  assert.deepEqual(overview.changesetsNeedingAttention.map(c => c.changesetId), ['cs-cmd-fail'], 'applied变更集不在需关注清单');
  assert.deepEqual(overview.rolesNotEnabled.map(r => r.roleId), ['r-idle']);
  assert.deepEqual(overview.messageBacklog, [{ roleId: 'r-active', stored: 1 }]);
  store.close();
  const reopened = open();
  assert.equal(managementOverview(reopened, 'p1').userPaused, true);
  assert.throws(() => managementOverview(reopened, 'p-missing'), /VIEW_PROJECT_NOT_FOUND/);
});

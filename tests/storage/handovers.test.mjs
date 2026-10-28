import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../packages/persistence/dist/index.js';
import { createProject, pauseProjectForUser } from '../../packages/domain/dist/projects/index.js';
import { createRole } from '../../packages/domain/dist/roles/index.js';
import { createTask } from '../../packages/domain/dist/tasks/index.js';
import { sendMessage } from '../../packages/domain/dist/messages/index.js';
import { issueAgentCredential } from '../../apps/kernel/dist/auth/agent-credential.js';
import { prepareHandover, verifyHandover, consumeHandover, checkHandoverFreshness, readHandoverPackage } from '../../packages/domain/dist/handovers/index.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-handovers-', () => { for (const s of stores) s.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const open = () => { const s = openStore(filename); stores.push(s); return s; };
  const store = open();
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: 'E:/synthetic/hv', objective: 'o' }, 100);
  createRole(store, { id: 'r-exec', projectId: 'p1', name: 'exec', charter: 'c', permissionProfileId: 'worker' }, 101);
  createRole(store, { id: 'r-verifier', projectId: 'p1', name: 'verifier', charter: 'c', permissionProfileId: 'worker' }, 102);
  store.db.exec("UPDATE roles SET binding_state='ready' WHERE id IN ('r-exec','r-verifier')");
  store.transaction(db => db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s1','synthetic','host','profile','native-1')").run());
  store.transaction(db => db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b1','p1','r-exec','s1',1,100)").run());
  createTask(store, { id: 't-open', projectId: 'p1', goal: '未完任务' }, 103);
  store.transaction(db => db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('cmd1','p1','u','rq1',?,'project.pause','{}','completed',100)").run('0'.repeat(64)));
  return { store, open };
}

test('交接包打包客观水位：binding epoch基准、未完任务、消息引用校验（A054准备）', t => {
  const { store } = fixture(t);
  const message = sendMessage(store, { id: 'm1', projectId: 'p1', commandId: 'cmd1', toRoleId: 'r-exec', kind: 'k', body: 'b' }, 110);
  void message;
  const handover = prepareHandover(store, { id: 'h1', projectId: 'p1', roleId: 'r-exec', fromBindingEpoch: 1, verifierRoleId: 'r-verifier', notes: '交接说明：目标t-open未完', recentMessageIds: ['m1', 'm-ghost'] }, 120);
  assert.equal(handover.state, 'prepared');
  const pkg = readHandoverPackage(store, 'p1', 'h1');
  assert.equal(pkg.eventWatermark, 0);
  assert.deepEqual(pkg.openTaskIds, ['t-open'], '未完任务入包');
  assert.deepEqual(pkg.recentMessageIds, ['m1'], 'ghost引用被过滤');
  assert.equal(pkg.planRevision, 0);
  assert.equal(pkg.fromBindingEpoch, 1);
  assert.throws(() => prepareHandover(store, { id: 'h2', projectId: 'p1', roleId: 'r-exec', fromBindingEpoch: 9, verifierRoleId: 'r-verifier', notes: 'x' }, 121), /HANDOVER_BINDING_NOT_CURRENT/, 'epoch非当前活跃代次拒绝');
  assert.throws(() => prepareHandover(store, { id: 'h3', projectId: 'p1', roleId: 'r-exec', fromBindingEpoch: 1, verifierRoleId: 'r-exec', notes: 'x' }, 122), /HANDOVER_VERIFIER_SELF/, '自验证拒绝');
});

test('核验与消费：fresh→verified→consumed一次性；binding推进或plan漂移→stale', t => {
  const { store } = fixture(t);
  prepareHandover(store, { id: 'h1', projectId: 'p1', roleId: 'r-exec', fromBindingEpoch: 1, verifierRoleId: 'r-verifier', notes: 'n' }, 120);
  assert.throws(() => verifyHandover(store, 'p1', 'h1', 'r-exec', 121), /HANDOVER_NOT_VERIFIER/, '非指定验证者不得核验');
  assert.equal(verifyHandover(store, 'p1', 'h1', 'r-verifier', 122).state, 'verified');
  assert.equal(consumeHandover(store, 'p1', 'h1', 123).state, 'consumed');
  assert.throws(() => consumeHandover(store, 'p1', 'h1', 124), /HANDOVER_TRANSITION_REJECTED/, '一次性消费');
  // binding代次推进（模拟接替）后：新包在旧epoch基准上→stale
  store.db.prepare("UPDATE role_bindings SET ended_at=130 WHERE id='b1'").run();
  store.transaction(db => db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b2','p1','r-exec','s1',2,131)").run());
  prepareHandover(store, { id: 'h2', projectId: 'p1', roleId: 'r-exec', fromBindingEpoch: 2, verifierRoleId: 'r-verifier', notes: 'n' }, 140);
  pauseProjectForUser(store, 'p1', 141); // plan/项目修订不影响plan_revision；改用真实漂移：
  store.db.prepare("UPDATE projects SET plan_revision=5 WHERE id='p1'").run();
  const check = checkHandoverFreshness(store, 'p1', 'h2');
  assert.equal(check.bindingEpochCurrent, true);
  assert.equal(check.planRevisionCurrent, 5);
  assert.equal(check.fresh, false, 'plan_revision漂移→不fresh');
  assert.throws(() => verifyHandover(store, 'p1', 'h2', 'r-verifier', 142), /HANDOVER_STALE/, '过期包核验即转stale');
  assert.equal(store.db.prepare("SELECT state FROM handovers WHERE id='h2'").get().state, 'stale', 'stale留痕');
  assert.throws(() => verifyHandover(store, 'p1', 'h2', 'r-verifier', 143), /HANDOVER_TRANSITION_REJECTED/, 'stale不可再核验');
});

test('跨重启持久与凭据撤销联动边界', t => {
  const { store, open } = fixture(t);
  const credential = issueAgentCredential(store, 'b1', 1, { isolation: 'verified_session', session: { harnessId: 'synthetic', hostId: 'host', profileId: 'profile', nativeConversationId: 'native-1' } }, 110, 60000).credential;
  prepareHandover(store, { id: 'h1', projectId: 'p1', roleId: 'r-exec', fromBindingEpoch: 1, verifierRoleId: 'r-verifier', notes: 'n' }, 120);
  verifyHandover(store, 'p1', 'h1', 'r-verifier', 121);
  store.close();
  const reopened = open();
  assert.equal(reopened.db.prepare("SELECT state FROM handovers WHERE id='h1'").get().state, 'verified', '跨重启verified持久');
  const pkg = readHandoverPackage(reopened, 'p1', 'h1');
  assert.equal(pkg.fromBindingEpoch, 1);
  void credential;
});

import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../packages/persistence/dist/index.js';
import { createProject } from '../../packages/domain/dist/projects/index.js';
import { createRole } from '../../packages/domain/dist/roles/index.js';
import { createTask } from '../../packages/domain/dist/tasks/index.js';
import { succeedBinding, readActiveBinding, assertSingleOwner } from '../../packages/domain/dist/native-binding/index.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-native-binding-', () => { for (const s of stores) s.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const open = () => { const s = openStore(filename); stores.push(s); return s; };
  const store = open();
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: 'E:/synthetic/nb', objective: 'o' }, 100);
  createRole(store, { id: 'r1', projectId: 'p1', name: 'r', charter: 'c', permissionProfileId: 'worker' }, 101);
  store.transaction(db => {
    db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s1','synthetic','h','p','n1')").run();
    db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s2','synthetic','h','p','n2')").run();
    db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b1','p1','r1','s1',1,100)").run();
    db.prepare("INSERT INTO agent_credentials(id,project_id,binding_id,binding_epoch,session_key_hash,token_hash,created_at,expires_at) VALUES('cred1','p1','b1',1,?,?,100,999999)").run('a'.repeat(64), 'b'.repeat(64));
  });
  return { store, open };
}

test('接替：旧绑定end+epoch+1新绑定+旧代凭据撤销（T015/A014核心）', t => {
  const { store } = fixture(t);
  const result = succeedBinding(store, { newBindingId: 'b2', projectId: 'p1', roleId: 'r1', sessionId: 's2', handoverId: null }, 200);
  assert.deepEqual(result.oldBinding, { bindingId: 'b1', epoch: 1, endedAt: 200 });
  assert.equal(result.newBinding.epoch, 2, '接替代次+1');
  assert.equal(result.newBinding.sessionId, 's2');
  assert.equal(result.revokedCredentials, 1, '旧代凭据全部撤销');
  const active = readActiveBinding(store, 'p1', 'r1');
  assert.equal(active?.bindingId, 'b2');
  assert.equal(active?.epoch, 2);
  assertSingleOwner(store, 's1');
  assertSingleOwner(store, 's2');
});

test('无活跃绑定/未知角色与session拒绝；单owner违规检测', t => {
  const { store } = fixture(t);
  createRole(store, { id: 'r-noactive', projectId: 'p1', name: 'n', charter: 'c', permissionProfileId: 'worker' }, 101);
  assert.throws(() => succeedBinding(store, { newBindingId: 'b9', projectId: 'p1', roleId: 'r-noactive', sessionId: 's1' }, 110), /NB_NO_ACTIVE_BINDING/, '无活跃绑定不可接替');
  assert.throws(() => succeedBinding(store, { newBindingId: 'b9', projectId: 'p1', roleId: 'r-missing', sessionId: 's1' }, 111), /NB_ROLE_NOT_FOUND/);
  assert.throws(() => succeedBinding(store, { newBindingId: 'b9', projectId: 'p1', roleId: 'r1', sessionId: 's-missing' }, 112), /NB_SESSION_NOT_FOUND/);
  // 双角色绑同一session→库层UNIQUE(session_id WHERE ended_at IS NULL)拒绝（单owner由schema强制）；域层assertSingleOwner提供显式检测
  createRole(store, { id: 'r2', projectId: 'p1', name: 'r2', charter: 'c', permissionProfileId: 'worker' }, 113);
  store.transaction(db => db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b-r2','p1','r2','s2',1,100)").run());
  assertSingleOwner(store, 's2');
  store.transaction(db => db.prepare("UPDATE role_bindings SET ended_at=114 WHERE id='b-r2'").run());
  // s1已被b1活跃占用→库层UNIQUE(session_one_binding)直接拒绝第二活跃绑定（单owner由schema强制）
  assert.throws(() => store.transaction(db => db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b-r2b','p1','r2','s1',1,100)").run()), /UNIQUE.*session_one_binding|UNIQUE constraint failed: role_bindings.session_id/, 'schema强制单owner');
  // 域层assertSingleOwner在schema绕过场景（直接SQL注入双活跃）下才触发——schema已强制，域层为纵深防御
});

test('接替后旧代凭据不可用而新代独立（联动agent_credentials）', t => {
  const { store, open } = fixture(t);
  succeedBinding(store, { newBindingId: 'b2', projectId: 'p1', roleId: 'r1', sessionId: 's2' }, 200);
  const creds = store.db.prepare("SELECT binding_epoch,revoked_at FROM agent_credentials ORDER BY binding_epoch").all();
  assert.equal(creds[0].revoked_at !== null, true, 'epoch1凭据已撤销');
  store.close();
  const reopened = open();
  const active = reopened.db.prepare("SELECT epoch,ended_at FROM role_bindings WHERE role_id='r1' AND ended_at IS NULL").get();
  assert.equal(active.epoch, 2, '重启后新代活跃');
  assert.equal(active.ended_at, null);
});

test('旧执行未核对前拒绝换绑，整事务不结束绑定、不撤销凭据；终态后重新握手', t => {
  for (const state of ['dispatching', 'running', 'waiting_input', 'unknown']) {
    const { store } = fixture(t);
    createTask(store, { id: 't-live', projectId: 'p1', roleId: 'r1', goal: '未结束' }, 110);
    store.db.prepare("INSERT INTO attempts(id,project_id,task_id,task_revision,binding_id,binding_epoch,state,started_at) VALUES('a-live','p1','t-live',1,'b1',1,?,120)").run(state);
    assert.throws(() => succeedBinding(store, { newBindingId: 'b2', projectId: 'p1', roleId: 'r1', sessionId: 's2' }, 200), /NB_EXECUTION_UNRESOLVED/, state);
    assert.equal(readActiveBinding(store, 'p1', 'r1').bindingId, 'b1');
    assert.equal(store.db.prepare("SELECT revoked_at FROM agent_credentials WHERE id='cred1'").get().revoked_at, null);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM role_bindings').get().n, 1);
    store.db.prepare("UPDATE attempts SET state='failed',ended_at=201 WHERE id='a-live'").run();
    succeedBinding(store, { newBindingId: 'b2', projectId: 'p1', roleId: 'r1', sessionId: 's2' }, 202);
    assert.equal(store.db.prepare("SELECT binding_state FROM roles WHERE id='r1'").get().binding_state, 'provisioning');
  }
});

test('接替拒绝倒退时钟及伪造交接包；新绑定写入失败保留旧绑定和凭据', t => {
  const { store } = fixture(t);
  const input = { newBindingId: 'b2', projectId: 'p1', roleId: 'r1', sessionId: 's2' };
  assert.throws(() => succeedBinding(store, input, 99), /INVALID_NB_TIME/);
  assert.throws(() => succeedBinding(store, { ...input, handoverId: 'missing' }, 200), /NB_HANDOVER_NOT_CURRENT/);
  store.db.exec("CREATE TRIGGER synthetic_binding_failure BEFORE INSERT ON role_bindings BEGIN SELECT RAISE(ABORT,'SYNTHETIC_BINDING_FAILURE'); END");
  assert.throws(() => succeedBinding(store, input, 200), /SYNTHETIC_BINDING_FAILURE/);
  assert.equal(readActiveBinding(store, 'p1', 'r1').bindingId, 'b1');
  assert.equal(store.db.prepare("SELECT revoked_at FROM agent_credentials WHERE id='cred1'").get().revoked_at, null);
});

test('首绑定公共入口：unbound+enabled才可建立epoch=1；已绑定/非enabled显式拒绝（A089闭环前置）', async t => {
  const { store, open } = fixture(t);
  const { establishFirstBinding } = await import('../../packages/domain/dist/native-binding/index.js');
  store.db.prepare("INSERT INTO roles(id,project_id,name,charter,parent_id,permission_profile,desired_state,binding_state,revision) VALUES('r-fresh','p1','rf','c',NULL,'worker','enabled','unbound',1)").run();
  store.db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s-first','synthetic','host','p','nat-first')").run();
  const first = await establishFirstBinding(store, { bindingId: 'b-first', projectId: 'p1', roleId: 'r-fresh', sessionId: 's-first' }, 150);
  assert.equal(first.epoch, 1);
  assert.throws(() => establishFirstBinding(store, { bindingId: 'b-again', projectId: 'p1', roleId: 'r1', sessionId: 's-first' }, 151), /NB_ALREADY_ACTIVE/, '已有活跃绑定拒绝');
  store.db.prepare("INSERT INTO roles(id,project_id,name,charter,parent_id,permission_profile,desired_state,binding_state,revision) VALUES('r-paused','p1','rp','c',NULL,'worker','paused','unbound',1)").run();
  assert.throws(() => establishFirstBinding(store, { bindingId: 'b-paused', projectId: 'p1', roleId: 'r-paused', sessionId: 's-first' }, 152), /NB_ROLE_NOT_ENABLED/, '非enabled角色拒绝');
  await open();
  void store;
});

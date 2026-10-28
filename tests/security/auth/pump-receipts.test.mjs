/** 复核修复负例：消息泵回执结算边界——错目标回执/未确认退出/内部调度ID/未分类异常一律uncertain不伪装；
 * 确定性未发出才failed；真实回执匹配→adopt会话核验→startup_ack可ready。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { createTask } from '../../../packages/domain/dist/tasks/index.js';
import { sendMessage, dispatchQueuedForEnabledRoles, markNativeSessionVerified } from '../../../packages/domain/dist/messages/index.js';
import { pumpMessageDelivery } from '../../../apps/kernel/dist/execution/message-delivery.js';
import { NativeRpcError } from '../../../apps/kernel/dist/native/stdio-peer.js';
import { completeBindingStartupAck } from '../../../apps/kernel/dist/tools/orchestration-tools.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';
import {installSyntheticPolicy} from './synthetic-policy.mjs';

const mkReady = (t, tag) => {
  const dir = temporaryDirectory(t, `projectorch-pump-${tag}-`, () => {});
  const store = openStore(`${dir}/state.sqlite`);
  fs.mkdirSync(path.join(dir,'workspace'));
  createProject(store, { id: 'p1', name: '泵负例', hostId: 'h', canonicalRoot: dir, objective: 'x' }, 100);
  installSyntheticPolicy(store,'p1',[{id:'team',revision:1,actions:['identity'],readPaths:[],writePaths:[],roleIds:[],delegableActions:[],maxDelegationDepth:0}]);
  store.transaction(db => {
    db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id,verified_origin,native_workspace_id) VALUES('s1','zcode','h','pp','conv-real',1,?)").run(path.join(dir,'workspace'));
    db.prepare("INSERT INTO roles(id,project_id,name,charter,permission_profile,desired_state,binding_state,revision) VALUES('worker','p1','执行者','按指令','team','enabled','ready',1)").run();
    db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b1','p1','worker','s1',1,100)").run();
    db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('c1','p1','u','r1','h','message.send','{}','completed',100)").run();
  });
  return { store, seed: id => sendMessage(store, { id, projectId: 'p1', commandId: 'c1', toRoleId: 'worker', kind: 'task_input', body: '负例' }, 110) };
};
const state = (s, id) => s.db.prepare('SELECT state FROM messages WHERE id=?').get(id).state;

test('错目标回执：harness或会话不匹配→uncertain不记送达', async t => {
  const { store, seed } = mkReady(t, 'wrongtarget');
  seed('m1'); dispatchQueuedForEnabledRoles(store, 'p1', 200);
  const r = await pumpMessageDelivery(store, { now: () => 300, runInBinding: async () => ({ harnessId: 'codex', nativeConversationId: 'OTHER_SESSION', nativeTurnId: 'turn-1', status: 'completed', responseText: 'x', exitConfirmed: true }) });
  assert.equal(r.uncertain, 1); assert.equal(r.delivered, 0);
  assert.equal(state(store, 'm1'), 'uncertain');
  // 目标会话对、harness错：同样uncertain
  const s2 = mkReady(t, 'wrongharness'); s2.seed('m2'); dispatchQueuedForEnabledRoles(s2.store, 'p1', 200);
  const r2 = await pumpMessageDelivery(s2.store, { now: () => 300, runInBinding: async () => ({ harnessId: 'codex', nativeConversationId: 'conv-real', nativeTurnId: 'turn-1', status: 'completed', responseText: 'x', exitConfirmed: true }) });
  assert.equal(r2.uncertain, 1);
  store.close(); s2.store.close();
});

test('未确认退出/内部调度ID：completed也不记送达', async t => {
  const a = mkReady(t, 'exit'); a.seed('m1'); dispatchQueuedForEnabledRoles(a.store, 'p1', 200);
  const ra = await pumpMessageDelivery(a.store, { now: () => 300, runInBinding: async () => ({ harnessId: 'zcode', nativeConversationId: 'conv-real', nativeTurnId: 'turn-1', status: 'completed', responseText: 'x', exitConfirmed: false }) });
  assert.equal(ra.uncertain, 1); assert.equal(state(a.store, 'm1'), 'uncertain');
  const b = mkReady(t, 'cliid'); b.seed('m1'); dispatchQueuedForEnabledRoles(b.store, 'p1', 200);
  const rb = await pumpMessageDelivery(b.store, { now: () => 300, runInBinding: async () => ({ harnessId: 'zcode', nativeConversationId: 'conv-real', nativeTurnId: 'cli-epoch123', status: 'completed', responseText: 'x', exitConfirmed: true }) });
  assert.equal(rb.uncertain, 1, '内部调度ID不得当真实turnId');
  a.store.close(); b.store.close();
});

test('异常分类：not_sent才failed；未分类异常→uncertain', async t => {
  const a = mkReady(t, 'notsent'); a.seed('m1'); dispatchQueuedForEnabledRoles(a.store, 'p1', 200);
  const ra = await pumpMessageDelivery(a.store, { now: () => 300, runInBinding: async () => { throw new NativeRpcError('CONFIG_MISSING', 'not_sent', -32600, 'NATIVE_REJECTION'); } });
  assert.equal(ra.failed, 1); assert.equal(state(a.store, 'm1'), 'failed');
  const b = mkReady(t, 'untyped'); b.seed('m1'); dispatchQueuedForEnabledRoles(b.store, 'p1', 200);
  const rb = await pumpMessageDelivery(b.store, { now: () => 300, runInBinding: async () => { throw new Error('REVIEW_EXTERNAL_SEND_RESULT_UNKNOWN'); } });
  assert.equal(rb.uncertain, 1, '外发后未分类异常不伪装failed');
  assert.equal(state(b.store, 'm1'), 'uncertain');
  a.store.close(); b.store.close();
});

test('adopt会话：真实回执匹配核验→startup_ack可ready；未核验拒绝', async t => {
  const dir = temporaryDirectory(t, 'projectorch-pump-adopt-', () => {});
  const store = openStore(`${dir}/state.sqlite`);
  createProject(store, { id: 'p1', name: 'adopt核验', hostId: 'h', canonicalRoot: dir, objective: 'x' }, 100);
  store.transaction(db => {
    db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id,verified_origin) VALUES('sa','zcode','h','pp','conv-adopted',0)").run();
    db.prepare("INSERT INTO roles(id,project_id,name,charter,permission_profile,desired_state,binding_state,revision) VALUES('lead','p1','负责人','按指令','team','enabled','provisioning',1)").run();
    db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('ba','p1','lead','sa',1,100)").run();
  });
  assert.throws(() => completeBindingStartupAck(store, 'p1', 'lead'), /STARTUP_ACK_NATIVE_VERIFICATION_REQUIRED/, '未核验不可ready');
  markNativeSessionVerified(store, { harnessId: 'zcode',hostId:'h',profileId:'pp',nativeConversationId: 'conv-adopted' });
  const acked = completeBindingStartupAck(store, 'p1', 'lead');
  assert.equal(acked.bindingState, 'ready', '真实核验后握手放行');
  store.close();
});

test('复核批次一：adopt未核验会话——官方观察通过才投递；未通过/未注入保持queued不盲发', async t => {
  const mkUnverified = (t, tag) => {
    const dir = temporaryDirectory(t, `projectorch-pump-uv-${tag}-`, () => {});
    const store = openStore(`${dir}/state.sqlite`);
    fs.mkdirSync(path.join(dir,'workspace'));
    createProject(store, { id: 'p1', name: '未核验', hostId: 'h', canonicalRoot: dir, objective: 'x' }, 100);
    installSyntheticPolicy(store,'p1',[{id:'team',revision:1,actions:['identity'],readPaths:[],writePaths:[],roleIds:[],delegableActions:[],maxDelegationDepth:0}]);
    store.transaction(db => {
      db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id,verified_origin,native_workspace_id) VALUES('su','zcode','h','pp','conv-uv',0,?)").run(path.join(dir,'workspace'));
      db.prepare("INSERT INTO roles(id,project_id,name,charter,permission_profile,desired_state,binding_state,revision) VALUES('worker','p1','执行者','按指令','team','enabled','ready',1)").run();
      db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('bu','p1','worker','su',1,100)").run();
      db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('cu','p1','u','ru','h','message.send','{}','completed',100)").run();
    });
    sendMessage(store, { id: 'mu', projectId: 'p1', commandId: 'cu', toRoleId: 'worker', kind: 'task_input', body: '核验门' }, 110);
    dispatchQueuedForEnabledRoles(store, 'p1', 120);
    return store;
  };
  // 负例1：未注入 officialObserve → 跳过，消息保持 queued
  const a = mkUnverified(t, 'noinject');
  const ra = await pumpMessageDelivery(a, { now: () => 300, runInBinding: async () => { throw new Error('SHOULD_NOT_SEND'); } });
  assert.equal(ra.attempted, 0); assert.equal(ra.skipped, 1);
  assert.equal(a.db.prepare("SELECT state FROM messages WHERE id='mu'").get().state, 'queued', '未核验不盲发');
  assert.equal(a.db.prepare("SELECT verified_origin FROM sessions WHERE id='su'").get().verified_origin, 0);
  // 负例2：观察返回 false → 同样跳过
  const b = mkUnverified(t, 'false');
  const rb = await pumpMessageDelivery(b, { now: () => 300, runInBinding: async () => { throw new Error('SHOULD_NOT_SEND'); }, officialObserve: async () => false });
  assert.equal(rb.attempted, 0); assert.equal(rb.skipped, 1);
  // 正例：观察通过 → verified 标记 + 继续真实投递（回执匹配 delivered）
  const c = mkUnverified(t, 'pass');
  const rc = await pumpMessageDelivery(c, { now: () => 300, officialObserve: async () => true, runInBinding: async (_b, target) => ({ harnessId: target.harnessId, nativeConversationId: target.nativeConversationId, nativeTurnId: 'turn-uv-1', status: 'completed', responseText: '核验后回复', exitConfirmed: true }) });
  assert.equal(rc.attempted, 1); assert.equal(rc.delivered, 1);
  assert.equal(c.db.prepare("SELECT verified_origin FROM sessions WHERE id='su'").get().verified_origin, 1, '官方观察通过后标记verified');
  a.close(); b.close(); c.close();
});

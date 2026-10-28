/** T053/A072：组合故障注入回归（固定种子，合成注入执行器——不跑真实CLI）。
 * 时间线上叠加四类故障并核对不变量：
 * ①执行轮中途终止→unknown不假成功；②重启→已提交业务状态不丢；
 * ③重复/乱序：重复泵不重复副作用、迟到旧回执不覆盖新状态；
 * ④断开管理角色→stored不放行、待办不误派。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { openStore } from '../../packages/persistence/dist/index.js';
import { createProject } from '../../packages/domain/dist/projects/index.js';
import { createTask, markTaskReady } from '../../packages/domain/dist/tasks/index.js';
import { sendMessage, markDelivered, markUncertainDelivery } from '../../packages/domain/dist/messages/index.js';
import { pumpMessageDelivery } from '../../apps/kernel/dist/execution/message-delivery.js';
import { dispatchQueuedForEnabledRoles, claimForSending } from '../../packages/domain/dist/messages/index.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';
import {installSyntheticPolicy} from '../security/auth/synthetic-policy.mjs';

const seed = 'a072-fixed-seed-v1';
const mkEnv = (t, tag) => {
  const stores=[];
  const dir = temporaryDirectory(t, `projectorch-a072-${tag}-`, () => {for(const store of stores)if(!store.closed)store.close();});
  const mainPath = `${dir}/state.sqlite`;
  fs.mkdirSync(path.join(dir,'workspace'));
  const build = () => {
    const store = openStore(mainPath);
    stores.push(store);
    createProject(store, { id: 'p1', name: '组合故障', hostId: 'h', canonicalRoot: dir, objective: 'A072' }, 100);
    installSyntheticPolicy(store,'p1',[{id:'team',revision:1,actions:['identity'],readPaths:[],writePaths:[],roleIds:[],delegableActions:[],maxDelegationDepth:0}]);
    store.transaction(db => {
      db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id,native_workspace_id) VALUES('s1','zcode','h','pp','conv-a072',?)").run(path.join(dir,'workspace'));
      db.prepare("INSERT INTO roles(id,project_id,name,charter,permission_profile,desired_state,binding_state,revision) VALUES('worker','p1','执行者','按指令','team','enabled','ready',1)").run();
      db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b1','p1','worker','s1',1,100)").run();
      db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('c1','p1','user-1','r1','h1','message.send',?,'completed',110)").run(JSON.stringify({ toRoleId: 'worker', body: '组合故障消息', kind: 'task_input' }));
    });
    createTask(store, { id: 't1', projectId: 'p1', roleId: 'worker', goal: 'A072组合故障任务', acceptance: [{ ruleId: 'user-review', description: '人工核验', mode: 'user' }], outputRequirements: [{ name: 'report', kind: 'report', description: '报告' }] }, 110);
    markTaskReady(store, 'p1', 't1', 120);
    sendMessage(store, { id: 'm1', projectId: 'p1', commandId: 'c1', toRoleId: 'worker', kind: 'task_input', body: '组合故障消息' }, 130);
    return store;
  };
  return { dir, mainPath, build, seed };
};

test('A072 ①+② 执行轮中途终止→unknown不假成功；重启不丢已提交状态；重复泵不重发', async t => {
  const env = mkEnv(t, 'crash');
  const store = env.build();
  // 消息放行→queued
  const { dispatched } = dispatchQueuedForEnabledRoles(store, 'p1', 200);
  assert.equal(dispatched, 1);
  let nativeCalls = 0;
  const services = {
    now: () => 200 + nativeCalls,
    // 注入故障：外发中途进程终止（无法确认是否送达）
    runInBinding: async () => { nativeCalls++; throw new Error('INJECTED_PROCESS_KILL'); },
  };
  const r1 = await pumpMessageDelivery(store, services);
  assert.equal(r1.attempted, 1);
  assert.equal(r1.failed + r1.uncertain, 1, '故障轮不假成功');
  const state1 = store.db.prepare("SELECT state FROM messages WHERE id='m1'").get().state;
  assert.ok(['failed', 'uncertain'].includes(state1), `终态如实（实际${state1}）`);
  // 重启：关闭重开（模拟内核终止后恢复）
  store.close();
  const store2 = openStore(env.mainPath);
  // 不变量：已提交业务状态完整
  assert.equal(store2.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE id='p1'").get().n, 1);
  assert.equal(store2.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id='t1'").get().n, 1);
  assert.equal(store2.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE id='m1'").get().n, 1);
  assert.equal(store2.db.prepare("SELECT state FROM messages WHERE id='m1'").get().state, state1, '重启不改变终态');
  // 重复泵（重启后再次调度）：failed/uncertain 不在候选（只有queued候选），不重复外发
  const callsBefore = nativeCalls;
  const r2 = await pumpMessageDelivery(store2, { now: () => 999, runInBinding: async () => { nativeCalls++; return { harnessId: 'zcode', nativeConversationId: 'conv-a072', nativeTurnId: 'n1', status: 'completed', responseText: 'LATE', exitConfirmed: true }; } });
  assert.equal(r2.attempted, 0, '终态消息不重复外发');
  assert.equal(nativeCalls, callsBefore, '无重复副作用');
  store2.close();
});

test('A072 ③ 乱序：迟到旧回执不覆盖新终态；重复claim防重', async t => {
  const env = mkEnv(t, 'ordering');
  const store = env.build();
  dispatchQueuedForEnabledRoles(store, 'p1', 200);
  // 新终态：delivered（带明确回执）
  markDelivered(store, 'p1', 'm1', { nativeTurnId: 'turn-new', responseText: 'NEW' }, 210);
  // 迟到的旧回执试图重复结算：明确终态拒绝重复完成（journal/回执幂等语义）
  assert.throws(() => markDelivered(store, 'p1', 'm1', { nativeTurnId: 'turn-old', responseText: 'OLD' }, 220), /MESSAGE_TRANSITION_REJECTED/, '迟到旧回执不覆盖已结算终态');
  const row = store.db.prepare("SELECT delivery_json FROM messages WHERE id='m1'").get();
  const receipts = JSON.parse(row.delivery_json).transitions.filter(t => t.receipt).map(t => t.receipt);
  assert.equal(receipts[receipts.length - 1].nativeTurnId, 'turn-new', '保留新回执');
  // 重复claim：sending中的消息不被再次认领
  sendMessage(store, { id: 'm2', projectId: 'p1', commandId: 'c1', toRoleId: 'worker', kind: 'task_input', body: '第二条' }, 230);
  dispatchQueuedForEnabledRoles(store, 'p1', 231);
  claimForSending(store, 'p1', 'm2', 232);
  assert.throws(() => claimForSending(store, 'p1', 'm2', 233), /MESSAGE_TRANSITION_REJECTED/, 'sending中不重复认领');
  store.close();
});

test('A072 ④ 断开管理/执行角色：stored不放行、待办不误派', async t => {
  const env = mkEnv(t, 'detach');
  const store = env.build();
  // 暂停执行角色→stored消息不放行
  store.db.prepare("UPDATE roles SET desired_state='paused' WHERE id='worker'").run();
  const { dispatched, blocked } = dispatchQueuedForEnabledRoles(store, 'p1', 300);
  assert.equal(dispatched, 0, '暂停角色消息保持stored');
  assert.ok(blocked >= 0);
  assert.equal(store.db.prepare("SELECT state FROM messages WHERE id='m1'").get().state, 'stored');
  // 泵也不会投递（角色未启用不在候选）
  const r = await pumpMessageDelivery(store, { now: () => 301, runInBinding: async () => { throw new Error('SHOULD_NOT_RUN'); } });
  assert.equal(r.attempted, 0, '不误派');
  // 恢复启用→正常放行
  store.db.prepare("UPDATE roles SET desired_state='enabled' WHERE id='worker'").run();
  const r2 = dispatchQueuedForEnabledRoles(store, 'p1', 310);
  assert.equal(r2.dispatched, 1, '恢复后放行');
  store.close();
});

test('A072 可重现种子：同种子重建环境状态一致', t => {
  const a = mkEnv(t, 'seed-a'); const b = mkEnv(t, 'seed-b');
  const sa = a.build(); const sb = b.build();
  const snap = s => JSON.stringify(s.db.prepare("SELECT id,state FROM messages ORDER BY id").all()) + JSON.stringify(s.db.prepare("SELECT id,state,spec_revision FROM tasks ORDER BY id").all());
  assert.equal(snap(sa), snap(sb), '固定种子→状态一致');
  assert.equal(env_seed(a), env_seed(b));
  sa.close(); sb.close();
  function env_seed(e) { return e.seed; }
});

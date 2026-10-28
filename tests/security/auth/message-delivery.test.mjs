/** DR02第二段（场景一核心）：消息真实投递泵——queued→目标原生会话真实跑轮→
 * 依回执结算delivered/failed/uncertain；回复原文入delivery_json并可经操作步骤查询；不伪造delivered。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { bootstrapRole } from '../../../packages/domain/dist/bootstrap/index.js';
import { claimForSending, markDelivered, markDeliveryFailed, markUncertainDelivery, dispatchQueuedForEnabledRoles } from '../../../packages/domain/dist/messages/index.js';
import { installSyntheticPolicy } from './synthetic-policy.mjs';
import { createDurableOperation, recordStep } from '../../../apps/kernel/dist/tools/orchestration-tools.js';
import { messageSendOrchestration } from '../../../apps/kernel/dist/tools/orchestration-tools.js';
import { pumpMessageDelivery } from '../../../apps/kernel/dist/execution/message-delivery.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';
import { issueControlEntryToken, authenticateControlEntry } from '../../../apps/kernel/dist/auth/control-entry.js';
import { assertMessageSenderAuthorized } from '../../../apps/kernel/dist/execution/message-authorization.js';
import {setRoleModelPreference} from '../../../packages/domain/dist/roles/index.js';
import {NativeRpcError} from '../../../apps/kernel/dist/native/stdio-peer.js';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-msgdel-', () => { for (const s of stores.splice(0)) { try { s.close(); } catch { /* 已关 */ } } });
  const store = openStore(path.join(dir, 'state.sqlite')); stores.push(store);
  fs.mkdirSync(path.join(dir,'worker'));fs.mkdirSync(path.join(dir,'other'));
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: dir, objective: 'o' }, 100);
  bootstrapRole(store, { projectId: 'p1', localRef: 'worker', name: '执行', charter: '执行角色', permissionProfileId: 'x', permissionProfileRevision: 1, expectedPolicyRevision: 0, principalId: 'user-1', requestId: 'b0' }, 110);
  installSyntheticPolicy(store, 'p1', [{ id: 'x', revision: 1, actions: ['identity'], readPaths: [], writePaths: [], roleIds: [], delegableActions: [], maxDelegationDepth: 0 }]);
  // 唯一活绑定：worker→sess-worker（native 'sess-worker-1'），角色ready+enabled
  store.transaction(db => {
    db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id,native_workspace_id) VALUES('sess-worker','zcode','h','p','sess-worker-1',?)").run(path.join(dir,'worker'));
    db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('bnd-worker','p1','worker','sess-worker',1,200)").run();
    db.prepare("UPDATE roles SET binding_state='ready' WHERE id='worker'").run();
  });
  return { dir, store, stores };
}

/** 种一条消息（操作+命令+消息）；绑定状态/角色状态由用例自行调整。 */
function seedMessage(store, { tag = 'm1', messageState = 'queued', body = '你好' } = {}) {
  const op = createDurableOperation(store, { operationKey: `msgop-${tag}`, kind: 'message.send', projectId: 'p1', payload: { toRoleId: 'worker', body } }, 300);
  store.transaction(db => {
    db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES(?,?,?,?,?,'message.send',?,'completed',?)").run(`cmd-${tag}`, 'p1', 'control-t', op.operationId, '0'.repeat(64), JSON.stringify({ toRoleId: 'worker', body }), 300);
    db.prepare("INSERT INTO messages(id,project_id,command_id,to_role_id,task_id,kind,body,delivery_json,state,created_at) VALUES(?,?,?,?,NULL,'information',?,?,?,?)").run(`msg-${tag}`, 'p1', `cmd-${tag}`, 'worker', body, JSON.stringify({ transitions: [{ state: 'stored', at: 300 }] }), messageState, 300);
  });
  return { messageId: `msg-${tag}`, operationId: op.operationId };
}

const receiptCompleted = (nativeId, reply) => ({ harnessId: 'zcode', nativeConversationId: nativeId, nativeTurnId: `turn-${nativeId}`, status: 'completed', responseText: reply, exitConfirmed: true });


test('明确failed将安全诊断同时保存到消息和副作用，过滤私密字段且不伪报unknown',async t=>{
 const {store}=fixture(t);seedMessage(store);
 const result=await pumpMessageDelivery(store,{now:()=>1000,runInBinding:async(_b,target)=>({harnessId:'zcode',nativeConversationId:target.nativeConversationId,nativeTurnId:'failed-turn',status:'failed',responseText:'',exitConfirmed:true,failureCode:'CODEX_TURN_FAILED',diagnostics:{code:'CODEX_USAGE_LIMIT_EXCEEDED',message:'PRIVATE_SECRET',stderr:'PRIVATE_SECRET',stack:'PRIVATE_SECRET'}})});
 assert.equal(result.failed,1);assert.equal(result.uncertain,0);
 const row=store.db.prepare('SELECT state,delivery_json FROM messages').get();assert.equal(row.state,'failed');
 assert.deepEqual(JSON.parse(row.delivery_json).transitions.at(-1).receipt.diagnostics,{code:'CODEX_USAGE_LIMIT_EXCEEDED'});
 const effect=store.db.prepare('SELECT state,evidence_json FROM native_write_effects').get();assert.equal(effect.state,'settled');
 assert.deepEqual(JSON.parse(effect.evidence_json).receipt.diagnostics,{code:'CODEX_USAGE_LIMIT_EXCEEDED'});
 assert.doesNotMatch(row.delivery_json+effect.evidence_json,/PRIVATE_SECRET/);
});

for(const lateError of ['ordinary','not-sent'])test(`原生started元数据先持久化，${lateError}异常不能丢ID或反写未发送`,async t=>{
 const {store}=fixture(t);seedMessage(store);let late;
 const result=await pumpMessageDelivery(store,{now:()=>1000,runInBinding:async(_binding,target,_input,guard,started)=>{
  guard();late=started;started('zcode',target.nativeConversationId,'actual-started-turn');
  const row=store.db.prepare('SELECT evidence_json FROM native_write_effects').get();assert.equal(JSON.parse(row.evidence_json).receipt.nativeTurnId,'actual-started-turn');
  // 已观察到本次原生轮后权限变化，也不能让已经发生的观察消失。
  store.db.exec('UPDATE projects SET user_paused=1');throw lateError==='not-sent'?new NativeRpcError('SYNTHETIC_LATE_NOT_SENT','not_sent'):Error('SYNTHETIC_OBSERVATION_LOST');
 }});
 assert.equal(result.uncertain,1);assert.equal(result.failed,0);const row=store.db.prepare('SELECT state,delivery_json FROM messages').get(),receipt=JSON.parse(row.delivery_json).transitions.at(-1).receipt;
 assert.equal(row.state,'uncertain');assert.equal(receipt.nativeTurnId,'actual-started-turn');assert.equal(JSON.parse(store.db.prepare('SELECT evidence_json FROM native_write_effects').get().evidence_json).receipt.nativeTurnId,'actual-started-turn');
 assert.throws(()=>late('zcode','sess-worker-1','late-other-turn'),/SOURCE_CHANGED|START_CHANGED/);assert.equal(store.db.prepare('SELECT state FROM native_write_effects').get().state,'unknown');
});

for(const mode of ['wrong-target','contradiction','storage-failure'])test(`started ${mode}保留unknown，不成为delivered`,async t=>{
 const {store}=fixture(t);seedMessage(store);
 if(mode==='storage-failure')store.db.exec("CREATE TRIGGER fail_started_write BEFORE UPDATE ON native_write_effects WHEN json_extract(NEW.evidence_json,'$.nativeStartObserved')=1 BEGIN SELECT RAISE(ABORT,'SYNTHETIC_START_WRITE_FAILURE'); END;");
 const result=await pumpMessageDelivery(store,{now:()=>1000,runInBinding:async(_b,target,_i,guard,started)=>{
  guard();try{started('zcode',mode==='wrong-target'?'wrong-native':target.nativeConversationId,'first-turn');if(mode==='contradiction')started('zcode',target.nativeConversationId,'second-turn');}catch{/* 测试即使驱动吞错并回成功，内核仍不能放行 */}
  return {harnessId:'zcode',nativeConversationId:target.nativeConversationId,nativeTurnId:'first-turn',status:'completed',responseText:'不可当成功',exitConfirmed:true};
 }});
 assert.equal(result.delivered,0);assert.equal(result.uncertain,1);const effect=store.db.prepare('SELECT state,evidence_json FROM native_write_effects').get();assert.equal(effect.state,'unknown');assert.equal(JSON.parse(effect.evidence_json).unattributed,true);
});

test('消息异步准备期间模型配置变化：职责版本未变仍拒绝旧输入',async t=>{
 const {store}=fixture(t);seedMessage(store,{tag:'model-change'});let inputs=0;const revision=store.db.prepare("SELECT revision FROM roles WHERE id='worker'").get().revision;
 const result=await pumpMessageDelivery(store,{now:()=>1000,runInBinding:async(_b,target,_text,guard)=>{await Promise.resolve();setRoleModelPreference(store,'p1','worker',{raw:'new config',recordedAt:1000},null);assert.equal(store.db.prepare("SELECT revision FROM roles WHERE id='worker'").get().revision,revision);guard();inputs++;return receiptCompleted(target.nativeConversationId,'never');}});
 assert.equal(inputs,0);assert.equal(result.failed,1);assert.equal(store.db.prepare("SELECT state FROM messages WHERE id='msg-model-change'").get().state,'failed');
});

test('工厂unknown占位也阻止消息外发，不能跨通路超过总并发',async t=>{
 const {store}=fixture(t);seedMessage(store,{tag:'factory-capacity'});store.db.exec("UPDATE projects SET policy_json=json_set(policy_json,'$.limits.totalConcurrency',1)");
 const op=createDurableOperation(store,{operationKey:'other-unknown-factory',kind:'project.bootstrap',projectId:'p1',payload:{roles:[{roleId:'another'}]}},300);
 recordStep(store,op.operationId,{step:'role:another:factory-call',state:'sent',detail:null,at:300},300);let sent=0;
 const services={now:()=>1000,runInBinding:async(_b,target,_body,guard)=>{guard();sent++;return receiptCompleted(target.nativeConversationId,'ok');}};
 await pumpMessageDelivery(store,services);assert.equal(sent,0);assert.equal(store.db.prepare("SELECT state FROM messages WHERE id='msg-factory-capacity'").get().state,'queued');
 recordStep(store,op.operationId,{step:'role:another:session-not-sent',state:'failed',detail:'synthetic no-send proof',at:1000},1000);
 await pumpMessageDelivery(store,services);assert.equal(sent,1);
});

test('Q1：原生禁用及等待期间禁用均不发送，重新授权后同一排队消息仅发送一次',async t=>{
 for(const timing of ['before','during-observe'])await t.test(timing,async inner=>{
  const {store}=fixture(inner);seedMessage(store);
  if(timing==='before')store.db.exec("UPDATE projects SET policy_json=json_set(policy_json,'$.nativeMode','disabled') WHERE id='p1'");
  else store.db.exec("UPDATE sessions SET verified_origin=0");
  let calls=0;
  const services={now:()=>1000,officialObserve:async()=>{store.db.exec("UPDATE projects SET policy_json=json_set(policy_json,'$.nativeMode','disabled') WHERE id='p1'");return true;},runInBinding:async(_b,target,_text,guard)=>{guard();calls++;return receiptCompleted(target.nativeConversationId,'ok');}};
  await pumpMessageDelivery(store,services);assert.equal(calls,0);assert.equal(store.db.prepare('SELECT state FROM messages').get().state,'queued');
  store.db.exec("UPDATE projects SET policy_json=json_set(policy_json,'$.nativeMode','verified_only') WHERE id='p1'");
  await pumpMessageDelivery(store,services);await pumpMessageDelivery(store,services);assert.equal(calls,1);
 });
});

test('旧uncertain缺可信原范围时保守阻断项目；合成终态后本地消息可继续',async t=>{
 const {store,dir}=fixture(t);seedMessage(store,{tag:'unknown',messageState:'uncertain'});seedMessage(store,{tag:'blocked'});seedMessage(store,{tag:'other'});
 store.db.exec("INSERT INTO roles(id,project_id,name,charter,permission_profile,desired_state,binding_state,revision) VALUES('other','p1','other','other','x','enabled','ready',1);INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s-other','zcode','h','p','other-native');INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b-other','p1','other','s-other',1,200);UPDATE messages SET to_role_id='other' WHERE id='msg-other'");
 store.db.prepare("UPDATE sessions SET native_workspace_id=? WHERE id='s-other'").run(path.join(dir,'other'));
 const sent=[];const services={now:()=>1000,runInBinding:async(_b,target,_text,guard)=>{guard();sent.push(target.nativeConversationId);return receiptCompleted(target.nativeConversationId,'ok');}};
 await pumpMessageDelivery(store,services);assert.deepEqual(sent,[]);assert.equal(store.db.prepare("SELECT state FROM messages WHERE id='msg-blocked'").get().state,'queued');
 // 合成终态仅布置测试解除；不冒充真实原生恢复。
 store.db.exec("UPDATE messages SET state='failed' WHERE id='msg-unknown'");
 await pumpMessageDelivery(store,services);await pumpMessageDelivery(store,services);assert.deepEqual([...sent].sort(),['other-native','sess-worker-1'].sort());
});

test('批量快照不越过暂停：第一条在途完成，暂停后第二条保持queued', async t => {
  const { store } = fixture(t);
  seedMessage(store, { tag: 'pause-a' }); seedMessage(store, { tag: 'pause-b' });
  let calls = 0;
  const result = await pumpMessageDelivery(store, { now: () => 1000, runInBinding: async (_b, target) => {
    calls++; store.db.prepare("UPDATE projects SET user_paused=1 WHERE id='p1'").run();
    return receiptCompleted(target.nativeConversationId, '在途完成');
  } });
  assert.equal(calls, 1); assert.equal(result.delivered, 1); assert.equal(result.skipped, 1);
  assert.equal(store.db.prepare("SELECT state FROM messages WHERE id='msg-pause-b'").get().state, 'queued');
});

test('异步来源观察期间换绑/暂停，回到claim边界拒绝旧目标外发', async t => {
  for (const change of ['pause', 'epoch', 'revoke']) {
    const { store } = fixture(t); seedMessage(store, { tag: 'observe-'+change });
    store.db.prepare("UPDATE sessions SET verified_origin=0 WHERE id='sess-worker'").run();
    let calls=0; let owner=true;
    const result=await pumpMessageDelivery(store, { now:()=>1000, assertOwner:()=>{ if(!owner)throw Error('OWNER_LOST'); }, officialObserve:async()=>{
      if(change==='pause')store.db.prepare("UPDATE projects SET user_paused=1 WHERE id='p1'").run();
      if(change==='epoch')store.db.prepare("UPDATE role_bindings SET epoch=2 WHERE id='bnd-worker'").run();
      if(change==='revoke')owner=false;
      return true;
    }, runInBinding:async()=>{ calls++; throw Error('MUST_NOT_SEND'); } });
    assert.equal(calls,0); assert.equal(result.skipped,1);
  }
});

test('驱动异步准备后再次调用发送guard，暂停后不启动模型', async t => {
  const {store}=fixture(t); seedMessage(store,{tag:'driver-guard'});
  let modelCalls=0;
  const result=await pumpMessageDelivery(store,{now:()=>1000,runInBinding:async(_b,target,_text,guard)=>{
    await Promise.resolve(); store.db.prepare("UPDATE projects SET user_paused=1 WHERE id='p1'").run();
    guard(); modelCalls++; return receiptCompleted(target.nativeConversationId,'no');
  }});
  assert.equal(modelCalls,0); assert.equal(result.failed,1);
});

test('在途结果返回前绑定换代，不将旧回执结算成新绑定delivered',async t=>{
  const {store}=fixture(t);seedMessage(store,{tag:'finish-epoch'});
  const result=await pumpMessageDelivery(store,{now:()=>1000,runInBinding:async(_b,target)=>{
    store.db.prepare("UPDATE role_bindings SET epoch=2 WHERE id='bnd-worker'").run();
    return receiptCompleted(target.nativeConversationId,'old');
  }});
  assert.equal(result.delivered,0);assert.equal(result.uncertain,1);
});

test('排队后撤销/过期/缩减发送权限：原发送者授权在每条外发前重验',async t=>{
  for(const change of ['revoke','expire','permission','scope']){
    const {store}=fixture(t);seedMessage(store,{tag:'auth-a'});seedMessage(store,{tag:'auth-b'});
    const token=issueControlEntryToken(store,'p1',['message.send'],500,10000).token;
    const source=authenticateControlEntry(store,token,1000);
    store.db.prepare('UPDATE commands SET source_principal_id=?').run(source.principalId);
    let calls=0;
    const result=await pumpMessageDelivery(store,{now:()=>1000,assertSenderAuthorized:id=>assertMessageSenderAuthorized(store,id,1000),runInBinding:async(_b,target)=>{
      calls++;
      const sql=change==='revoke'?'revoked_at=1000':change==='expire'?'expires_at=999':change==='permission'?"permissions_json='[]'":"project_id='another-project'";
      store.db.exec('UPDATE control_entries SET '+sql);
      return receiptCompleted(target.nativeConversationId,'inflight');
    }});
    assert.equal(calls,1,change);assert.equal(result.delivered,1);assert.equal(result.skipped,1);
    assert.equal(store.db.prepare("SELECT state FROM messages WHERE id='msg-auth-b'").get().state,'queued');
  }
});

test('投递泵正例：queued→真实跑轮→delivered；回复原文入回执且可经操作步骤查询', async t => {
  const { store } = fixture(t);
  const { messageId, operationId } = seedMessage(store, { tag: 'ok' });
  const calls = [];
  const services = {
    now: () => 1000,
    async runInBinding(bindingId, target, input) {
      calls.push({ bindingId, target, input });
      return receiptCompleted(target.nativeConversationId, '你好！我是ZCode助手的真实回复。');
    },
  };
  const result = await pumpMessageDelivery(store, services);
  assert.equal(result.attempted, 1);
  assert.equal(result.delivered, 1);
  // 真实执行参数：绑定ID+原生会话+消息原文
  assert.equal(calls[0].input, '你好');
  assert.equal(calls[0].target.nativeConversationId, 'sess-worker-1');
  assert.equal(calls[0].bindingId, 'bnd-worker');
  // 消息终态+回执（回复原文可查）
  const row = store.db.prepare("SELECT state,delivery_json FROM messages WHERE id=?").get(messageId);
  assert.equal(row.state, 'delivered');
  const receipt = JSON.parse(row.delivery_json).transitions.at(-1).receipt;
  assert.equal(receipt.nativeTurnId, 'turn-sess-worker-1');
  assert.equal(receipt.responseText, '你好！我是ZCode助手的真实回复。');
  assert.equal(receipt.status, 'completed');
  // 操作步骤含deliver-turn observed + 回复摘录（operation_status可查）
  const op = store.db.prepare("SELECT steps_json FROM durable_operations WHERE id=?").get(operationId);
  const steps = JSON.parse(op.steps_json);
  const step = steps.find(s => s.step === 'deliver-turn');
  assert.equal(step.state, 'observed');
  assert.ok(step.detail.includes('turn-sess-worker-1') && step.detail.includes('真实回复'), '步骤含轮次与回复');
});

test('投递泵诚实结算：四种终态各自独立，不越过同角色unknown占位',async t=>{
 const {NativeRpcError}=await import('../../../apps/kernel/dist/native/stdio-peer.js');
 for(const mode of ['failed','unknown','throw','not_sent'])await t.test(mode,async inner=>{
  const {store}=fixture(inner);const m=seedMessage(store,{tag:mode});
  const r=await pumpMessageDelivery(store,{now:()=>1000,runInBinding:async(_b,target)=>{
   if(mode==='throw')throw Error('UNCLASSIFIED');
   if(mode==='not_sent')throw new NativeRpcError('CONFIG_MISSING','not_sent');
   return {harnessId:'zcode',nativeConversationId:target.nativeConversationId,nativeTurnId:null,status:mode,responseText:'',exitConfirmed:mode==='failed',diagnostics:{code:'CLI_TIMEOUT',elapsedMs:900000,frames:5,lastType:'tool'}};
  }});
  const expected=['unknown','throw'].includes(mode)?'uncertain':'failed';
  assert.equal(store.db.prepare('SELECT state FROM messages WHERE id=?').get(m.messageId).state,expected);
  assert.equal(r.delivered,0);assert.equal(r[expected],1);
  if(mode==='unknown'){const transitions=JSON.parse(store.db.prepare('SELECT delivery_json FROM messages WHERE id=?').get(m.messageId).delivery_json).transitions;assert.deepEqual(transitions.at(-1).receipt.diagnostics,{code:'CLI_TIMEOUT',elapsedMs:900000,frames:5,lastType:'tool'});}
 });
});

test('投递泵边界：绑定非ready跳过（不投递）；角色停用保持stored；并发防护不双发', async t => {
  const { store } = fixture(t);
  seedMessage(store, { tag: 'prov', messageState: 'queued' }); // 绑定将转provisioning
  seedMessage(store, { tag: 'paused', messageState: 'stored' }); // 角色将停用
  store.db.prepare("UPDATE roles SET binding_state='provisioning', desired_state='paused' WHERE id='worker'").run();
  let runs = 0;
  const services = { now: () => 3000, async runInBinding() { runs += 1; return receiptCompleted('sess-worker-1', 'r'); } };
  const r1 = await pumpMessageDelivery(store, services);
  assert.equal(r1.attempted, 0, 'provisioning/停用不投递');
  assert.equal(store.db.prepare("SELECT state FROM messages WHERE id='msg-prov'").get().state, 'queued', 'provisioning消息保持queued待握手');
  assert.equal(store.db.prepare("SELECT state FROM messages WHERE id='msg-paused'").get().state, 'stored', '停用角色保持stored可追踪');
  // 恢复启用+ready：stored放行为queued并投递
  store.db.prepare("UPDATE roles SET binding_state='ready', desired_state='enabled' WHERE id='worker'").run();
  const r2 = await pumpMessageDelivery(store, services);
  assert.equal(r2.delivered, 2);
  assert.equal(runs, 2);
  // 并发防护：慢泵先领取race消息（在runInBinding内驻留80ms），期间重入泵立即返回零
  seedMessage(store, { tag: 'race', messageState: 'queued' });
  const slow = pumpMessageDelivery(store, { now: () => 3001, async runInBinding() { await new Promise(r => setTimeout(r, 80)); runs += 1; return receiptCompleted('sess-worker-1', 'r'); } });
  await new Promise(r => setTimeout(r, 20));
  const r3 = await pumpMessageDelivery(store, services);
  assert.equal(r3.attempted, 0, '并发泵不重复处理');
  await slow;
  assert.equal(runs, 3, '慢泵只处理了自己领取的race消息');
  assert.equal(store.db.prepare("SELECT state FROM messages WHERE id='msg-race'").get().state, 'delivered');
});

test('域层投递状态机：claimForSending原子占用；非法转移拒绝', t => {
  const { store } = fixture(t);
  const { messageId } = seedMessage(store, { tag: 'sm1' });
  assert.equal(claimForSending(store, 'p1', messageId, 400).state, 'sending');
  assert.throws(() => claimForSending(store, 'p1', messageId, 401), /MESSAGE_TRANSITION_REJECTED/, 'sending不可重复领取');
  assert.equal(markDeliveryFailed(store, 'p1', messageId, { failureCode: 'X' }, 402).state, 'failed');
  assert.throws(() => markDelivered(store, 'p1', messageId, {}, 403), /MESSAGE_TRANSITION_REJECTED/, 'failed不可伪delivered');
  const { messageId: m2 } = seedMessage(store, { tag: 'sm2' });
  claimForSending(store, 'p1', m2, 410);
  assert.equal(markUncertainDelivery(store, 'p1', m2, { failureCode: 'T' }, 411).state, 'uncertain');
  assert.equal(dispatchQueuedForEnabledRoles(store, 'p1', 412).dispatched >= 0, true, '放行函数可用');
});

test('场景一完整链路：无绑定→工厂现场建会话→握手ready→消息→泵真实投递→回复可查', async t => {
  const { store } = fixture(t);
  // 目标角色unbound（清掉fixture预置绑定，模拟首次message_send现场建会话）
  store.db.prepare("DELETE FROM role_bindings WHERE role_id='worker'").run();
  store.db.prepare("UPDATE roles SET binding_state='unbound' WHERE id='worker'").run();
  let pumpTriggered = 0;
  const factory = {
    async ensureBoundSession(input) {
      input.onStep({ step: 'create-session', state: 'sent', detail: null, at: Date.now() });
      input.onStep({ step: 'create-session', state: 'observed', detail: 'native-sess-sc1', at: Date.now() });
      input.onStep({ step: 'deliver-charter', state: 'observed', detail: 'native-turn-charter', at: Date.now() });
      return { sessionRef:{harnessId:input.harnessId,hostId:'synthetic',profileId:'fixture',nativeConversationId:'native-sess-sc1',nativeWorkspaceId:input.workspaceRoot},charterDelivered:true, nativeSessionId: 'native-sess-sc1', nativeTurnId: 'native-turn-charter' };
    },
  };
  // 泵在onQueued时联动（生产application同构：onQueued→pumpMessageDelivery）
  const pumpOnce = () => { pumpTriggered += 1; return pumpMessageDelivery(store, { now: () => Date.now(), async runInBinding(_b, target, input) { return receiptCompleted(target.nativeConversationId, `${input}——已收到，这是原生助手真实回复。`); } }); };
  const messageSend = messageSendOrchestration(store, factory, { onQueued: () => { void pumpOnce(); } });
  const control = authenticateControlEntry(store,issueControlEntryToken(store,'p1',['message.send'],Date.now()-100,60000).token,Date.now());
  const sent = messageSend(store, control, { toRoleId: 'worker', body: '你好' });
  assert.equal(sent.ok, true);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.ok(pumpTriggered >= 1, 'onQueued触发泵');
  // 全链可查：会话（原生ID保留）、绑定ready、消息delivered、turn在回执、操作步骤完整
  const sess = store.db.prepare("SELECT native_conversation_id FROM sessions WHERE native_conversation_id='native-sess-sc1'").get();
  assert.ok(sess, '工厂会话登记（原生ID不建替代）');
  assert.equal(store.db.prepare("SELECT binding_state FROM roles WHERE id='worker'").get().binding_state, 'ready', '握手后ready');
  const msg = store.db.prepare("SELECT state,delivery_json FROM messages WHERE body='你好'").get();
  assert.equal(msg.state, 'delivered');
  const receipt = JSON.parse(msg.delivery_json).transitions.at(-1).receipt;
  assert.equal(receipt.nativeConversationId, 'native-sess-sc1');
  assert.ok(receipt.nativeTurnId && receipt.responseText.includes('真实回复'), '回复原文在回执');
  const op = store.db.prepare("SELECT steps_json FROM durable_operations WHERE id=?").get(sent.payload.operationId);
  const steps = JSON.parse(op.steps_json).map(s => s.step);
  for (const expected of ['create-session', 'startup-ack', 'deliver-message', 'deliver-turn']) assert.ok(steps.includes(expected), `操作含${expected}`);
  const command = store.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE type='message.send' AND request_id=?").get(sent.payload.operationId);
  assert.equal(command.n, 1, '命令对应可查');
});

test('编排→泵联动：message_send入队后onQueued触发（已有绑定路径也入队不吞消息）', async t => {
  const { store } = fixture(t);
  const queuedProjects = [];
  const factory = { async ensureBoundSession() { throw new Error('不应建新会话——已有绑定'); } };
  const messageSend = messageSendOrchestration(store, factory, { onQueued: projectId => { queuedProjects.push(projectId); } });
  const control = authenticateControlEntry(store,issueControlEntryToken(store,'p1',['message.send'],Date.now()-100,60000).token,Date.now());
  const r = messageSend(store, control, { toRoleId: 'worker', body: '第二条消息' });
  assert.equal(r.ok, true);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(queuedProjects, ['p1'], 'onQueued触发');
  const msg = store.db.prepare("SELECT state FROM messages WHERE body='第二条消息'").get();
  assert.equal(msg.state, 'stored', '已有绑定路径同样入队（不吞消息）');
  // 泵收尾：真实送达
  const res = await pumpMessageDelivery(store, { now: () => 600, async runInBinding(_b, target, input) { return receiptCompleted(target.nativeConversationId, `回声:${input}`); } });
  assert.equal(res.delivered, 1);
  const done = store.db.prepare("SELECT state,delivery_json FROM messages WHERE body='第二条消息'").get();
  assert.equal(done.state, 'delivered');
  assert.equal(JSON.parse(done.delivery_json).transitions.at(-1).receipt.responseText, '回声:第二条消息');
});

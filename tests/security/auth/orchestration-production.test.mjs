/** DR02验证：生产编排模块导入测试（替代测试内重写实现）。
 * 验证orchestration-tools.ts的持久操作：存库/幂等/部分成功恢复/查询。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { bootstrapRole } from '../../../packages/domain/dist/bootstrap/index.js';
import { installSyntheticPolicy } from './synthetic-policy.mjs';
import { createDurableOperation, recordStep, readOperation, unfinishedRoleSessions, projectBootstrapOrchestration as rawProjectBootstrap, messageSendOrchestration, taskDispatchOrchestration,settleCompletedOrchestrationsWithin } from '../../../apps/kernel/dist/tools/orchestration-tools.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';
import { NativeRpcError } from '../../../apps/kernel/dist/native/stdio-peer.js';


// 和生产默认布局一样，给不同角色独立的实际目录；不以共享cwd测试“独立”并发。
const projectBootstrapOrchestration=(store,factory,charter,hooks,workspaceFor)=>rawProjectBootstrap(store,factory,charter,hooks,workspaceFor??((projectId,roleId)=>path.join(String(store.db.prepare('SELECT canonical_root FROM projects WHERE id=?').get(projectId).canonical_root),'roles',roleId)));

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-orch-', () => { for (const s of stores.splice(0)) { try { s.close(); } catch { /* 已关 */ } } });
  const store = openStore(path.join(dir, 'state.sqlite')); stores.push(store);
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: dir, objective: 'o' }, 100);
  bootstrapRole(store, { projectId: 'p1', localRef: 'lead', name: '负责人', charter: '现有负责人', permissionProfileId: 'x', permissionProfileRevision: 1, expectedPolicyRevision: 0, principalId: 'user-1', requestId: 'b0' }, 110);
  installSyntheticPolicy(store, 'p1', ['x','team'].map(id=>({id,revision:1,actions:['identity'],readPaths:[],writePaths:[],roleIds:[],delegableActions:[],maxDelegationDepth:0})));
  store.db.prepare("INSERT INTO control_entries(token_hash,project_id,permissions_json,created_at,expires_at) VALUES(?,'p1',?,?,?)").run('a'.repeat(64),JSON.stringify(['project.bootstrap','message.send','task.dispatch']),Date.now()-1000,Date.now()+60000);
  return { dir, store, stores };
}

const controlPrincipal = { kind: 'control_entry', principalId: 'control-'+ 'a'.repeat(64), projectId: 'p1', permissions: ['project.bootstrap', 'message.send', 'task.dispatch'] };

test('工厂部分创建但章程未送达：保留原ID与provisioning，不注入工具、不握手、不重建',async t=>{
 const {store}=fixture(t);let calls=0,injected=0;
 const factory={ensureBoundSession:async input=>{calls++;input.onStep({step:'create-session',state:'observed',detail:'same-empty-session',at:Date.now()});return {sessionRef:{harnessId:'zcode',hostId:'h',profileId:'p',nativeConversationId:'same-empty-session',nativeWorkspaceId:input.workspaceRoot},nativeSessionId:'same-empty-session',nativeTurnId:null,charterDelivered:false};}};
 const bootstrap=projectBootstrapOrchestration(store,factory,x=>x,{onBoundSession(){injected++;}}),args={objective:'严格模型被拒的空会话',roles:[{roleId:'partial-model',harnessId:'zcode'}]};const result=bootstrap(store,controlPrincipal,args);await new Promise(r=>setImmediate(r));
 assert.equal(injected,0);assert.equal(store.db.prepare("SELECT binding_state FROM roles WHERE id='partial-model'").get().binding_state,'provisioning');assert.equal(store.db.prepare("SELECT native_conversation_id FROM sessions WHERE id='sessrow-partial-model'").get().native_conversation_id,'same-empty-session');const op=readOperation(store,result.payload.operationId);assert.ok(op.steps.some(s=>s.step==='role:partial-model:charter-not-delivered'&&s.state==='failed'));assert.ok(!op.steps.some(s=>s.step.endsWith('tool-entry-inject-failed')||s.step.endsWith('startup-ack')));
 bootstrap(store,controlPrincipal,args);await new Promise(r=>setImmediate(r));assert.equal(calls,1);assert.equal(injected,0);
});

test('消息建会话后工具注入失败，重放修复同绑定并补原消息一次；暂停/撤销/未知不能绕过',async t=>{
 for(const mode of ['recover','pause','revoke','unknown'])await t.test(mode,async inner=>{
  const {store}=fixture(inner);store.db.exec("INSERT INTO roles(id,project_id,name,charter,permission_profile,desired_state,binding_state,revision) VALUES('recover-message','p1','r','charter','team','enabled','unbound',1)");let calls=0,broken=true;
  const factory={ensureBoundSession:async input=>{calls++;if(mode==='unknown')throw Error('UNCERTAIN_ORIGINAL_CREATE');return{sessionRef:{harnessId:'codex',hostId:'synthetic',profileId:'message-recovery',nativeConversationId:'original-message-thread',nativeWorkspaceId:input.workspaceRoot},nativeSessionId:'original-message-thread',nativeTurnId:'chapter',charterDelivered:true};}};
  const send=messageSendOrchestration(store,factory,{onBoundSession:()=>{if(broken)throw Error('INJECTION_FAILED');}}),args={toRoleId:'recover-message',body:'不能漏掉的原消息',harnessId:'codex',requestId:'original-intent'},first=send(store,controlPrincipal,args);await new Promise(r=>setImmediate(r));assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,0);broken=false;
  if(mode==='pause')store.db.exec('UPDATE projects SET user_paused=1');if(mode==='revoke')store.db.prepare('UPDATE control_entries SET revoked_at=?').run(Date.now());
  const again=send(store,controlPrincipal,args);await new Promise(r=>setImmediate(r));assert.equal(calls,1);assert.equal(again.payload.operationId,first.payload.operationId);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,mode==='recover'?1:0);
  if(mode==='recover'){assert.equal(again.ok,true,JSON.stringify(again));send(store,controlPrincipal,args);send(store,controlPrincipal,args);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,1);assert.equal(readOperation(store,first.payload.operationId).state,'observed');assert.equal(store.db.prepare('SELECT state FROM messages').get().state,'stored');}
  else assert.notEqual(readOperation(store,first.payload.operationId).state,'observed');
 });
});

test('消息入队审计失败事务回滚，原已登记会话重放只补原意图；不重复外发',async t=>{
 const {store}=fixture(t);store.db.exec("INSERT INTO roles(id,project_id,name,charter,permission_profile,desired_state,binding_state,revision) VALUES('queue-rollback','p1','r','charter','team','enabled','unbound',1);CREATE TRIGGER reject_message_queue BEFORE INSERT ON events WHEN NEW.type='message.intent_queued' BEGIN SELECT RAISE(ABORT,'TEST_QUEUE_AUDIT');END");let calls=0;
 const send=messageSendOrchestration(store,{ensureBoundSession:async input=>{calls++;return{sessionRef:{harnessId:'codex',hostId:'synthetic',profileId:'queue',nativeConversationId:'original-queue-thread',nativeWorkspaceId:input.workspaceRoot},nativeSessionId:'original-queue-thread',nativeTurnId:'chapter',charterDelivered:true};}}),args={toRoleId:'queue-rollback',body:'persistent payload',harnessId:'codex',requestId:'audit-intent'},first=send(store,controlPrincipal,args);await new Promise(r=>setImmediate(r));assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,0);assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE request_id=?").get(first.payload.operationId).n,0);store.db.exec('DROP TRIGGER reject_message_queue');
 const next=send(store,controlPrincipal,args);assert.equal(next.ok,true,JSON.stringify(next));assert.equal(calls,1);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,1);assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='message.intent_queued'").get().n,1);
});

test('重启后按原完整绑定补齐消息；登记来源缺失/身份错配不借ready洗unknown',async t=>{
 for(const mode of ['restart','missing-source','wrong-host'])await t.test(mode,async inner=>{
  const {store,stores,dir}=fixture(inner);store.db.exec("INSERT INTO roles(id,project_id,name,charter,permission_profile,desired_state,binding_state,revision) VALUES('restart-message','p1','r','charter','team','enabled','unbound',1)");let calls=0,broken=true;
  const factory={ensureBoundSession:async input=>{calls++;return{sessionRef:{harnessId:'codex',hostId:'original-host',profileId:'original-profile',nativeConversationId:'original-restart-thread',nativeWorkspaceId:input.workspaceRoot},nativeSessionId:'original-restart-thread',nativeTurnId:'chapter',charterDelivered:true};}},hooks={onBoundSession:()=>{if(broken)throw Error('SYNTHETIC_TOOLS');}},send=messageSendOrchestration(store,factory,hooks),args={toRoleId:'restart-message',body:'persisted restart payload',harnessId:'codex',requestId:'restart-intent'},first=send(store,controlPrincipal,args);await new Promise(r=>setImmediate(r));assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,0);
  if(mode!=='restart'){const op=readOperation(store,first.payload.operationId),steps=op.steps.filter(s=>mode!=='missing-source'||s.step!=='binding-registration').map(s=>{if(mode!=='wrong-host'||s.step!=='binding-registration')return s;const data=JSON.parse(s.detail);data.sessionRef.hostId='unrelated-host';return{...s,detail:JSON.stringify(data)};});store.db.prepare('UPDATE durable_operations SET steps_json=? WHERE id=?').run(JSON.stringify(steps),first.payload.operationId);}
  store.close();const next=openStore(path.join(dir,'state.sqlite'));stores.push(next);broken=false;const replay=messageSendOrchestration(next,factory,hooks)(next,controlPrincipal,args);assert.equal(replay.payload.operationId,first.payload.operationId);assert.equal(calls,1);assert.equal(next.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,mode==='restart'?1:0);assert.equal(readOperation(next,first.payload.operationId).state,mode==='restart'?'observed':'unknown');
 });
});

test('明确只登记角色也完成建组意图，旧running重启后核对结算幂等且不创建会话',async t=>{
 const {store,stores,dir}=fixture(t);let calls=0;const run=projectBootstrapOrchestration(store,{ensureBoundSession:async input=>{calls++;throw Error('MUST_NOT_CREATE');}},id=>id);
 const reply=run(store,controlPrincipal,{objective:'已有负责人不另建',roles:[{roleId:'registered-only',createSession:false}]});await new Promise(r=>setImmediate(r));assert.equal(calls,0);const id=reply.payload.operationId,op=readOperation(store,id);assert.equal(op.state,'observed');assert.equal(store.db.prepare("SELECT binding_state FROM roles WHERE id='registered-only'").get().binding_state,'unbound');
 store.db.prepare("UPDATE durable_operations SET state='running',steps_json=? WHERE id=?").run(JSON.stringify(op.steps.filter(s=>s.step!=='intent-settled')),id);store.close();const reopened=openStore(path.join(dir,'state.sqlite'));stores.push(reopened);
 assert.equal(reopened.transaction(()=>settleCompletedOrchestrationsWithin(reopened,'p1',Date.now(),id)),1);assert.equal(reopened.transaction(()=>settleCompletedOrchestrationsWithin(reopened,'p1',Date.now(),id)),0);assert.equal(readOperation(reopened,id).state,'observed');assert.equal(calls,0);
});

test('部分建组的done不能结算未知创建、章程未确认或工具未就绪',async t=>{
 for(const mode of ['unknown','charter','tools'])await t.test(mode,async inner=>{
  const {store}=fixture(inner);const factory={ensureBoundSession:async input=>{if(input.roleId==='unfinished'&&mode==='unknown')throw Error('UNKNOWN_NATIVE_CREATION');return{sessionRef:{harnessId:'codex',hostId:'synthetic',profileId:'partial',nativeConversationId:input.roleId,nativeWorkspaceId:input.workspaceRoot},nativeSessionId:input.roleId,nativeTurnId:'chapter',charterDelivered:!(input.roleId==='unfinished'&&mode==='charter')};}};
  const run=projectBootstrapOrchestration(store,factory,id=>id,{onBoundSession:(_binding,role)=>{if(role==='unfinished'&&mode==='tools')throw Error('TOOLS_NOT_READY');}}),reply=run(store,controlPrincipal,{objective:'部分成功不得伪完成',roles:[{roleId:'finished',harnessId:'codex'},{roleId:'unfinished',harnessId:'codex'}]});await new Promise(r=>setImmediate(r));const id=reply.payload.operationId;
  assert.ok(readOperation(store,id).steps.some(s=>s.step==='done'));assert.notEqual(readOperation(store,id).state,'observed');assert.equal(store.transaction(()=>settleCompletedOrchestrationsWithin(store,'p1',Date.now(),id)),0);assert.notEqual(readOperation(store,id).state,'observed');
 });
});

test('旧成功编排按精确来源审计结算；done/无章程/错ID/后继未知创建不能当已完成，审计失败回滚',async t=>{
 for(const mode of ['success','done-only','charter','identity','source-host','later-unknown','audit'])await t.test(mode,async inner=>{
  const {store}=fixture(inner),roleId='terminal-member';
  const run=projectBootstrapOrchestration(store,{ensureBoundSession:async input=>({sessionRef:{harnessId:'codex',hostId:'synthetic',profileId:'terminal',nativeConversationId:'original-terminal',nativeWorkspaceId:input.workspaceRoot},nativeSessionId:'original-terminal',nativeTurnId:'chapter',charterDelivered:true})},id=>id);
  const reply=run(store,controlPrincipal,{objective:'结算来源测试',roles:[{roleId,harnessId:'codex'}]});await new Promise(r=>setImmediate(r));const id=reply.payload.operationId,original=readOperation(store,id);assert.equal(original.state,'observed');
  let steps=original.steps.filter(s=>s.step!=='intent-settled');
  if(mode==='done-only')steps=[{step:'done',state:'observed',detail:null,at:1}];
  if(mode==='charter'||mode==='identity')steps=steps.map(s=>{if(!s.step.endsWith('binding-registration'))return s;const data=JSON.parse(s.detail);if(mode==='charter')data.charterDelivered=false;else data.sessionRef.nativeConversationId='unrelated';return{...s,detail:JSON.stringify(data)};});
  if(mode==='later-unknown')steps.push({step:`role:${roleId}:factory-call`,state:'sent',detail:null,at:Date.now()});
  if(mode==='source-host')steps.push({step:`role:${roleId}:session-identity`,state:'observed',detail:JSON.stringify({harnessId:'codex',hostId:'other-host',profileId:'terminal',nativeConversationId:'original-terminal'}),at:Date.now()});
  store.db.prepare("UPDATE durable_operations SET state='unknown',steps_json=? WHERE id=?").run(JSON.stringify(steps),id);
  const count=()=>store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='orchestration.intent_settled' AND entity_id=?").get(id).n,before=count();
  if(mode==='audit'){store.db.exec("CREATE TRIGGER reject_settlement BEFORE INSERT ON events WHEN NEW.type='orchestration.intent_settled' BEGIN SELECT RAISE(ABORT,'TEST_SETTLEMENT_AUDIT');END");assert.throws(()=>store.transaction(()=>settleCompletedOrchestrationsWithin(store,'p1',Date.now(),id)),/TEST_SETTLEMENT_AUDIT/);assert.equal(readOperation(store,id).state,'unknown');assert.equal(count(),before);return;}
  const n=store.transaction(()=>settleCompletedOrchestrationsWithin(store,'p1',Date.now(),id));assert.equal(n,mode==='success'?1:0);assert.equal(readOperation(store,id).state,mode==='success'?'observed':'unknown');assert.equal(count(),before+n);assert.equal(store.transaction(()=>settleCompletedOrchestrationsWithin(store,'p1',Date.now(),id)),0);
 });
});

test('两端补建与bootstrap注入失败保持provisioning，同绑定修复不另建/重复消息且保存完整身份',async t=>{
  for(const harnessId of ['zcode','codex'])for(const route of ['message','bootstrap']){
    const {store,dir}=fixture(t);const roleId=`${harnessId}-${route}`;const ws=path.join(dir,roleId);fs.mkdirSync(ws);
    const ref={harnessId,hostId:'trusted-real-host',profileId:'trusted-real-profile',nativeConversationId:`native-${roleId}`,nativeWorkspaceId:ws};let calls=0,broken=true;
    const factory={ensureBoundSession:async input=>{calls++;return{sessionRef:ref,nativeSessionId:ref.nativeConversationId,nativeTurnId:'native-charter',charterDelivered:true}}};
    const hook={onBoundSession:(_binding,_role,h,root)=>{assert.equal(h,harnessId);assert.equal(root,ws);if(broken)throw Error('INJECTION_FAILED');}};
    const run=route==='message'?messageSendOrchestration(store,factory,hook,()=>ws):projectBootstrapOrchestration(store,factory,id=>id,hook,()=>ws);
    if(route==='message')store.db.prepare("INSERT INTO roles(id,project_id,name,charter,permission_profile,desired_state,binding_state,revision) VALUES(?,'p1','r','charter','team','enabled','unbound',1)").run(roleId);
    const args=route==='message'?{toRoleId:roleId,harnessId,body:'hello',requestId:'same-intent'}:{objective:'identity',roles:[{roleId,harnessId}]};
    const first=run(store,controlPrincipal,args);await new Promise(r=>setImmediate(r));
    assert.equal(store.db.prepare('SELECT binding_state FROM roles WHERE id=?').get(roleId).binding_state,'provisioning');
    const before=store.db.prepare('SELECT id,session_id FROM role_bindings WHERE role_id=?').get(roleId);
    const s=store.db.prepare('SELECT harness_id,host_id,profile_id,native_conversation_id,native_workspace_id FROM sessions WHERE id=?').get(before.session_id);
    assert.deepEqual({...s},{harness_id:ref.harnessId,host_id:ref.hostId,profile_id:ref.profileId,native_conversation_id:ref.nativeConversationId,native_workspace_id:ws});
    broken=false;const again=run(store,controlPrincipal,args);await new Promise(r=>setImmediate(r));
    assert.equal(first.payload.operationId,again.payload.operationId);assert.equal(calls,1);
    assert.equal(store.db.prepare('SELECT binding_state FROM roles WHERE id=?').get(roleId).binding_state,'ready');
    assert.equal(store.db.prepare('SELECT id FROM role_bindings WHERE role_id=?').get(roleId).id,before.id);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE to_role_id=?').get(roleId).n,route==='message'?1:0);
  }
});

test('工厂未提供完整SessionRef或harness/原生ID不匹配时保持未绑定，不制造身份别名',async t=>{
  const {store}=fixture(t);
  const bootstrap=projectBootstrapOrchestration(store,{ensureBoundSession:async input=>({nativeSessionId:'zcode-id',nativeTurnId:'t',sessionRef:{harnessId:'codex',hostId:'h',profileId:'p',nativeConversationId:'codex-id',nativeWorkspaceId:input.workspaceRoot}})},id=>id);
  bootstrap(store,controlPrincipal,{objective:'mismatch',roles:[{roleId:'mismatch',harnessId:'zcode'}]});await new Promise(r=>setImmediate(r));
  assert.equal(store.db.prepare("SELECT binding_state FROM roles WHERE id='mismatch'").get().binding_state,'unbound');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM role_bindings WHERE role_id='mismatch'").get().n,0);
});

test('bootstrap续行：确定未发送可重试，unknown仅核对原ID且并发重放不重复创建', async t => {
  const {store}=fixture(t);let calls=0;let observed=false;let recoveryCalls=0;
  const factory={ensureBoundSession:async input=>{calls++;if(calls===1)throw new NativeRpcError('UNCONFIGURED','not_sent');throw Error('EXTERNAL_UNKNOWN');},recoverBoundSession:async input=>{recoveryCalls++;return observed?{sessionRef:{harnessId:'zcode',hostId:'synthetic',profileId:'fixture',nativeConversationId:'original-id',nativeWorkspaceId:input.workspaceRoot},nativeSessionId:'original-id',nativeTurnId:'original-turn',charterDelivered:true}:null;}};
  const bootstrap=projectBootstrapOrchestration(store,factory,id=>id);
  const args={objective:'recover',roles:[{roleId:'recover-role'}]};
  const first=bootstrap(store,controlPrincipal,args);await new Promise(r=>setImmediate(r));
  bootstrap(store,controlPrincipal,args);await new Promise(r=>setImmediate(r));assert.equal(calls,2);
  bootstrap(store,controlPrincipal,args);await new Promise(r=>setImmediate(r));assert.equal(calls,2);assert.equal(recoveryCalls,1);
  observed=true;const recovered=bootstrap(store,controlPrincipal,args);bootstrap(store,controlPrincipal,args);
  await new Promise(r=>setImmediate(r));assert.equal(calls,2);assert.equal(recoveryCalls,2);assert.equal(first.payload.operationId,recovered.payload.operationId);
  assert.equal(store.db.prepare("SELECT binding_state FROM roles WHERE id='recover-role'").get().binding_state,'ready');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE native_conversation_id='original-id'").get().n,1);
});

test('同正文不同请求创建两条消息；同键重试只有一条，异载荷冲突不产生副作用', async t => {
  const {store}=fixture(t);
  const factory={ensureBoundSession:async input=>({sessionRef:{harnessId:'zcode',hostId:'synthetic',profileId:'fixture',nativeConversationId:'sess-intents',nativeWorkspaceId:input.workspaceRoot},nativeSessionId:'sess-intents',nativeTurnId:'turn-intents',charterDelivered:true})};
  store.db.prepare("INSERT INTO roles(id,project_id,name,charter,permission_profile,desired_state,binding_state,revision) VALUES('intent-target','p1','目标','章程','x','enabled','unbound',1)").run();
  const send=messageSendOrchestration(store,factory);
  const args={toRoleId:'intent-target',body:'你好',requestId:'one'};
  const first=send(store,controlPrincipal,args); await new Promise(r=>setImmediate(r));
  const retry=send(store,controlPrincipal,args);
  const second=send(store,controlPrincipal,{...args,requestId:'two'});await new Promise(r=>setImmediate(r));
  assert.equal(first.payload.operationId,retry.payload.operationId);
  assert.notEqual(first.payload.operationId,second.payload.operationId);
  const conflict=send(store,controlPrincipal,{...args,body:'不同内容'});
  assert.equal(conflict.ok,false);assert.equal(conflict.payload.error,'IDEMPOTENCY_PAYLOAD_CONFLICT');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE to_role_id='intent-target'").get().n,2);
});

test('生产编排：durable_operations持久化+幂等+步骤记录+跨连接恢复', t => {
  const { store, stores } = fixture(t);
  // 创建操作（幂等键）
  const op1 = createDurableOperation(store, { operationKey: 'test-key-1', kind: 'test', projectId: 'p1', payload: { x: 1 } }, 1000);
  assert.equal(op1.replay, false);
  const op2 = createDurableOperation(store, { operationKey: 'test-key-1', kind: 'test', projectId: 'p1', payload: { x: 1 } }, 1001);
  assert.equal(op2.replay, true, '同幂等键重放');
  assert.equal(op1.operationId, op2.operationId);
  // 步骤记录（持久化——重开连接可读）
  recordStep(store, op1.operationId, { step: 'role:r1:create-session', state: 'sent', detail: null, at: 1002 }, 1002);
  recordStep(store, op1.operationId, { step: 'role:r1:session-unknown', state: 'unknown', detail: 'CLI_TIMEOUT', at: 1003 }, 1003);
  const reopened = openStore(path.join(path.dirname(store.filename), 'state.sqlite')); stores.push(reopened);
  const op = readOperation(reopened, op1.operationId);
  assert.ok(op, '跨连接可查询');
  assert.equal(op.state, 'unknown', 'unknown状态持久');
  assert.equal(op.steps.length, 2);
  // 部分成功恢复：未完成会话角色可识别
  assert.deepEqual(unfinishedRoleSessions(reopened, op1.operationId), ['r1']);
});

test('生产编排：projectBootstrap（生产函数——合成工厂经FactoryAdapter注入）', async t2 => {
  const { store } = fixture(t2);
  const factoryCalls = [];
  const factory = {
    async ensureBoundSession(input) {
      factoryCalls.push(input.roleId);
      if (input.roleId === 'bad') throw new Error('FACTORY_UNKNOWN');
      input.onStep({ step: 'create-session', state: 'observed', detail: `sess_${input.roleId}`, at: Date.now() });
      return { sessionRef:{harnessId:input.harnessId,hostId:"synthetic",profileId:"fixture",nativeConversationId:`sess_${input.roleId}`,nativeWorkspaceId:input.workspaceRoot}, nativeSessionId: `sess_${input.roleId}`, nativeTurnId: `turn_${input.roleId}`,charterDelivered:true };
    },
  };
  const bootstrap = projectBootstrapOrchestration(store, factory, (roleId) => `章程:${roleId}`);
  const result = bootstrap(store, controlPrincipal, { objective: '团队', roles: [{ roleId: 'rev', name: '复核' }, { roleId: 'bad', name: '坏' }, { roleId: 'mgr', name: '管理' }] });
  assert.equal(result.ok, true);
  assert.ok(String(result.payload.operationId).startsWith('op-'));
  // 等异步完成
  await new Promise(r => setTimeout(r, 200));
  const op = readOperation(store, result.payload.operationId);
  assert.ok(op, '操作可查询');
  const steps = op.steps.map(s => `${s.step}:${s.state}`).join(',');
  assert.ok(steps.includes('role:rev:created+bound'), 'rev完成');
  assert.ok(steps.includes('role:bad:session-unknown'), 'bad如实unknown');
  assert.ok(steps.includes('role:mgr:created+bound'), '后续角色不被阻断：'+JSON.stringify(op));
  assert.equal(factoryCalls.length, 3, '工厂恰好每角色一次');
  // 幂等重跑
  const again = bootstrap(store, controlPrincipal, { objective: '团队', roles: [{ roleId: 'rev', name: '复核' }, { roleId: 'bad', name: '坏' }, { roleId: 'mgr', name: '管理' }] });
  assert.ok(again.payload.note.includes('幂等'), '重放提示查询');
  assert.equal(factoryCalls.length, 3, '重跑不再创建会话');
});

test('生产编排：messageSend（目标无绑定→工厂+消息入库；排队≠delivered）+taskDispatch（workflow.evaluate入队）', async t => {
  const { store } = fixture(t);
  const factory = {
    async ensureBoundSession(input) {
      input.onStep({ step: 'create-session', state: 'observed', detail: `sess_${input.roleId}`, at: Date.now() });
      return { sessionRef:{harnessId:input.harnessId,hostId:"synthetic",profileId:"fixture",nativeConversationId:`sess_${input.roleId}`,nativeWorkspaceId:input.workspaceRoot}, nativeSessionId: `sess_${input.roleId}`, nativeTurnId: `charter_${input.roleId}`,charterDelivered:true };
    },
  };
  // 先建目标角色
  store.transaction(db => db.prepare("INSERT INTO roles(id,project_id,name,charter,permission_profile,permission_profile_revision,scope_paths_json,desired_state,binding_state,revision) VALUES('target','p1','目标','章程','x',1,'[]','enabled','unbound',1)").run());
  const send = messageSendOrchestration(store, factory);
  const sent = send(store, controlPrincipal, { toRoleId: 'target', body: '你好' });
  assert.equal(sent.ok, true);
  await new Promise(r => setTimeout(r, 200));
  const msg = store.db.prepare("SELECT state, delivery_json FROM messages WHERE to_role_id='target'").get();
  assert.equal(msg.state, 'stored', '排队≠delivered（stored如实）');
  assert.ok(String(msg.delivery_json).includes('"state":"stored"'), '初始transition=stored（与域sendMessage约定一致）');
  // taskDispatch
  store.transaction(db => db.prepare("INSERT INTO tasks(id,project_id,role_id,goal,state,revision,spec_revision,plan_revision,acceptance_json,inputs_json,outputs_json) VALUES('t1','p1','target','g','draft',1,1,0,'[]','[]','[]')").run());
  const dispatch = taskDispatchOrchestration(store);
  const d = dispatch(store, controlPrincipal, { taskId: 't1' });
  assert.equal(d.ok, true);
  await new Promise(r => setTimeout(r, 100));
  const outbox = store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE json_extract(payload_json,'$.event')='workflow.evaluate' AND json_extract(payload_json,'$.taskId')='t1'").get();
  assert.equal(outbox.n, 1, 'workflow.evaluate入队');
});

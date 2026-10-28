import test from 'node:test';
import assert from 'node:assert/strict';
import {executionFixture} from './execution-fixture.mjs';
import {issueControlEntryToken,authenticateControlEntry} from '../../../apps/kernel/dist/auth/control-entry.js';
import {projectBootstrapOrchestration,messageSendOrchestration,readOperation} from '../../../apps/kernel/dist/tools/orchestration-tools.js';
import {setRoleModelPreference} from '../../../packages/domain/dist/roles/index.js';
import {NativeRpcError} from '../../../apps/kernel/dist/native/stdio-peer.js';
import {unresolvedFactoryCapacity} from '../../../apps/kernel/dist/execution/native-capacity.js';

const settle=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};
const principal=f=>authenticateControlEntry(f.store,issueControlEntryToken(f.store,'p',['project.bootstrap','message.send'],Date.now()-100,60000).token,Date.now());
const outcome=(input)=>({sessionRef:{harnessId:input.harnessId,hostId:'synthetic',profileId:'fixture',nativeConversationId:'new-'+input.roleId,nativeWorkspaceId:input.workspaceRoot},nativeSessionId:'new-'+input.roleId,nativeTurnId:'turn-'+input.roleId,charterDelivered:true});

test('Q2：bootstrap已暂停/禁用/额度不足不调用工厂；正常分步仅一次',async t=>{
 for(const mode of ['normal','pause','disabled','dynamic','cost','expired'])await t.test(mode,async inner=>{
  const f=executionFixture(inner),p=principal(f);let calls=0;
  if(mode==='pause')f.store.db.exec("UPDATE projects SET user_paused=1");
  if(mode==='disabled')f.store.db.exec("UPDATE projects SET policy_json=json_set(policy_json,'$.nativeMode','disabled')");
  if(mode==='dynamic')f.store.db.exec("UPDATE projects SET policy_json=json_set(policy_json,'$.limits.maxDynamicRoles',0)");
  if(mode==='cost')f.store.db.exec("UPDATE projects SET policy_json=json_set(policy_json,'$.limits.costCeiling',1)");
  if(mode==='expired')f.store.db.prepare('UPDATE control_entries SET created_at=?,expires_at=?').run(Date.now()-1000,Date.now()-1);
  const run=projectBootstrapOrchestration(f.store,{ensureBoundSession:async input=>{input.assertCanSend();calls++;return outcome(input);}},x=>x,undefined,()=>f.dir);
  const args={roles:[{roleId:'one',harnessId:'zcode',permissionProfileId:'execution'}],objective:'synthetic'};
  const first=run(f.store,p,args);await settle();run(f.store,p,args);await settle();
  assert.equal(calls,mode==='normal'?1:0);assert.ok(readOperation(f.store,first.payload.operationId));
 });
});

test('Q2：首个工厂在途后暂停/撤权，保存已建同一会话而不再创建后续角色',async t=>{
 for(const change of ['pause','revoke'])await t.test(change,async inner=>{
  const f=executionFixture(inner),p=principal(f),calls=[];
  const run=projectBootstrapOrchestration(f.store,{ensureBoundSession:async input=>{input.assertCanSend();calls.push(input.roleId);await Promise.resolve();if(change==='pause')f.store.db.exec("UPDATE projects SET user_paused=1");else f.store.db.prepare('UPDATE control_entries SET revoked_at=?').run(Date.now());return outcome(input);}},x=>x,undefined,()=>f.dir);
  run(f.store,p,{roles:[{roleId:'one',permissionProfileId:'execution'},{roleId:'two',permissionProfileId:'execution'}],objective:'synthetic'});await settle();assert.deepEqual(calls,['one']);
  assert.equal(f.store.db.prepare("SELECT native_conversation_id FROM sessions WHERE native_conversation_id='new-one'").get().native_conversation_id,'new-one');
 });
});

test('Q2：bootstrap和消息补建的工厂内部异步准备后撤权/暂停，最终guard拒绝输入',async t=>{
 for(const route of ['bootstrap','message'])for(const change of ['pause','revoke'])await t.test(route+change,async inner=>{
  const f=executionFixture(inner),p=principal(f);let inputs=0;
  if(route==='message')f.store.db.exec("INSERT INTO roles(id,project_id,name,charter,permission_profile,desired_state,binding_state,revision) VALUES('one','p','one','one','execution','enabled','unbound',1)");
  const factory={ensureBoundSession:async input=>{await Promise.resolve();if(change==='pause')f.store.db.exec("UPDATE projects SET user_paused=1");else f.store.db.prepare('UPDATE control_entries SET revoked_at=?').run(Date.now());input.assertCanSend();inputs++;return outcome(input);}};
  const run=route==='bootstrap'?projectBootstrapOrchestration(f.store,factory,x=>x,undefined,()=>f.dir):messageSendOrchestration(f.store,factory,undefined,()=>f.dir);
  const r=run(f.store,p,route==='bootstrap'?{roles:[{roleId:'one',permissionProfileId:'execution'}],objective:'synthetic'}:{toRoleId:'one',body:'hello',requestId:'one'});await settle();
  assert.equal(inputs,0);assert.ok(readOperation(f.store,r.payload.operationId).steps.some(s=>s.step.endsWith('session-not-sent')));
 });
});

test('同一次建组内的unknown工厂保留并发占位，不因同operation而放行后续角色',async t=>{
 const f=executionFixture(t),p=principal(f),calls=[];f.store.db.exec("UPDATE projects SET policy_json=json_set(policy_json,'$.limits.totalConcurrency',1)");
 const run=projectBootstrapOrchestration(f.store,{ensureBoundSession:async input=>{input.assertCanSend();calls.push(input.roleId);throw Error('SYNTHETIC_RESULT_UNKNOWN');}},x=>x,undefined,()=>f.dir);
 run(f.store,p,{objective:'unknown factory',roles:[{roleId:'one',permissionProfileId:'execution'},{roleId:'two',permissionProfileId:'execution'}]});await settle();assert.deepEqual(calls,['one']);
});

test('工厂异步准备期间模型配置独立变更，职责版本相同也不外发旧配置输入',async t=>{
 const f=executionFixture(t),p=principal(f);let inputs=0;
 const run=projectBootstrapOrchestration(f.store,{ensureBoundSession:async input=>{const revision=f.store.db.prepare('SELECT revision FROM roles WHERE id=?').get(input.roleId).revision;await Promise.resolve();setRoleModelPreference(f.store,'p',input.roleId,{raw:'new strict config',recordedAt:Date.now()},null);assert.equal(f.store.db.prepare('SELECT revision FROM roles WHERE id=?').get(input.roleId).revision,revision);input.assertCanSend();inputs++;return outcome(input);}},x=>x,undefined,()=>f.dir);
 run(f.store,p,{objective:'model version',roles:[{roleId:'model-one',permissionProfileId:'execution'}]});await settle();assert.equal(inputs,0);
});

test('共享bootstrap/message工厂：创建已观察后的章程not_sent保留原ID和占位，重放不再建',async t=>{
 for(const route of ['bootstrap','message'])await t.test(route,async inner=>{
  const f=executionFixture(inner),p=principal(f);let creations=0;
  if(route==='message')f.store.db.exec("INSERT INTO roles(id,project_id,name,charter,permission_profile,desired_state,binding_state,revision) VALUES('one','p','one','one','execution','enabled','unbound',1)");
  const factory={async ensureBoundSession(input){input.assertCanSend();creations++;input.onStep({step:'create-thread',state:'observed',detail:'original-created-thread',at:Date.now()});throw new NativeRpcError('CHARTER_NOT_SENT','not_sent');},async recoverBoundSession(){return null;}};
  const run=route==='bootstrap'?projectBootstrapOrchestration(f.store,factory,x=>x,undefined,()=>f.dir):messageSendOrchestration(f.store,factory,undefined,()=>f.dir);
  const args=route==='bootstrap'?{roles:[{roleId:'one',permissionProfileId:'execution'}],objective:'created first'}:{toRoleId:'one',body:'hello',requestId:'original-message'};
  const first=run(f.store,p,args);await settle();const op=readOperation(f.store,first.payload.operationId);
  assert.equal(op.steps.some(s=>s.step.endsWith('session-not-sent')),false);assert.ok(op.steps.some(s=>s.detail==='original-created-thread'));
  assert.equal(unresolvedFactoryCapacity(f.store.db,'p','one').role,1);run(f.store,p,args);await settle();assert.equal(creations,1);
 });
});

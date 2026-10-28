import test from 'node:test';
import assert from 'node:assert/strict';
import {executionFixture} from './execution-fixture.mjs';
import {installSyntheticPolicy} from './synthetic-policy.mjs';
import {createToolDispatcher} from '../../../apps/kernel/dist/tools/gateway-tools.js';
import {pumpRoleProvisioning,settleRoleProvisioning} from '../../../apps/kernel/dist/tools/role-provisioning.js';
import {readOperation,createDurableOperation,recordStep} from '../../../apps/kernel/dist/tools/orchestration-tools.js';
import {NativeRpcError} from '../../../apps/kernel/dist/native/stdio-peer.js';
import {unresolvedFactoryCapacity} from '../../../apps/kernel/dist/execution/native-capacity.js';
import {openStore} from '../../../packages/persistence/dist/index.js';
import {startApplication} from '../../../apps/kernel/dist/lifecycle/application.js';
import {fork} from 'node:child_process';
import {once} from 'node:events';

function fixture(t){
 const f=executionFixture(t);let clock=Date.now(),calls=0,sends=0,recoveries=0,injects=0,behavior,observedHarness;
 f.store.db.prepare('UPDATE agent_credentials SET expires_at=?').run(clock+600000);
 const manager={id:'execution',revision:1,actions:['identity','change.apply','role.create','role.bind','role.read','task.read'],readPaths:['roles/*','tasks/*'],writePaths:['roles/*','tasks/*'],roleIds:[],delegableActions:['identity','task.read'],maxDelegationDepth:1},child={id:'child',revision:1,actions:['identity','task.read'],readPaths:['tasks/*'],writePaths:[],roleIds:[],delegableActions:[],maxDelegationDepth:0};installSyntheticPolicy(f.store,'p',[manager,child]);
 const call=(tool,args)=>createToolDispatcher(f.store,{now:()=>clock,callerNativeConversationId:f.session.nativeConversationId})(f.principal,tool,args);
 const created=call('management.apply_changes',{requestId:'create-member',expectedPlanRevision:0,reason:'合成管理入口',operations:[{type:'role.create',localRef:'member',name:'成员',charter:'继承既定职责',parentRoleId:'worker',permissionProfileId:'child',permissionProfileRevision:1,scopePaths:['tasks/*']}]});assert.equal(created.ok,true,JSON.stringify(created));assert.equal(created.payload.status,'completed');
 const result={sessionRef:{harnessId:'codex',hostId:'h',profileId:'synthetic',nativeConversationId:'native-new',nativeWorkspaceId:f.driver.workspaceRoot},nativeSessionId:'native-new',nativeTurnId:'charter-turn',charterDelivered:true};
 const factory={async ensureBoundSession(input){calls++;observedHarness=input.harnessId;await behavior?.(input);input.assertCanSend();sends++;input.onStep({step:'session-identity',state:'observed',detail:JSON.stringify(result.sessionRef),at:clock});return result;},async recoverBoundSession(){recoveries++;return result;}};
 const services={now:()=>clock,isOwner:()=>true,workspaceForRole:()=>f.driver.workspaceRoot,principalForBinding:()=>f.principal,onBoundSession:()=>{injects++;}};
 const args={requestId:'provision',roleId:'member',expectedRevision:1,harnessId:'codex'};
 return Object.assign(f,{call,args,factory,services,result,pump:async()=>{pumpRoleProvisioning(f.store,factory,services);await settleRoleProvisioning(f.store);},advance:()=>{clock+=31000;},setBehavior:value=>{behavior=value;},stats:()=>({calls,sends,recoveries,injects,observedHarness})});
}

test('管理变更创建的子角色经显式Harness工厂→原生绑定/章程/工具及握手，重复命令不再建',async t=>{
 const f=fixture(t),queued=f.call('role.provision',f.args);assert.equal(queued.ok,true,JSON.stringify(queued));assert.equal(queued.payload.bindingState,'unbound');assert.equal(f.stats().calls,0);
 await f.pump();assert.deepEqual(f.stats(),{calls:1,sends:1,recoveries:0,injects:1,observedHarness:'codex'});assert.equal(readOperation(f.store,queued.payload.operationId).state,'observed');
 assert.equal(f.store.db.prepare("SELECT binding_state FROM roles WHERE id='member'").get().binding_state,'ready');assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM role_bindings WHERE role_id=?').get('member').n,1);
 const replay=f.call('role.provision',f.args);assert.equal(replay.ok,true);assert.equal(replay.payload.operationId,queued.payload.operationId);await f.pump();assert.equal(f.stats().calls,1);
});

test('排队/发送前暂停和撤权阻止模型输入，不把unbound标为ready',async t=>{
 for(const mode of ['pause','revoke','disable','policy'])await t.test(mode,async inner=>{
  const f=fixture(inner);assert.equal(f.call('role.provision',f.args).ok,true);
  f.setBehavior(input=>{if(mode==='pause')f.store.db.exec('UPDATE projects SET user_paused=1');if(mode==='revoke')f.store.db.prepare('UPDATE agent_credentials SET revoked_at=? WHERE id=?').run(Date.now(),f.principal.credentialId);if(mode==='disable')f.store.db.exec("UPDATE roles SET desired_state='disabled' WHERE id='worker'");if(mode==='policy')f.store.db.exec('UPDATE projects SET policy_revision=policy_revision+1');input.assertCanSend();});
  await f.pump();assert.equal(f.stats().sends,0);assert.equal(f.store.db.prepare("SELECT binding_state FROM roles WHERE id='member'").get().binding_state,'unbound');assert.equal(unresolvedFactoryCapacity(f.store.db,'p','member').role,0,'可信未发送失败才能释放占位');
 });
});

test('外部创建后暂停保留unknown和容量，恢复只核对同原生ID，不再工厂创建',async t=>{
 const f=fixture(t),queued=f.call('role.provision',f.args);f.setBehavior(input=>{input.onStep({step:'session-identity',state:'observed',detail:JSON.stringify(f.result.sessionRef),at:Date.now()});});
 const original=f.factory.ensureBoundSession;f.factory.ensureBoundSession=async input=>{const result=await original(input);f.store.db.exec('UPDATE projects SET user_paused=1');return result;};
 await f.pump();assert.equal(readOperation(f.store,queued.payload.operationId).state,'unknown');assert.equal(unresolvedFactoryCapacity(f.store.db,'p','member').role,1);assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM role_bindings WHERE role_id='member'").get().n,0);
 f.store.db.exec('UPDATE projects SET user_paused=0');f.advance();await f.pump();assert.equal(f.stats().calls,1);assert.equal(f.stats().recoveries,1);assert.equal(f.store.db.prepare("SELECT native_conversation_id FROM sessions WHERE native_conversation_id='native-new'").get().native_conversation_id,'native-new');
});

test('创建响应已观察后stop/pause/revoke阻止章程，not_sent只限后阶段，不释放原创建占位',async t=>{
 for(const mode of ['stop','pause','revoke'])await t.test(mode,async inner=>{
  const f=fixture(inner),queued=f.call('role.provision',f.args);
  f.setBehavior(input=>{
   input.onStep({step:'create-thread',state:'observed',detail:f.result.nativeSessionId,at:Date.now()});
   if(mode==='stop')throw new NativeRpcError('KERNEL_STOPPING','not_sent');
   if(mode==='pause')f.store.db.exec('UPDATE projects SET user_paused=1');
   if(mode==='revoke')f.store.db.prepare('UPDATE agent_credentials SET revoked_at=? WHERE id=?').run(Date.now(),f.principal.credentialId);
   input.assertCanSend();
  });
  await f.pump();const op=readOperation(f.store,queued.payload.operationId);
  assert.equal(op.state,'unknown');assert.equal(op.steps.some(s=>s.step.endsWith(':session-not-sent')),false);
  assert.ok(op.steps.some(s=>s.step==='role:member:create-thread'&&s.detail==='native-new'));
  assert.equal(unresolvedFactoryCapacity(f.store.db,'p','member').role,1);assert.equal(f.stats().calls,1);assert.equal(f.stats().sends,0);
  f.factory.recoverBoundSession=async()=>null;f.advance();await f.pump();assert.equal(f.stats().calls,1);
 });
});

test('工厂未知不盲目再建，重复指令不绕过未知占位',async t=>{
 const f=fixture(t),queued=f.call('role.provision',f.args);f.factory.ensureBoundSession=async input=>{input.assertCanSend();throw new NativeRpcError('SYNTHETIC_UNCERTAIN','uncertain');};f.factory.recoverBoundSession=async()=>null;
 await f.pump();assert.equal(readOperation(f.store,queued.payload.operationId).state,'unknown');assert.equal(unresolvedFactoryCapacity(f.store.db,'p','member').role,1);
 const second=f.call('role.provision',{...f.args,requestId:'do-not-duplicate'});assert.equal(second.ok,false);assert.equal(second.payload.error,'PROVISION_ALREADY_PENDING');
 f.advance();await f.pump();assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM role_bindings WHERE role_id='member'").get().n,0);
});

test('登记后工具注入失败，重启只恢复同绑定并完成握手，不再次创建会话',async t=>{
 const f=fixture(t),queued=f.call('role.provision',f.args);
 f.services.onBoundSession=()=>{throw Error('SYNTHETIC_INJECTION_FAILURE');};
 await f.pump();assert.equal(readOperation(f.store,queued.payload.operationId).state,'unknown');
 const original=f.store.db.prepare("SELECT id,session_id FROM role_bindings WHERE role_id='member'").get();assert.ok(original);
 assert.equal(f.store.db.prepare("SELECT binding_state FROM roles WHERE id='member'").get().binding_state,'provisioning');
 f.store.close();const reopened=openStore(f.filename);f.stores.push(reopened);let injectedBinding;
 const services={...f.services,onBoundSession:binding=>{injectedBinding=binding;}};
 pumpRoleProvisioning(reopened,f.factory,services);await settleRoleProvisioning(reopened);
 assert.equal(injectedBinding,original.id);assert.equal(readOperation(reopened,queued.payload.operationId).state,'observed');
 assert.equal(f.stats().calls,1);assert.equal(f.stats().sends,1);
 assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM role_bindings WHERE role_id='member'").get().n,1);
 assert.equal(reopened.db.prepare("SELECT binding_state FROM roles WHERE id='member'").get().binding_state,'ready');
});

test('工厂创建已观察但章程未确认时保留原绑定，重试不能猜填ready',async t=>{
 const f=fixture(t),queued=f.call('role.provision',f.args);f.result.charterDelivered=false;
 await f.pump();f.advance();await f.pump();
 assert.equal(readOperation(f.store,queued.payload.operationId).state,'unknown');assert.equal(f.stats().calls,1);assert.equal(f.stats().injects,0);
 assert.equal(unresolvedFactoryCapacity(f.store.db,'p','member').role,1,'仅登记provisioning但章程未知时仍保留原生占位');
 assert.equal(f.store.db.prepare("SELECT binding_state FROM roles WHERE id='member'").get().binding_state,'provisioning');
 assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM role_bindings WHERE role_id='member'").get().n,1);
});

test('只读恢复的已发生效果可在原输入时间预算后结算，但不能再发输入或豁免暂停',async t=>{
 const f=fixture(t),queued=f.call('role.provision',f.args);f.factory.ensureBoundSession=async input=>{input.assertCanSend();input.onStep({step:'create-thread',state:'observed',detail:'native-new',at:Date.now()});throw new NativeRpcError('LOST_CHARTER_RECEIPT','uncertain');};
 await f.pump();const originalNow=Date.now,advanced=originalNow()+1000000;t.after(()=>{Date.now=originalNow;});Date.now=()=>advanced;
 f.store.db.exec('UPDATE projects SET user_paused=1');f.advance();await f.pump();assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM role_bindings WHERE role_id='member'").get().n,0);
 f.store.db.exec('UPDATE projects SET user_paused=0');f.advance();await f.pump();
 assert.equal(readOperation(f.store,queued.payload.operationId).state,'observed');assert.equal(f.stats().sends,0);assert.equal(f.stats().recoveries,1);
});

test('容量不足且未外发时保持pending；容量释放后自动继续，不制造unknown或多建',async t=>{
 const f=fixture(t);f.store.db.exec("UPDATE projects SET policy_json=json_set(policy_json,'$.limits.totalConcurrency',1)");
 const busy=createDurableOperation(f.store,{operationKey:'other-occupancy',kind:'synthetic-test',projectId:'p',payload:{}},Date.now());
 recordStep(f.store,busy.operationId,{step:'role:other:factory-call',state:'sent',detail:null,at:Date.now()},Date.now());
 const queued=f.call('role.provision',f.args);await f.pump();
 assert.equal(f.stats().calls,0);assert.equal(readOperation(f.store,queued.payload.operationId).state,'pending');assert.equal(unresolvedFactoryCapacity(f.store.db,'p','member').role,0);
 recordStep(f.store,busy.operationId,{step:'role:other:session-not-sent',state:'failed',detail:'SYNTHETIC_CONFIRMED_NOT_SENT',at:Date.now()},Date.now());
 f.advance();await f.pump();assert.equal(f.stats().calls,1);assert.equal(readOperation(f.store,queued.payload.operationId).state,'observed');
});

test('标准应用优雅退出等待已入工厂的迟到观察落盘，再关闭存储；不丢原绑定',async t=>{
 const f=fixture(t),queued=f.call('role.provision',f.args);f.store.close();
 const runtime=await startApplication(f.dir);let release,entered;const ready=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
 t.after(async()=>{release();await runtime.stop();});
 f.setBehavior(async input=>{input.onStep({step:'session-identity',state:'observed',detail:JSON.stringify(f.result.sessionRef),at:Date.now()});entered();await gate;});
 pumpRoleProvisioning(runtime.store,f.factory,{...f.services,isOwner:()=>runtime.isOwner()});await ready;
 let stopped=false;const closing=runtime.stop().then(()=>{stopped=true;});await new Promise(r=>setImmediate(r));
 try{assert.equal(stopped,false);assert.equal(runtime.store.db.isOpen,true);}finally{release();await closing;}
 const reopened=openStore(f.filename);f.stores.push(reopened);
 assert.equal(readOperation(reopened,queued.payload.operationId).state,'observed');assert.equal(f.stats().calls,1);
 assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM role_bindings WHERE role_id='member'").get().n,1);
});

test('无回执时停机在观察期限内返回并保留unknown；重启后旧回调不得落库或重建',async t=>{
 const f=fixture(t),queued=f.call('role.provision',f.args);f.store.close();
 const runtime=await startApplication(f.dir,{shutdownDrainMs:40});let release,entered;const ready=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
 f.setBehavior(async input=>{entered();await gate;input.onStep({step:'create-thread',state:'observed',detail:'late-original-thread',at:Date.now()});});
 pumpRoleProvisioning(runtime.store,f.factory,{...f.services,isOwner:()=>runtime.isOwner()});await ready;
 const start=performance.now();await runtime.stop();assert.ok(performance.now()-start<1500,'停机不无限等模型');
 const next=await startApplication(f.dir,{shutdownDrainMs:40});
 try{
  const before=readOperation(next.store,queued.payload.operationId);assert.equal(before.state,'unknown');assert.ok(before.steps.some(s=>s.step.endsWith(':observation-detached')));assert.equal(unresolvedFactoryCapacity(next.store.db,'p','member').role,1);
  release();await settleRoleProvisioning(runtime.store);
  const after=readOperation(next.store,queued.payload.operationId);assert.deepEqual(after.steps,before.steps);assert.equal(f.stats().calls,1);assert.equal(f.stats().sends,0);
  assert.equal(next.store.db.prepare("SELECT COUNT(*) AS n FROM role_bindings WHERE role_id='member'").get().n,0);
 }finally{release();await next.stop();}
});

test('创建响应落盘前后硬崩溃：重启只读核对原操作，有ID保留、无ID不猜，不再创建',async t=>{
 for(const boundary of ['before-id','after-id'])await t.test(boundary,async inner=>{
  const f=fixture(inner),queued=f.call('role.provision',f.args);f.store.close();
  const child=fork(new URL('./fixtures/provision-crash-worker.mjs',import.meta.url),[f.filename,f.driver.workspaceRoot,boundary],{execPath:process.execPath,stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});const exited=once(child,'exit');
  inner.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  let timer;try{await Promise.race([once(child,'message'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('CHILD_BOUNDARY_NOT_REACHED:'+stderr.slice(0,200))),5000);})]);}finally{clearTimeout(timer);}
  child.kill('SIGKILL');await exited;
  const reopened=openStore(f.filename);f.stores.push(reopened);let created=0,recovered=0;
  const factory={ensureBoundSession:async()=>{created++;throw Error('MUST_NOT_RECREATE');},recoverBoundSession:async input=>{recovered++;assert.equal(input.steps.some(s=>s.detail==='original-created-id'),boundary==='after-id');return null;}};
  pumpRoleProvisioning(reopened,factory,f.services);await settleRoleProvisioning(reopened);
  assert.equal(created,0);assert.equal(recovered,1);assert.equal(readOperation(reopened,queued.payload.operationId).state,'unknown');assert.equal(unresolvedFactoryCapacity(reopened.db,'p','member').role,1);
 });
});

test('非子角色/非法Harness/越权/重复及审计失败不创建操作，费用上限不可执行时阻断',async t=>{
 const f=fixture(t);assert.equal(f.call('role.provision',{...f.args,roleId:'worker'}).ok,false);assert.equal(f.call('role.provision',{...f.args,harnessId:'forged'}).ok,false);
 f.store.db.exec("CREATE TRIGGER fail_provision_audit BEFORE INSERT ON events WHEN NEW.type='role.provision.queued' BEGIN SELECT RAISE(ABORT,'TEST_AUDIT_FAILURE'); END");assert.equal(f.call('role.provision',f.args).ok,false);assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM durable_operations WHERE kind='role.provision'").get().n,0);f.store.db.exec('DROP TRIGGER fail_provision_audit');
 f.store.db.exec("UPDATE projects SET policy_json=json_set(policy_json,'$.limits.costCeiling',10)");const queued=f.call('role.provision',f.args);assert.equal(queued.ok,true);await f.pump();assert.equal(f.stats().sends,0);assert.equal(readOperation(f.store,queued.payload.operationId).state,'failed');
});

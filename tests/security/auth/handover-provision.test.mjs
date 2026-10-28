// 固定MCP命令/真实文件/持久事务/受控工厂；不是原生会话验收。
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {executionFixture} from './execution-fixture.mjs';import {installSyntheticPolicy} from './synthetic-policy.mjs';
import {createToolDispatcher} from '../../../apps/kernel/dist/tools/gateway-tools.js';
import {issueAgentCredential,authenticateAgentCredential} from '../../../apps/kernel/dist/auth/agent-credential.js';
import {pumpRoleProvisioning,settleRoleProvisioning} from '../../../apps/kernel/dist/tools/role-provisioning.js';
import {readOperation} from '../../../apps/kernel/dist/tools/orchestration-tools.js';import {unresolvedFactoryCapacity} from '../../../apps/kernel/dist/execution/native-capacity.js';
import {openStore} from '../../../packages/persistence/dist/index.js';
import {startMcpHttpHost} from '../../../apps/kernel/dist/tools/mcp-http-host.js';
import {buildRoleToolBackend} from '../../../apps/kernel/dist/tools/role-tool-backend.js';
import {messageSendOrchestration,settleFactoryOrchestrations} from '../../../apps/kernel/dist/tools/orchestration-tools.js';

async function fixture(t){
 const f=executionFixture(t);let clock=Date.now(),calls=0,observations=0,behavior,lastOutcome,busy=false,injectFailure=false;
 f.store.db.prepare('UPDATE agent_credentials SET expires_at=?').run(clock+600000);
 const childActions=['identity','role.read','task.read','artifact.read','artifact.register_own','handover.prepare','handover.read'],scope=['roles/*','tasks/*','handovers/*','workspace/*'];
 const manager={id:'execution',revision:1,actions:[...childActions,'change.apply','role.create','role.bind','task.create','task.assign','handover.verify','workspace.read'],readPaths:scope,writePaths:scope,roleIds:[],delegableActions:childActions,maxDelegationDepth:1},child={id:'child',revision:1,actions:childActions,readPaths:scope,writePaths:scope,roleIds:[],delegableActions:[],maxDelegationDepth:0};installSyntheticPolicy(f.store,'p',[manager,child]);
 const as=(principal,tool,args)=>createToolDispatcher(f.store,{now:()=>clock,callerNativeConversationId:principal.session.nativeConversationId})(principal,tool,args),call=(tool,args)=>as(f.principal,tool,args);
 const spec={goal:'未完成开发事项，交接不伪造验收',inputArtifacts:[],outputRequirements:[{name:'report',kind:'report',description:'报告'}],acceptance:[{ruleId:'user',mode:'user',description:'用户验收'}],dependencies:[]};
 const created=call('management.apply_changes',{requestId:'create-child',expectedPlanRevision:0,reason:'合成接替测试',operations:[{type:'role.create',localRef:'member',name:'执行者',charter:'按持久事实继续，不自验收',scopePaths:scope,parentRoleId:'worker',permissionProfileId:'child',permissionProfileRevision:1},{type:'task.create',localRef:'member-task',assigneeLocalRef:'member',spec}]});assert.equal(created.ok,true,JSON.stringify(created));
 const factory={async ensureBoundSession(input){input.assertCanSend();calls++;const id=calls===1?'native-original':'native-replacement';lastOutcome={sessionRef:{harnessId:input.harnessId,hostId:'synthetic',profileId:'handover',nativeConversationId:id,nativeWorkspaceId:f.driver.workspaceRoot},nativeSessionId:id,nativeTurnId:'charter-'+calls,charterDelivered:true};input.onStep({step:'session-identity',state:'observed',detail:JSON.stringify(lastOutcome.sessionRef),at:clock});await behavior?.(input,lastOutcome);return lastOutcome;},async recoverBoundSession(){return lastOutcome;},async observeBoundSession(session){observations++;assert.equal(session.nativeConversationId,'native-original');return !busy;}};
 const services={now:()=>clock,isOwner:()=>true,workspaceForRole:()=>f.driver.workspaceRoot,principalForBinding:()=>f.principal,onBoundSession:()=>{if(injectFailure)throw Error('SYNTHETIC_INJECTION_FAILURE');}};
 const pump=async()=>{pumpRoleProvisioning(f.store,factory,services);await settleRoleProvisioning(f.store);};
 assert.equal(call('role.provision',{requestId:'first-binding',roleId:'member',expectedRevision:1,harnessId:'codex'}).ok,true);await pump();
 const oldBinding=f.store.db.prepare("SELECT id,epoch FROM role_bindings WHERE role_id='member' AND ended_at IS NULL").get();assert.ok(oldBinding);
 const oldToken=issueAgentCredential(f.store,String(oldBinding.id),1,{isolation:'verified_session',session:lastOutcome.sessionRef},clock,600000).credential,oldPrincipal=authenticateAgentCredential(f.store,oldToken,clock);
 const file=(principal,id,text,taskId)=>{const location=path.join(f.driver.workspaceRoot,id+'.json'),bytes=Buffer.from(typeof text==='string'?text:JSON.stringify(text));fs.writeFileSync(location,bytes);const response=as(principal,'artifact.register',{requestId:'artifact-'+id,taskId,taskRevision:1,kind:'report',path:'workspace/'+id+'.json',sha256:createHash('sha256').update(bytes).digest('hex'),byteSize:bytes.length});assert.equal(response.ok,true,JSON.stringify(response));return{artifactId:response.payload.artifactId,version:response.payload.version};};
 const context=file(oldPrincipal,'context',{projectId:'p',roleId:'member',fromBindingEpoch:1,notes:'保留未整合修改和争议；首业务轮核对持久资料'},'member-task'),evidence=file(f.principal,'review','独立读取实际上下文并核对水位','task');
 const prepareArgs={requestId:'prepare-handover',roleId:'member',expectedBindingEpoch:1,artifact:context,taskSpecRevisions:[{taskId:'member-task',specRevision:1}],workspaceVersions:[],unresolvedIssueIds:[],pendingEffects:[],verifierRoleId:'worker'};
 const prepared=as(oldPrincipal,'handover.prepare',prepareArgs);assert.equal(prepared.ok,true,JSON.stringify(prepared));const handoverId=prepared.payload.entity.id;
 const verified=call('handover.verify',{requestId:'verify-handover',handoverId,expectedRevision:1,decision:'verified',evidence:[evidence]});assert.equal(verified.ok,true,JSON.stringify(verified));
 const args={requestId:'replace',roleId:'member',expectedRevision:Number(f.store.db.prepare("SELECT revision FROM roles WHERE id='member'").get().revision),harnessId:'zcode',handoverId};
 return Object.assign(f,{as,call,pump,factory,services,args,context,evidence,prepareArgs,oldBinding,oldToken,oldPrincipal,handoverId,stats:()=>({calls,observations}),advance:()=>{clock+=31000;},now:()=>clock,setBehavior:fn=>{behavior=fn;},setBusy:value=>{busy=value;},setInjectionFailure:value=>{injectFailure=value;},outcome:()=>lastOutcome});
}

test('明确交接消费与新绑定原子提交，旧凭据撤销，当前角色能发现持久上下文；幂等/重启不再建',async t=>{
 const f=await fixture(t),queued=f.call('role.provision',f.args);assert.equal(queued.ok,true,JSON.stringify(queued));let charter;
 f.setBehavior(input=>{charter=input.charter;});await f.pump();assert.equal(readOperation(f.store,queued.payload.operationId).state,'observed',JSON.stringify(readOperation(f.store,queued.payload.operationId)));
 const binding=f.store.db.prepare("SELECT * FROM role_bindings WHERE role_id='member' AND ended_at IS NULL").get();assert.equal(binding.epoch,2);assert.notEqual(binding.id,f.oldBinding.id);assert.equal(f.stats().calls,2);assert.equal(f.stats().observations,2);assert.match(charter,new RegExp(f.handoverId));assert.ok(charter.includes(f.context.artifactId));
 assert.equal(f.store.db.prepare('SELECT state FROM handovers WHERE id=?').get(f.handoverId).state,'consumed');assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM handover_consumptions').get().n,1);assert.throws(()=>authenticateAgentCredential(f.store,f.oldToken,f.now()));
 const token=issueAgentCredential(f.store,String(binding.id),2,{isolation:'verified_session',session:f.outcome().sessionRef},f.now(),600000).credential,p=authenticateAgentCredential(f.store,token,f.now());
 assert.equal(f.as(p,'role.read',{roleId:'member'}).payload.contextHandover.handoverId,f.handoverId);assert.equal(f.as(p,'handover.read',{handoverId:f.handoverId}).payload.state,'consumed');assert.equal(f.store.db.prepare("SELECT state FROM tasks WHERE id='member-task'").get().state,'draft','接替本身不代验收或重写业务状态');
 assert.equal(f.call('role.provision',f.args).payload.operationId,queued.payload.operationId);assert.equal(f.call('role.provision',{...f.args,requestId:'consume-twice',expectedRevision:Number(f.store.db.prepare("SELECT revision FROM roles WHERE id='member'").get().revision)}).ok,false);assert.equal(f.stats().calls,2);
 assert.throws(()=>f.store.db.exec("UPDATE handover_consumptions SET consumed_at=consumed_at+1"),/IMMUTABLE/);
 f.store.close();const next=openStore(f.filename);f.stores.push(next);assert.equal(next.db.prepare('SELECT new_binding_epoch FROM handover_consumptions').get().new_binding_epoch,2);assert.equal(next.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
});

test('快照过期、未决效果和无旧原生空闲证明都拒绝接替，不换绑、不发创建',async t=>{
 for(const mode of ['plan','artifact','unknown','native-busy'])await t.test(mode,async inner=>{
  const f=await fixture(inner);
  if(mode==='plan')f.store.db.exec('UPDATE projects SET plan_revision=plan_revision+1');
  if(mode==='artifact')fs.writeFileSync(path.join(f.driver.workspaceRoot,'context.json'),'tampered');
  if(mode==='unknown')f.store.db.exec("INSERT INTO durable_operations(id,operation_key,kind,project_id,payload_json,state,steps_json,created_at,updated_at) VALUES('foreign-unknown','foreign','synthetic','p','{}','unknown','[]',1,1)");
  if(mode==='native-busy')f.setBusy(true);
  const queued=f.call('role.provision',f.args);if(mode==='native-busy'){assert.equal(queued.ok,true);await f.pump();assert.equal(readOperation(f.store,queued.payload.operationId).state,'failed');}else assert.equal(queued.ok,false);
  assert.equal(f.stats().calls,1);assert.equal(f.store.db.prepare("SELECT epoch FROM role_bindings WHERE role_id='member' AND ended_at IS NULL").get().epoch,1);assert.equal(f.store.db.prepare('SELECT state FROM handovers WHERE id=?').get(f.handoverId).state,'verified');
 });
});

test('创建后漂移或旧会话重新忙碌保留原绑定和新未知效果，不消费或重建',async t=>{
 for(const mode of ['artifact','native-busy','pause','unknown-receipt'])await t.test(mode,async inner=>{
  const f=await fixture(inner),queued=f.call('role.provision',f.args);
  f.setBehavior(()=>{if(mode==='artifact')fs.writeFileSync(path.join(f.driver.workspaceRoot,'context.json'),'changed');if(mode==='native-busy')f.setBusy(true);if(mode==='pause')f.store.db.exec('UPDATE projects SET user_paused=1');if(mode==='unknown-receipt')throw Error('SYNTHETIC_LOST_RECEIPT');});
  await f.pump();assert.equal(readOperation(f.store,queued.payload.operationId).state,'unknown');assert.equal(unresolvedFactoryCapacity(f.store.db,'p','member').role,1);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM handover_consumptions').get().n,0);assert.equal(f.store.db.prepare("SELECT epoch FROM role_bindings WHERE role_id='member' AND ended_at IS NULL").get().epoch,1);assert.doesNotThrow(()=>authenticateAgentCredential(f.store,f.oldToken,f.now()));
  if(mode==='unknown-receipt'){f.advance();await f.pump();assert.equal(readOperation(f.store,queued.payload.operationId).state,'observed',JSON.stringify(readOperation(f.store,queued.payload.operationId)));assert.equal(f.stats().calls,2);}
 });
});

test('审计失败整册回滚交接/绑定/撤销；原已观察新会话可恢复，工具注入失败不再建',async t=>{
 for(const mode of ['audit','inject'])await t.test(mode,async inner=>{
  const f=await fixture(inner),queued=f.call('role.provision',f.args);
  if(mode==='audit')f.store.db.exec("CREATE TRIGGER fail_rebind_audit BEFORE INSERT ON events WHEN NEW.type='role.provision.bound' AND json_extract(NEW.body_json,'$.handoverId') IS NOT NULL BEGIN SELECT RAISE(ABORT,'TEST_REBIND_AUDIT_FAILURE'); END");else f.setInjectionFailure(true);
  await f.pump();assert.equal(readOperation(f.store,queued.payload.operationId).state,'unknown');
  if(mode==='audit'){assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM handover_consumptions').get().n,0);assert.equal(f.store.db.prepare('SELECT state FROM handovers WHERE id=?').get(f.handoverId).state,'verified');assert.doesNotThrow(()=>authenticateAgentCredential(f.store,f.oldToken,f.now()));f.store.db.exec('DROP TRIGGER fail_rebind_audit');}
  else{assert.equal(f.store.db.prepare("SELECT binding_state FROM roles WHERE id='member'").get().binding_state,'provisioning');assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM handover_consumptions').get().n,1);f.setInjectionFailure(false);}
  f.advance();await f.pump();assert.equal(readOperation(f.store,queued.payload.operationId).state,'observed',JSON.stringify(readOperation(f.store,queued.payload.operationId)));assert.equal(f.stats().calls,2);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM handover_consumptions').get().n,1);
 });
});

test('真实HTTP并发交接请求只有一个创建；已打开旧SID在原子接替后失效',async t=>{
 const f=await fixture(t),token=issueAgentCredential(f.store,'binding',1,{isolation:'verified_session',session:f.session},f.now(),600000).credential;
 const host=await startMcpHttpHost({backendForConnection:()=>({list:()=>[],call:()=>({ok:false,payload:{}}),closed:()=>{}}),resolveBearer:value=>buildRoleToolBackend(f.store,value)});let id=0;
 const connect=async credential=>{let sid;const rpc=async(method,params)=>{const r=await fetch(host.url,{method:'POST',headers:{Authorization:'Bearer '+credential,'Content-Type':'application/json',...(sid?{'Mcp-Session-Id':sid}:{})},body:JSON.stringify({jsonrpc:'2.0',...(method.startsWith('notifications/')?{}:{id:++id}),method,params})});sid??=r.headers.get('mcp-session-id');return{status:r.status,value:r.status===202?null:await r.json()};};await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'handover-synthetic-http',version:'1'}});await rpc('notifications/initialized',{});return rpc;};
 try{
  const old=await connect(f.oldToken),parent=await connect(token),identity={name:'projectorch_identity',arguments:{}};
  assert.equal((await old('tools/call',identity)).value.result.isError,false);
  const invoke=requestId=>parent('tools/call',{name:'projectorch_role_provision',arguments:{...f.args,requestId}});
  const results=await Promise.all([invoke('http-a'),invoke('http-a'),invoke('http-b')]);
  assert.equal(results.filter(r=>r.value.result.isError===false).length,2,'同幂等键重放成功，另一个消费请求被拒');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM durable_operations WHERE json_extract(payload_json,'$.handoverId')=?").get(f.handoverId).n,1);
  await f.pump();assert.equal(f.stats().calls,2);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM handover_consumptions').get().n,1);
  assert.equal((await old('tools/call',identity)).status,404,'缓存SID不能保留旧代身份');
 }finally{await host.close();}
});

test('消息入队意图完成不等于送达；stored消息仍阻断已verified交接',async t=>{
 const f=await fixture(t),now=Date.now();f.store.db.prepare("INSERT INTO control_entries(token_hash,project_id,permissions_json,created_at,expires_at) VALUES(?,'p',?,?,?)").run('d'.repeat(64),JSON.stringify(['message.send']),now-1000,now+60000);
 const control={kind:'control_entry',principalId:'control-'+'d'.repeat(64),projectId:'p',permissions:['message.send']},send=messageSendOrchestration(f.store,{ensureBoundSession:async()=>{throw Error('MUST_NOT_CREATE');}}),reply=send(f.store,control,{toRoleId:'member',body:'原绑定尚未接收的工作',requestId:'queued-message'});await settleFactoryOrchestrations(f.store);
 assert.equal(readOperation(f.store,reply.payload.operationId).state,'observed');assert.equal(f.store.db.prepare("SELECT state FROM messages WHERE to_role_id='member'").get().state,'stored');const queued=f.call('role.provision',f.args);assert.equal(queued.ok,false);assert.equal(queued.payload.error,'HANDOVER_PENDING_EFFECTS');assert.equal(f.stats().calls,1);
});



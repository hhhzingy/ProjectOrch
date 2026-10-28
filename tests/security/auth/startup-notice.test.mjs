import test from 'node:test';import assert from 'node:assert/strict';
import {executionFixture} from './execution-fixture.mjs';import {installSyntheticPolicy} from './synthetic-policy.mjs';
import {WorkflowConsumer} from '../../../apps/kernel/dist/execution/workflow-consumer.js';
import {enqueueWorkflowCandidatesWithin} from '../../../apps/kernel/dist/execution/workflow-intents.js';
import {createToolDispatcher} from '../../../apps/kernel/dist/tools/gateway-tools.js';
import {issueAgentCredential,authenticateAgentCredential} from '../../../apps/kernel/dist/auth/agent-credential.js';
import {openStore} from '../../../packages/persistence/dist/index.js';
import {ExecutionCoordinator} from '../../../apps/kernel/dist/execution/coordinator.js';
import {pumpMessageDelivery} from '../../../apps/kernel/dist/execution/message-delivery.js';

function setup(t,mode='normal'){
 const f=executionFixture(t),actions=['identity','project.read','policy.read','role.read','task.read','task.claim','role.startup_ack','message.send'];
 installSyntheticPolicy(f.store,'p',[{id:'execution',revision:1,actions:mode==='action'?actions.filter(a=>a!=='role.startup_ack'):actions,readPaths:['tasks/*','roles/*'],writePaths:['tasks/*','roles/*'],roleIds:[],delegableActions:[],maxDelegationDepth:0}]);
 f.store.db.exec('UPDATE projects SET plan_revision=1');if(mode==='pause')f.store.db.exec('UPDATE projects SET user_paused=1');if(mode==='disabled')f.store.db.exec("UPDATE projects SET policy_json=json_set(policy_json,'$.nativeMode','disabled')");
 const source=mode.startsWith('agent')?'agent-role-source':mode==='source'?'revoked-or-untrusted':'synthetic-user';f.store.db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('source','p',?,'source',?,'test','{}','completed',200)").run(source,'a'.repeat(64));
 if(mode.startsWith('agent')){
  const credential=issueAgentCredential(f.store,'binding',1,{isolation:'verified_session',session:f.session},250,60000).credential.split('.')[0];
  f.store.db.prepare("INSERT INTO agent_role_sources(project_id,role_id,source_principal_id) VALUES('p','worker',?)").run(source);
  f.store.db.prepare("INSERT INTO agent_command_scopes(command_id,project_id,role_id,request_id,credential_id) VALUES('source','p','worker','source',?)").run(credential);
  if(mode==='agent-revoked')f.store.db.prepare('UPDATE agent_credentials SET revoked_at=299 WHERE id=?').run(credential);
 }
 f.store.transaction(db=>enqueueWorkflowCandidatesWithin(db,'p','source',300,['task','next']));let now=300;f.services.now=()=>now;
 const consumer=new WorkflowConsumer(f.store,f.coordinator,{workspaceForTask:()=> 'workspace',trustedLocalUserId:'synthetic-user',retryDelayMs:1});
 return {...f,consumer,advance:()=>now++};
}

test('计划变更后持久通知每角色/版本只一次，不代角色握手；真实角色工具ack后可准备',t=>{
 const f=setup(t),before=f.store.db.prepare('SELECT plan_revision FROM role_startup_acks').get().plan_revision;
 f.consumer.pump();f.advance();f.consumer.pump();
 const messages=f.store.db.prepare('SELECT body,state FROM messages').all();assert.equal(messages.length,1);assert.equal(messages[0].state,'stored');assert.match(messages[0].body,/projectorch_role_startup_ack/);assert.match(messages[0].body,/不在本消息轮领取/);
 assert.equal(f.store.db.prepare('SELECT plan_revision FROM role_startup_acks').get().plan_revision,before);assert.equal(f.calls,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM attempts').get().n,0);
 const p=f.store.db.prepare("SELECT policy_revision,plan_revision FROM projects WHERE id='p'").get(),r=f.store.db.prepare("SELECT revision FROM roles WHERE id='worker'").get();
 const call=createToolDispatcher(f.store,{now:()=>302,callerNativeConversationId:f.session.nativeConversationId}),ack=call(f.principal,'role.startup_ack',{requestId:'actual-role-ack',protocolVersion:2,policyRevision:p.policy_revision,planRevision:p.plan_revision,roleRevision:r.revision,taskSpecRevisions:[{taskId:'task',specRevision:1},{taskId:'next',specRevision:1}]});assert.equal(ack.ok,true,JSON.stringify(ack));
 assert.equal(f.store.db.prepare('SELECT plan_revision FROM role_startup_acks').get().plan_revision,1);f.services.now=()=>303;assert.ok(f.coordinator.prepare(f.principal,{requestKey:'after-real-ack',taskId:'task',workspaceId:'workspace'}));assert.equal(f.calls,0);
});
for(const mode of ['pause','disabled','action','source','agent-revoked'])test(`${mode}时不排通知、不放宽原阻塞或代握手`,t=>{
 const f=setup(t,mode),before=f.store.db.prepare('SELECT plan_revision FROM role_startup_acks').get().plan_revision;f.consumer.pump();assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM messages').get().n,0);assert.equal(f.store.db.prepare('SELECT plan_revision FROM role_startup_acks').get().plan_revision,before);assert.equal(f.calls,0);
});
test('Agent实际命令来源仍有原message.send授权时只排一次版本通知',t=>{
 const f=setup(t,'agent');f.consumer.pump();f.advance();f.consumer.pump();assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM messages').get().n,1);assert.equal(f.calls,0);assert.equal(f.store.db.prepare('SELECT plan_revision FROM role_startup_acks').get().plan_revision,0);
});

test('关闭重开SQLite后同版本/多任务仍只一条持久通知',t=>{
 const f=setup(t);f.consumer.pump();const id=f.store.db.prepare('SELECT id FROM messages').get().id;f.store.close();
 const reopened=openStore(f.filename);f.stores.push(reopened);f.advance();const coordinator=new ExecutionCoordinator(reopened,f.services),consumer=new WorkflowConsumer(reopened,coordinator,{workspaceForTask:()=> 'workspace',trustedLocalUserId:'synthetic-user',retryDelayMs:1});consumer.pump();f.advance();consumer.pump();
 const rows=reopened.db.prepare('SELECT id FROM messages').all();assert.equal(rows.length,1);assert.equal(rows[0].id,id);assert.equal(reopened.db.prepare('SELECT plan_revision FROM role_startup_acks').get().plan_revision,0);assert.equal(f.calls,0);
});

test('通知模型轮中真实角色ack已保存，仍须等消息写效果结束才能准备任务',async t=>{
 const f=setup(t),session={...f.session,nativeWorkspaceId:f.driver.workspaceRoot};f.store.db.prepare("UPDATE sessions SET native_workspace_id=? WHERE id='session'").run(f.driver.workspaceRoot);f.driver.session=session;
 const credential=issueAgentCredential(f.store,'binding',1,{isolation:'verified_session',session},250,60000).credential,principal=authenticateAgentCredential(f.store,credential,400);f.services.principalForBinding=()=>principal;f.services.now=()=>400;
 f.consumer.pump();const dispatch=createToolDispatcher(f.store,{now:()=>400,callerNativeConversationId:session.nativeConversationId});let driverError;
 const result=await pumpMessageDelivery(f.store,{now:()=>400,runInBinding:async(_binding,target,_text,guard,started)=>{
  try{guard();started(target.harnessId,target.nativeConversationId,'controlled-notice-turn');const p=f.store.db.prepare("SELECT policy_revision,plan_revision FROM projects WHERE id='p'").get(),r=f.store.db.prepare("SELECT revision FROM roles WHERE id='worker'").get();
  const ack=dispatch(principal,'role.startup_ack',{requestId:'ack-during-notice',protocolVersion:2,policyRevision:p.policy_revision,planRevision:p.plan_revision,roleRevision:r.revision,taskSpecRevisions:[{taskId:'task',specRevision:1},{taskId:'next',specRevision:1}]});assert.equal(ack.ok,true,JSON.stringify(ack));
  assert.throws(()=>f.coordinator.prepare(principal,{requestKey:'while-notice-active',taskId:'task',workspaceId:'workspace'}),/DISPATCH_CONCURRENCY_EXCEEDED/);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM attempts').get().n,0);
  return{harnessId:target.harnessId,nativeConversationId:target.nativeConversationId,nativeTurnId:'controlled-notice-turn',status:'completed',responseText:'ack完成',exitConfirmed:true};}catch(error){driverError=error;throw error;}
 }});
 assert.equal(result.delivered,1,String(driverError?.stack??JSON.stringify(result)));assert.ok(f.coordinator.prepare(principal,{requestKey:'after-notice-ended',taskId:'task',workspaceId:'workspace'}));assert.equal(f.calls,0);
});

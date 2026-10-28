import test from 'node:test';
import assert from 'node:assert/strict';
import {executionFixture} from './execution-fixture.mjs';
import {issueRoleTurnCredential} from '../../../apps/kernel/dist/auth/role-turn-credential.js';
import {buildRoleToolBackend} from '../../../apps/kernel/dist/tools/role-tool-backend.js';
import {issueAgentCredential} from '../../../apps/kernel/dist/auth/agent-credential.js';

test('标准HTTP角色工具从受信发送范围取得真实执行ID，认领成功；终态和原连接关闭后立即失效',async t=>{
 let settle;const f=executionFixture(t);f.services.now=Date.now;f.store.db.prepare('UPDATE agent_credentials SET expires_at=?').run(Date.now()+60000);
 let token;const ready=new Promise(resolve=>{f.setStart((input,started)=>({result:Promise.resolve().then(()=>{token=issueRoleTurnCredential(f.store,'binding',input.attemptId,Date.now());started(f.session,'native-turn');resolve();return new Promise(r=>{settle=r;});})}));});
 const id=f.prepare('scoped'),run=f.coordinator.run(id);await ready;
 try{
  const backend=buildRoleToolBackend(f.store,token);assert.ok(backend);
  const result=backend.call('projectorch_task_claim',{requestId:'claim',taskId:'task',expectedRevision:1,expectedSpecRevision:1});assert.equal(result.ok,true,JSON.stringify(result));
  backend.closed();assert.equal(backend.call('projectorch_task_read',{taskId:'task'}).ok,false);
  const nextConnection=buildRoleToolBackend(f.store,token);assert.equal(nextConnection.call('projectorch_task_read',{taskId:'task'}).ok,true);
  settle({session:f.session,executionId:'native-turn',status:'completed',terminalConfirmed:true});assert.equal(await run,'succeeded');
  assert.equal(nextConnection.call('projectorch_task_read',{taskId:'task'}).ok,false,'旧轮凭据不能借下一轮原生ID继续操作');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM role_turn_credentials').get().n,1);
 }finally{settle?.({session:f.session,executionId:'native-turn',status:'completed',terminalConfirmed:true});await run;}
});

test('普通绑定凭据不能伪造当前轮；正文执行ID/用户身份不可覆盖来源',async t=>{
 const f=executionFixture(t);f.services.now=Date.now;f.store.db.prepare('UPDATE agent_credentials SET expires_at=?').run(Date.now()+60000);
 const token=issueAgentCredential(f.store,'binding',1,{isolation:'verified_session',session:f.session},Date.now(),60000).credential;
 const id=f.prepare('binding-only'),run=f.coordinator.run(id);await new Promise(r=>setImmediate(r));
 try{
  const backend=buildRoleToolBackend(f.store,token),args={requestId:'claim',taskId:'task',expectedRevision:1,expectedSpecRevision:1};
  assert.equal(backend.call('projectorch_task_claim',args).payload.error,'CALLER_EXECUTION_REQUIRED');
  assert.equal(backend.call('projectorch_task_claim',{...args,callerNativeExecutionId:'native-turn'}).ok,false);
  assert.equal(f.store.db.prepare("SELECT state FROM tasks WHERE id='task'").get().state,'draft');
 }finally{f.finish();await run;}
});

test('范围只能在该绑定的待发送尝试签发；不可从角色正文绑定别人的执行',t=>{
 const f=executionFixture(t);assert.throws(()=>issueRoleTurnCredential(f.store,'binding','absent',300),/ROLE_TURN_DISPATCH_REQUIRED/);
 const id=f.prepare();assert.throws(()=>issueRoleTurnCredential(f.store,'binding',id,300),/ROLE_TURN_DISPATCH_REQUIRED/);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM role_turn_credentials').get().n,0);
});


// 实际HTTP+生产角色后端；合成角色/尝试，无官方Harness或模型调用。
import test from 'node:test';import assert from 'node:assert/strict';
import {executionFixture} from './execution-fixture.mjs';
import {startMcpHttpHost} from '../../../apps/kernel/dist/tools/mcp-http-host.js';
import {buildRoleToolBackend} from '../../../apps/kernel/dist/tools/role-tool-backend.js';
import {issueAgentCredential,authenticateAgentCredential} from '../../../apps/kernel/dist/auth/agent-credential.js';
import {issueRoleTurnCredential} from '../../../apps/kernel/dist/auth/role-turn-credential.js';
import {succeedBinding} from '../../../packages/domain/dist/native-binding/index.js';

async function connection(f,token){
 const host=await startMcpHttpHost({backendForConnection:()=>({list:()=>[],call:()=>({ok:false,payload:{}}),closed:()=>{}}),resolveBearer:value=>buildRoleToolBackend(f.store,value)});let sid,id=0;
 const rpc=async(method,params,credential=token,session=sid,notify=false)=>{const frame={jsonrpc:'2.0',method,params};if(!notify)frame.id=++id;const response=await fetch(host.url,{method:'POST',headers:{Authorization:'Bearer '+credential,'Content-Type':'application/json',...(session?{'Mcp-Session-Id':session}:{})},body:JSON.stringify(frame)});const next=response.headers.get('mcp-session-id');if(next&&credential===token)sid=next;return {status:response.status,value:response.status===202?null:await response.json(),session:next};};
 await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'synthetic-role-lifecycle',version:'1'}});await rpc('notifications/initialized',{},token,sid,true);
 return {host,rpc,sid:()=>sid,identity:()=>rpc('tools/call',{name:'projectorch_identity',arguments:{}})};
}
for(const mode of ['revoke','expire','rebind'])test(`HTTP旧角色连接${mode}后逐请求拒绝，不继承缓存身份`,async t=>{
 const f=executionFixture(t),createdAt=Date.now()-1000,grant=issueAgentCredential(f.store,'binding',1,{isolation:'verified_session',session:f.session},createdAt,60000),client=await connection(f,grant.credential);
 const credentialId=authenticateAgentCredential(f.store,grant.credential,Date.now()).credentialId;
 try{
  const before=await client.identity();assert.equal(before.status,200);assert.equal(before.value.result.isError,false);
  if(mode==='revoke')f.store.db.prepare('UPDATE agent_credentials SET revoked_at=? WHERE id=?').run(Date.now(),credentialId);
  if(mode==='expire')f.store.db.prepare('UPDATE agent_credentials SET expires_at=? WHERE id=?').run(Date.now()-1,credentialId);
  if(mode==='rebind')succeedBinding(f.store,{newBindingId:'next-binding',projectId:'p',roleId:'worker',sessionId:'session'},Date.now());
  assert.equal((await client.identity()).status,404);
  if(mode!=='rebind'){
   const fresh=issueAgentCredential(f.store,'binding',1,{isolation:'verified_session',session:f.session},Date.now(),60000);
   const denied=await client.rpc('tools/call',{name:'projectorch_identity',arguments:{}},fresh.credential,client.sid());assert.equal(denied.status,404,'新凭据也不能借旧SID恢复被撤销/过期身份');
   const next=await connection(f,fresh.credential);try{assert.equal((await next.identity()).value.result.isError,false);}finally{await next.host.close();}
  }
 }finally{await client.host.close();}
});

test('HTTP尝试范围凭据在原轮终态后失效，不能在缓存连接取得下轮身份',async t=>{
 const f=executionFixture(t);f.services.now=Date.now;f.store.db.prepare('UPDATE agent_credentials SET expires_at=?').run(Date.now()+60000);
 let token,settle,entered;const ready=new Promise(r=>{entered=r;});
 f.setStart((input,started)=>({result:Promise.resolve().then(()=>{token=issueRoleTurnCredential(f.store,'binding',input.attemptId,Date.now());started(f.session,'exact-native-turn');entered();return new Promise(r=>{settle=r;});})}));
 const attempt=f.prepare('http-role-turn'),running=f.coordinator.run(attempt);await ready;const client=await connection(f,token);
 try{
  assert.equal((await client.identity()).value.result.isError,false);
  settle({session:f.session,executionId:'exact-native-turn',status:'completed',terminalConfirmed:true});await running;
  const after=await client.identity();assert.equal(after.value.result.isError,true);assert.match(JSON.stringify(after.value),/ROLE_TURN_NOT_CURRENT/);
 }finally{settle({session:f.session,executionId:'exact-native-turn',status:'completed',terminalConfirmed:true});await running;await client.host.close();}
});

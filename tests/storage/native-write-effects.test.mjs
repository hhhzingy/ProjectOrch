// SQLite/真实临时目录组件验证，不运行官方Harness或模型。
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {executionFixture} from '../security/auth/execution-fixture.mjs';
import {createRole} from '../../packages/domain/dist/roles/index.js';
import {createDurableOperation} from '../../apps/kernel/dist/tools/orchestration-tools.js';
import {reserveNativeWriteWithin,assertNativeWriteWithin,activateNativeWriteWithin,finishNativeWriteWithin} from '../../packages/domain/dist/workspaces/index.js';
import {ExecutionCoordinator} from '../../apps/kernel/dist/execution/coordinator.js';
import {issueAgentCredential,authenticateAgentCredential} from '../../apps/kernel/dist/auth/agent-credential.js';

function setup(t,overlap=true){
 const f=executionFixture(t),second=path.join(overlap?f.driver.workspaceRoot:f.dir,'second');fs.mkdirSync(second);
 f.store.db.prepare("UPDATE sessions SET native_workspace_id=? WHERE id='session'").run(f.driver.workspaceRoot);
 const session={...f.session,nativeWorkspaceId:f.driver.workspaceRoot};f.driver.session=session;
 const credential=issueAgentCredential(f.store,'binding',1,{isolation:'verified_session',session},210,60000).credential,principal=authenticateAgentCredential(f.store,credential,220);
 const coordinator=new ExecutionCoordinator(f.store,{...f.services,principalForBinding:()=>principal});
 const prepare=()=>coordinator.prepare(principal,{requestKey:'task-request',taskId:'task',workspaceId:'workspace'});
 createRole(f.store,{id:'other',projectId:'p',name:'other',charter:'合成',permissionProfileId:'execution'},200);
 f.store.db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id,native_workspace_id) VALUES('other-session','zcode','host','synthetic-only','other-native',?)").run(second);
 f.store.db.exec("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('other-binding','p','other','other-session',1,200)");
 function request(kind,index){const roleId=index===1?'worker':'other',targetRoot=index===1?f.driver.workspaceRoot:second;let sourceId;
  if(kind==='factory')sourceId=createDurableOperation(f.store,{operationKey:'factory-'+index,kind:'message.send',projectId:'p',payload:{toRoleId:roleId,body:'SYNTHETIC_ONLY'}},220).operationId;
  else{sourceId='message-'+index;f.store.db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES(?,'p','synthetic','request-'||? ,?,'message.send','{}','completed',220)").run('command-'+index,index,'0'.repeat(64));f.store.db.prepare("INSERT INTO messages(id,project_id,command_id,to_role_id,kind,body,delivery_json,state,created_at) VALUES(?,'p',?,?,'information','SYNTHETIC_ONLY','{}','queued',220)").run(sourceId,'command-'+index,roleId);}
  return {projectId:'p',roleId,kind,sourceId,targetRoot,...(kind==='message'?{bindingId:index===1?'binding':'other-binding',bindingEpoch:1}:{})};
 }
 return {...f,second,request,prepare,reserve:input=>f.store.transaction(()=>reserveNativeWriteWithin(f.store,input,250))};
}
for(const pair of [['factory','factory'],['factory','message'],['message','factory'],['message','message']])for(const overlap of [true,false])test(`${pair.join('→')}：${overlap?'重叠拒绝':'独立共存'}，来源和预约不混为task`,t=>{
 const f=setup(t,overlap),first=f.request(pair[0],1),second=f.request(pair[1],2),proof=f.reserve(first);
 f.store.transaction(()=>assertNativeWriteWithin(f.store,proof));
 if(overlap)assert.throws(()=>f.reserve(second),/NATIVE_WRITE_CONFLICT/);else f.reserve(second);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM native_write_effects').get().n,overlap?1:2);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM attempts').get().n,0);
});
for(const kind of ['factory','message'])for(const order of ['task-first','effect-first'])test(`task↔${kind}：${order}双向物理冲突`,t=>{
 const f=setup(t),request=f.request(kind,2);
 if(order==='task-first'){f.prepare();assert.throws(()=>f.reserve(request),/NATIVE_WRITE_CONFLICT/);}
 else{f.reserve(request);assert.throws(()=>f.prepare(),/WORKSPACE_CONFLICT/);}
 assert.equal(f.calls,0);
});
test('精确来源、owner/fence/绑定与路径身份不可替换；unknown持久阻断，关闭重开不接管',t=>{
 const f=setup(t),request=f.request('message',1),proof=f.reserve(request);
 assert.deepEqual(f.reserve(request),proof);
 for(const key of ['id','ownerKey','fence','proofSha256'])f.store.transaction(()=>assert.throws(()=>assertNativeWriteWithin(f.store,{...proof,[key]:key==='fence'?proof.fence+1:proof[key]+'x'}),/OWNER_OR_FENCE/));
 f.store.transaction(()=>activateNativeWriteWithin(f.store,proof,'message',260));
 assert.throws(()=>f.store.db.prepare("UPDATE native_write_effects SET target_root='elsewhere'").run(),/IDENTITY_IMMUTABLE/);
 f.store.transaction(()=>finishNativeWriteWithin(f.store,proof,'unknown',{sourceId:request.sourceId,reason:'controlled loss after boundary'},270));
 assert.throws(()=>f.reserve(request),/OWNER_OR_FENCE/);assert.throws(()=>f.prepare(),/WORKSPACE_CONFLICT/);
 assert.throws(()=>f.store.db.prepare("UPDATE native_write_effects SET state='reserved'").run(),/TRANSITION_REFUSED/);
 assert.throws(()=>f.store.db.prepare('DELETE FROM native_write_effects').run(),/HISTORY_REQUIRED/);
});
test('来源正文/目标绑定漂移拒绝；not_sent结算和终态证明分离',t=>{
 const f=setup(t),request=f.request('message',1),proof=f.reserve(request);
 f.store.db.prepare("UPDATE messages SET body='CHANGED' WHERE id=?").run(request.sourceId);
 f.store.transaction(()=>assert.throws(()=>assertNativeWriteWithin(f.store,proof),/SOURCE_CHANGED/));
 f.store.transaction(()=>assert.throws(()=>finishNativeWriteWithin(f.store,proof,'terminal',{sourceId:request.sourceId,terminalConfirmed:true},270),/TERMINAL_PROOF/));
 f.store.transaction(()=>finishNativeWriteWithin(f.store,proof,'not_sent',{sourceId:request.sourceId,notSent:true},280));
 assert.equal(f.store.db.prepare('SELECT state FROM native_write_effects').get().state,'settled');f.prepare();
});
test('工厂planned目录可预约但不创建，重解析/非绝对路径不退回当前目录',t=>{
 const f=setup(t,false),input={...f.request('factory',2),targetRoot:path.join(f.second,'not-created','role')},proof=f.reserve(input);
 assert.equal(fs.existsSync(input.targetRoot),false);fs.mkdirSync(input.targetRoot,{recursive:true});f.store.transaction(()=>assertNativeWriteWithin(f.store,proof));
 assert.throws(()=>f.reserve({...input,targetRoot:'.'}),/SCOPE_REQUIRED/);
 const other=f.request('factory',1);assert.throws(()=>f.reserve({...other,targetRoot:path.dirname(f.dir)}),/OUTSIDE_PROJECT/);
});

for(const pair of [['task','factory'],['task','message'],['factory','factory'],['factory','message'],['message','message']])for(const overlap of [true,false])test(`两SQLite连接竞态 ${pair.join('↔')} ${overlap?'重叠仅一成功':'独立两者成功'}`,async t=>{
 const {Worker}=await import('node:worker_threads'),f=setup(t,overlap),signal=new SharedArrayBuffer(4),flag=new Int32Array(signal),workers=[];
 const requests=pair.map((kind,index)=>kind==='task'?{kind,request:{projectId:'p',roleId:'worker',bindingEpoch:1,taskId:'task',taskRevision:1,workspaceId:'workspace',attemptId:'concurrent-task'}}:{kind,request:f.request(kind,index+1)});
 const code=`const{parentPort,workerData:d}=require('node:worker_threads');(async()=>{const[{openStore},writes,dispatch]=await Promise.all([import(d.storeModule),import(d.writeModule),import(d.dispatchModule)]);parentPort.postMessage({phase:'ready'});Atomics.wait(new Int32Array(d.signal),0,0);const store=openStore(d.filename);let result;try{if(d.kind==='task')dispatch.reserveDispatch(store,d.request,250);else store.transaction(()=>writes.reserveNativeWriteWithin(store,d.request,250));result={phase:'result',allowed:true};}catch(error){result={phase:'result',allowed:false,reason:error.message};}finally{store.close();}parentPort.postMessage(result);})().catch(error=>{throw error;});`;
 const pending=requests.map(({kind,request})=>{
  const worker=new Worker(code,{eval:true,workerData:{kind,request,signal,filename:f.filename,storeModule:new URL('../../packages/persistence/dist/index.js',import.meta.url).href,writeModule:new URL('../../packages/domain/dist/workspaces/index.js',import.meta.url).href,dispatchModule:new URL('../../packages/domain/dist/dispatch-guard/index.js',import.meta.url).href}});workers.push(worker);
  let a,b,c,d;const ready=new Promise((resolve,reject)=>{a=resolve;b=reject;}),result=new Promise((resolve,reject)=>{c=resolve;d=reject;});worker.on('message',message=>{if(message.phase==='ready')a();if(message.phase==='result')c(message);});worker.on('error',error=>{b(error);d(error);});return{ready,result};
 });
 try{await Promise.all(pending.map(p=>p.ready));Atomics.store(flag,0,1);Atomics.notify(flag,0);const results=await Promise.all(pending.map(p=>p.result));assert.equal(results.filter(r=>r.allowed).length,overlap?1:2,JSON.stringify(results));for(const rejected of results.filter(r=>!r.allowed))assert.match(rejected.reason,/NATIVE_WRITE_CONFLICT|WORKSPACE_CONFLICT/);}
 finally{for(const worker of workers)await worker.terminate();}
});

// 真正关闭重开连接，不能把旧owner能力带入新的Store。
test('关闭重开后原写预约保留，新Store不能接管或重发',async t=>{
 const {openStore}=await import('../../packages/persistence/dist/index.js'),f=setup(t),request=f.request('message',1),proof=f.reserve(request);f.store.close();const reopened=openStore(f.filename);f.stores.push(reopened);
 assert.equal(reopened.db.prepare('SELECT state FROM native_write_effects').get().state,'reserved');
 assert.throws(()=>reopened.transaction(()=>assertNativeWriteWithin(reopened,proof)),/OWNER_OR_FENCE/);
 assert.throws(()=>reopened.transaction(()=>reserveNativeWriteWithin(reopened,request,300)),/OWNER_OR_FENCE/);assert.equal(reopened.db.prepare('SELECT COUNT(*) n FROM native_write_effects').get().n,1);
});

test('真实杀掉写预约后的受控内核进程，重启只转unknown不再次启动输入',async t=>{
 const {spawn}=await import('node:child_process'),{once}=await import('node:events'),{openStore}=await import('../../packages/persistence/dist/index.js'),{interruptNativeWritesWithin}=await import('../../packages/domain/dist/workspaces/index.js');
 const f=setup(t),request=f.request('message',1);f.store.close();
 const code=`const d=JSON.parse(process.argv[1]);const{openStore}=await import(d.storeModule);const{reserveNativeWriteWithin,activateNativeWriteWithin}=await import(d.writeModule);const store=openStore(d.filename);store.transaction(()=>{const proof=reserveNativeWriteWithin(store,d.request,250);activateNativeWriteWithin(store,proof,'message',250);});process.stdout.write('RESERVED_NATIVE_WRITE\\n');setInterval(()=>{},1000);`;
 const data={filename:f.filename,request,storeModule:new URL('../../packages/persistence/dist/index.js',import.meta.url).href,writeModule:new URL('../../packages/domain/dist/workspaces/index.js',import.meta.url).href};
 const child=spawn(process.execPath,['--input-type=module','-e',code,JSON.stringify(data)],{env:{SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP},stdio:['ignore','pipe','pipe'],windowsHide:true});
 try{
  const ready=new Promise((resolve,reject)=>{let output='';child.stdout.on('data',bytes=>{output+=bytes;if(output.includes('RESERVED_NATIVE_WRITE'))resolve();});child.once('error',reject);child.once('exit',code=>reject(Error('HELPER_EXITED_BEFORE_MARKER:'+code)));});await ready;
  const exit=once(child,'close');child.kill('SIGKILL');await exit;
  const reopened=openStore(f.filename);f.stores.push(reopened);assert.equal(reopened.db.prepare('SELECT state FROM native_write_effects').get().state,'active');reopened.transaction(()=>interruptNativeWritesWithin(reopened,300));
  assert.equal(reopened.db.prepare('SELECT state FROM native_write_effects').get().state,'unknown');assert.throws(()=>reopened.transaction(()=>reserveNativeWriteWithin(reopened,request,310)),/OWNER_OR_FENCE/);assert.equal(reopened.db.prepare('SELECT COUNT(*) n FROM native_write_effects').get().n,1);assert.ok(reopened.db.prepare("SELECT 1 FROM native_write_effect_observations WHERE state='active'").get());
 }finally{if(child.exitCode===null&&child.signalCode===null){const closed=once(child,'close');child.kill();await closed;}}
});

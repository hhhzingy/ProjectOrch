// 真实临时目录、生产协调器与数据库；原生传输为受控组件，不调用官方模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {executionFixture} from './execution-fixture.mjs';
import {workspaceWriterConflict,registerWorkspace} from '../../../packages/domain/dist/workspaces/index.js';
import {createProject} from '../../../packages/domain/dist/projects/index.js';
import {evaluateDispatch,reserveDispatch} from '../../../packages/domain/dist/dispatch-guard/index.js';
import {NativeDispatchNotSent} from '../../../apps/kernel/dist/execution/coordinator.js';

function writer(f,mode,state='unknown'){
 const root=mode==='ancestor'?f.dir:mode==='independent'?path.join(f.dir,'separate'):path.join(f.driver.workspaceRoot,'nested');
 fs.mkdirSync(root,{recursive:true});
 const projectId=mode==='cross-project'?'other':'p';
 if(projectId!=='p')createProject(f.store,{id:projectId,name:'other',hostId:'host',canonicalRoot:root,objective:'合成冲突'},200);
 registerWorkspace(f.store,{id:'foreign',projectId,canonicalPath:root,enforcement:'enforced'},210);
 if(projectId==='p')f.store.db.prepare('INSERT INTO workspace_reservations(id,project_id,workspace_id,task_id,task_revision,fence,state) VALUES(?,?,?,?,?,?,?)').run('foreign-res',projectId,'foreign','next',1,1,state);
 else f.store.db.prepare("UPDATE workspaces SET state='unknown' WHERE id='foreign'").run();
 return root;
}
for(const mode of ['ancestor','descendant','cross-project'])test(`不同ID的${mode}未决写范围阻止领域及生产准备`,t=>{
 const f=executionFixture(t);writer(f,mode);
 const request={projectId:'p',roleId:'worker',bindingEpoch:1,taskId:'task',taskRevision:1,workspaceId:'workspace'};
 assert.ok(evaluateDispatch(f.store,request).denials.some(d=>d.code==='WORKSPACE_CONFLICT'));
 assert.throws(()=>reserveDispatch(f.store,{...request,attemptId:'blocked'},250),/WORKSPACE_CONFLICT/);
 assert.throws(()=>f.prepare(),/WORKSPACE_CONFLICT/);
 assert.equal(f.calls,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM attempts').get().n,0);
 if(mode!=='cross-project')assert.equal(f.store.db.prepare("SELECT state FROM workspace_reservations WHERE id='foreign-res'").get().state,'unknown');
});

test('正常自身预约及不重叠占位允许一次执行，不误判自身reserved',async t=>{
 const f=executionFixture(t);writer(f,'independent');const id=f.prepare();f.finish();assert.equal(await f.coordinator.run(id),'succeeded');assert.equal(f.calls,1);
 assert.equal(f.store.db.prepare("SELECT state FROM workspace_reservations WHERE id='foreign-res'").get().state,'unknown');
});

test('精确自有预约证明逐字段核对，wrong owner/fence/task/spec与unknown均不可豁免',t=>{
 const f=executionFixture(t),id=f.prepare(),row=f.row(id);
 const proof={dispatchId:id,dispatchOwnerKey:row.owner_key,dispatchFence:row.fence,attemptId:row.attempt_id,projectId:'p',workspaceId:'workspace',taskId:'task',taskRevision:1,workspaceFence:row.workspace_fence,bindingId:'binding',bindingEpoch:1,driverOwnerKey:f.driver.ownerKey};
 f.store.transaction(()=>{
  assert.equal(workspaceWriterConflict(f.store,'p','workspace',proof),null);
  for(const key of Object.keys(proof)){const value=proof[key];assert.notEqual(workspaceWriterConflict(f.store,'p','workspace',{...proof,[key]:typeof value==='number'?value+1:value+'-wrong'}),null,key);}
 });
 f.store.db.prepare("UPDATE workspace_reservations SET state='unknown' WHERE id=?").run('res-'+id);
 assert.notEqual(f.store.transaction(()=>workspaceWriterConflict(f.store,'p','workspace',proof)),null);
});

test('异步就绪期间新增重叠unknown，在最终发送回调拒绝且保留对方占位',async t=>{
 const f=executionFixture(t);let sends=0;
 f.setStart((_input,_started,guard)=>({result:(async()=>{await Promise.resolve();writer(f,'descendant');try{guard();}catch(error){throw new NativeDispatchNotSent(error.message);}sends++;throw Error('UNEXPECTED_SEND');})()}));
 const id=f.prepare();assert.equal(await f.coordinator.run(id),'cancelled');assert.equal(sends,0);assert.equal(f.store.db.prepare("SELECT state FROM workspace_reservations WHERE id='foreign-res'").get().state,'unknown');
});

test('重叠的两次准备最多提交一个预约，独立目录仍可保留',t=>{
 const f=executionFixture(t),nested=path.join(f.driver.workspaceRoot,'nested');fs.mkdirSync(nested);registerWorkspace(f.store,{id:'nested',projectId:'p',canonicalPath:nested,enforcement:'enforced'},210);
 const request={projectId:'p',roleId:'worker',bindingEpoch:1,taskId:'task',taskRevision:1};
 reserveDispatch(f.store,{...request,workspaceId:'workspace',attemptId:'first'},250);
 assert.throws(()=>reserveDispatch(f.store,{...request,taskId:'next',workspaceId:'nested',attemptId:'second'},251),/WORKSPACE_CONFLICT/);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM workspace_reservations').get().n,1);
});

test('declared write范围相交也拦截；无关目录不因项目相同被全局锁住',t=>{
 const f=executionFixture(t);writer(f,'independent');assert.equal(f.store.transaction(()=>workspaceWriterConflict(f.store,'p','workspace')),null);
 f.store.db.prepare("UPDATE workspaces SET write_paths_json='[\"workspace/*\"]' WHERE id='foreign'").run();assert.equal(f.store.transaction(()=>workspaceWriterConflict(f.store,'p','workspace')),'overlap');
});

for(const mode of ['case-alias','junction','declared-junction'])test(`物理范围${mode}不作为独立目录放行`,t=>{
 const f=executionFixture(t);
 if(mode==='case-alias'){
  if(process.platform!=='win32'){t.skip('Windows大小写别名');return;}
  assert.throws(()=>registerWorkspace(f.store,{id:'foreign',projectId:'p',canonicalPath:f.driver.workspaceRoot.toUpperCase(),enforcement:'enforced'},220),/UNIQUE constraint failed: workspaces.canonical_path/);assert.equal(f.calls,0);return;
 }
 const link=path.join(f.dir,'directory-alias');fs.symlinkSync(f.driver.workspaceRoot,link,process.platform==='win32'?'junction':'dir');
 try{
  if(mode==='junction'){assert.throws(()=>registerWorkspace(f.store,{id:'foreign',projectId:'p',canonicalPath:link,enforcement:'enforced'},220),/UNIQUE constraint failed: workspaces.canonical_path/);assert.equal(f.calls,0);return;}
  else {writer(f,'independent');f.store.db.prepare("UPDATE workspaces SET write_paths_json='[\"directory-alias/*\"]' WHERE id='foreign'").run();}
  assert.throws(()=>f.prepare(),/WORKSPACE_CONFLICT/);assert.equal(f.calls,0);
 }finally{fs.unlinkSync(link);}
});

for(const overlap of [true,false])test(`两独立SQLite连接并发预约：${overlap?'重叠至多一个':'独立目录两者可用'}`,async t=>{
 const {Worker}=await import('node:worker_threads');const f=executionFixture(t),second=path.join(overlap?f.driver.workspaceRoot:f.dir,'second');fs.mkdirSync(second);registerWorkspace(f.store,{id:'second',projectId:'p',canonicalPath:second,enforcement:'enforced'},220);
 const signal=new SharedArrayBuffer(4),flag=new Int32Array(signal),workers=[];
 const code=`const{parentPort,workerData:d}=require('node:worker_threads');(async()=>{const[{openStore},{reserveDispatch}]=await Promise.all([import(d.storeModule),import(d.guardModule)]);parentPort.postMessage({phase:'ready'});Atomics.wait(new Int32Array(d.signal),0,0);const store=openStore(d.filename);let result;try{reserveDispatch(store,d.request,250);result={phase:'result',allowed:true};}catch(error){result={phase:'result',allowed:false,reason:error.message};}finally{store.close();}parentPort.postMessage(result);})().catch(error=>{throw error;});`;
 const requests=[{workspaceId:'workspace',taskId:'task',attemptId:'one'},{workspaceId:'second',taskId:'next',attemptId:'two'}];
 const pending=requests.map(request=>{
  const worker=new Worker(code,{eval:true,workerData:{signal,filename:f.filename,request:{projectId:'p',roleId:'worker',bindingEpoch:1,taskRevision:1,...request},storeModule:new URL('../../../packages/persistence/dist/index.js',import.meta.url).href,guardModule:new URL('../../../packages/domain/dist/dispatch-guard/index.js',import.meta.url).href}});workers.push(worker);
  let readyResolve,resultResolve,readyReject,resultReject;const ready=new Promise((a,b)=>{readyResolve=a;readyReject=b;}),result=new Promise((a,b)=>{resultResolve=a;resultReject=b;});worker.on('message',message=>{if(message.phase==='ready')readyResolve();if(message.phase==='result')resultResolve(message);});worker.on('error',error=>{readyReject(error);resultReject(error);});return{ready,result};
 });
 try{await Promise.all(pending.map(p=>p.ready));Atomics.store(flag,0,1);Atomics.notify(flag,0);const results=await Promise.all(pending.map(p=>p.result));assert.equal(results.filter(r=>r.allowed).length,overlap?1:2);for(const rejected of results.filter(r=>!r.allowed))assert.match(rejected.reason,/WORKSPACE_CONFLICT/);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM workspace_reservations').get().n,overlap?1:2);}
 finally{for(const worker of workers)await worker.terminate();}
});

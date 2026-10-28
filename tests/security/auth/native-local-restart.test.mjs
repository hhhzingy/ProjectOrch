// 合成受信章程；真实SQLite/进程中断。0官方模型输入，不作为原生验收。
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {executionFixture} from './execution-fixture.mjs';
import {openStore} from '../../../packages/persistence/dist/index.js';
import {createDurableOperation,recordStep} from '../../../apps/kernel/dist/tools/orchestration-tools.js';
import {beginFactoryWrite,withBindingToolsWrite} from '../../../apps/kernel/dist/execution/factory-write-scope.js';
import {interruptNativeWritesWithin,reconcileRecoveredFactoryWriteWithin} from '../../../packages/domain/dist/workspaces/index.js';

function setup(t){
 const f=executionFixture(t),session={...f.session,nativeWorkspaceId:f.driver.workspaceRoot};
 f.store.db.prepare("UPDATE sessions SET native_workspace_id=? WHERE id='session'").run(f.driver.workspaceRoot);
 const op=createDurableOperation(f.store,{operationKey:'local-restart',kind:'message.send',projectId:'p',payload:{toRoleId:'worker'}},200);
 recordStep(f.store,op.operationId,{step:'binding-registration',state:'observed',detail:JSON.stringify({bindingId:'binding',sessionRef:session,nativeTurnId:'original-charter-turn',charterDelivered:true}),at:230},230);
 const input={projectId:'p',roleId:'worker',operationId:op.operationId,workspaceRoot:f.driver.workspaceRoot,admission:()=>{},now:()=>250};
 return {...f,input,session,repair:store=>withBindingToolsWrite(store,{...input,bindingId:'binding',bindingEpoch:1},()=>{})};
}

for(const fact of ['local','unattributed'])test(`两条章程恢复路径均拒绝历史${fact}未知事实，不因当前证据被覆盖放行`,t=>{
 const f=setup(t),scope=beginFactoryWrite(f.store,f.input);
 if(fact==='local')assert.throws(()=>scope.runBindingTools(()=>new Promise(()=>{})),/ASYNC_BINDING_TOOLS_WRITE_UNSUPPORTED/);
 else f.store.db.prepare("UPDATE native_write_effects SET evidence_json=?").run(JSON.stringify({unattributed:true}));
 f.store.db.prepare("UPDATE native_write_effects SET phase='charter',evidence_json='{}'").run();
 recordStep(f.store,f.input.operationId,{step:'session-identity',state:'observed',detail:JSON.stringify(f.session),at:260},260);
 recordStep(f.store,f.input.operationId,{step:'recovered-terminal',state:'observed',detail:JSON.stringify({sessionRef:f.session,nativeTurnId:'original-charter-turn',charterDelivered:true}),at:260},260);
 f.store.transaction(()=>interruptNativeWritesWithin(f.store,270));
 assert.throws(()=>f.repair(f.store),/LOCAL_RECOVERY_REQUIRED/);
 assert.throws(()=>f.store.transaction(()=>reconcileRecoveredFactoryWriteWithin(f.store,{projectId:'p',roleId:'worker',sourceId:f.input.operationId,sessionRef:f.session,nativeTurnId:'original-charter-turn'},280)),/LOCAL_RECOVERY_REQUIRED/);
 assert.equal(f.store.db.prepare('SELECT state FROM native_write_effects').get().state,'unknown');
});

for(const legacyOverwrite of [false,true])test(`重复重启/停机保留本地未完成，旧章程不能解锁${legacyOverwrite?'（含旧覆盖记录）':''}`,async t=>{
 const f=setup(t),scope=beginFactoryWrite(f.store,f.input);let resolve;
 const late=new Promise(r=>resolve=r);
 assert.throws(()=>scope.runBindingTools(()=>late),/ASYNC_BINDING_TOOLS_WRITE_UNSUPPORTED/);
 // 原调用方fail之前的中断窗口。旧版丢失当前事实时仍须消费不可改写观察。
 if(legacyOverwrite)f.store.db.prepare("UPDATE native_write_effects SET phase='charter',evidence_json='{}'").run();
 f.store.close();
 for(let restart=0;restart<3;restart++){
  const store=openStore(f.filename);f.stores.push(store);
  store.transaction(()=>interruptNativeWritesWithin(store,300+restart));
  store.transaction(()=>interruptNativeWritesWithin(store,310+restart));
  assert.throws(()=>f.repair(store),/LOCAL_RECOVERY_REQUIRED/);
  const row=store.db.prepare('SELECT state,evidence_json FROM native_write_effects').get();
  assert.equal(row.state,'unknown');
  if(!legacyOverwrite)assert.equal(JSON.parse(row.evidence_json).localWriteCompleted,false);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM native_write_effects').get().n,1);
  store.close();
 }
 resolve();await late;
 assert.throws(()=>scope.complete({}),/./,'旧调用方迟到结果不能重新取得owner');
});

test('同步本地调用已结束的正例可按原章程核对；不丢成功事实',t=>{
 const f=setup(t),scope=beginFactoryWrite(f.store,f.input);
 scope.runBindingTools(()=>{});f.store.close();
 const store=openStore(f.filename);f.stores.push(store);
 store.transaction(()=>interruptNativeWritesWithin(store,300));f.repair(store);
 const rows=store.db.prepare('SELECT purpose,state,evidence_json FROM native_write_effects ORDER BY rowid').all();
 assert.equal(rows.length,2);assert.ok(rows.every(r=>r.state==='settled'));
 assert.equal(JSON.parse(rows[0].evidence_json).localWriteCompleted,true);
});

test('本地阶段强杀真实子进程，重启和重复停机不得新建修复代次',async t=>{
 const f=setup(t);f.store.close();
 const data={filename:f.filename,input:{...f.input,admission:undefined,now:undefined},storeModule:new URL('../../../packages/persistence/dist/index.js',import.meta.url).href,scopeModule:new URL('../../../apps/kernel/dist/execution/factory-write-scope.js',import.meta.url).href};
 const code=`const d=JSON.parse(process.argv[1]);const{openStore}=await import(d.storeModule);const{beginFactoryWrite}=await import(d.scopeModule);const store=openStore(d.filename);const scope=beginFactoryWrite(store,{...d.input,admission:()=>{},now:()=>250});try{scope.runBindingTools(()=>new Promise(()=>{}));}catch(error){if(error.message!=='ASYNC_BINDING_TOOLS_WRITE_UNSUPPORTED')throw error;}process.stdout.write('LOCAL_PENDING\\n');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',code,JSON.stringify(data)],{env:{SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP},stdio:['ignore','pipe','pipe'],windowsHide:true});
 try{
  await new Promise((resolve,reject)=>{let out='',err='';const timeout=setTimeout(()=>reject(Error('LOCAL_HELPER_TIMEOUT:'+err)),15000);child.stdout.on('data',bytes=>{out+=bytes;if(out.includes('LOCAL_PENDING')){clearTimeout(timeout);resolve();}});child.stderr.on('data',b=>err+=b);child.once('error',reject);child.once('exit',code=>{clearTimeout(timeout);reject(Error('LOCAL_HELPER_EARLY_EXIT:'+code+':'+err));});});
  const closed=once(child,'close');child.kill('SIGKILL');await closed;
  for(let restart=0;restart<2;restart++){
   const store=openStore(f.filename);f.stores.push(store);
   store.transaction(()=>interruptNativeWritesWithin(store,300+restart));
   store.transaction(()=>interruptNativeWritesWithin(store,310+restart));
   assert.throws(()=>f.repair(store),/LOCAL_RECOVERY_REQUIRED/);
   const row=store.db.prepare('SELECT state,evidence_json FROM native_write_effects').get();
   assert.equal(row.state,'unknown');assert.equal(JSON.parse(row.evidence_json).localWriteCompleted,false);
   assert.equal(store.db.prepare('SELECT COUNT(*) n FROM native_write_effects').get().n,1);store.close();
  }
 }finally{if(child.exitCode===null&&child.signalCode===null){const closed=once(child,'close');child.kill();await closed;}}
});

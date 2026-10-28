import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {temporaryDirectory} from '../../adapters/temporary-directory.mjs';
import {CodexCliExecutionDriver} from '../../../apps/kernel/dist/execution/zcode-supervisor.js';
import {NativeCompatibilityRegistry} from '../../../apps/kernel/dist/native/compatibility.js';
import {NativeSessionLease} from '../../../apps/kernel/dist/native/session-lease.js';

test('Q3：生产Codex同实例超时后精确历史+传输退出解锁自己的租约，恢复不重发',async t=>{
 const dir=temporaryDirectory(t,'projectorch-owned-recovery-');
 fs.writeFileSync(path.join(dir,'app-server'),`const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const q=JSON.parse(line);if(!q.id)return;let result={};if(q.method==='thread/resume')result={thread:{id:'native',status:{type:'idle'},turns:[]}};if(q.method==='turn/start'){fs.appendFileSync('inputs','1');result={turn:{id:'turn-one'}};}if(q.method==='thread/read')result={thread:{id:'native',status:{type:'idle'},turns:[{id:'turn-one',status:'completed'}]}};console.log(JSON.stringify({id:q.id,result}));});rl.on('close',()=>process.exit(0));`);
 const session={harnessId:'codex',hostId:'synthetic',profileId:'recovery',nativeConversationId:'native'};
 const registry=new NativeCompatibilityRegistry(),driver=new CodexCliExecutionDriver(session,dir,registry,{executable:process.execPath,env:{},cwd:dir,leaseDirectory:dir,timeoutMs:1000});
 t.after(()=>driver.close());registry.recordTrustedProbe({identity:driver.identity(),probeId:'synthetic',evidenceSha256:'d'.repeat(64),capabilities:{textInput:'verified',resume:'verified',historyRead:'verified',roleTools:'verified'}});
 const result=await driver.start({spec:{goal:'synthetic'}},()=>{}).result;assert.equal(result.status,'unknown');assert.equal(result.executionId,'turn-one');
 assert.throws(()=>NativeSessionLease.acquire(dir,session),/OWNER_OCCUPIED/);
 assert.throws(()=>driver.inspectExecution({session:{...session,nativeConversationId:'wrong'},executionId:'turn-one'}),/SESSION_MISMATCH/);
 await assert.rejects(driver.inspectExecution({session,executionId:'wrong'}).result,/EXECUTION_ID_MISMATCH/);
 const proof=await driver.inspectExecution({session,executionId:'turn-one'}).result;assert.equal(proof.status,'completed');
 assert.throws(()=>driver.confirmRecoveredTerminal({...proof,executionId:'wrong'}),/TERMINAL_PROOF/);
 driver.confirmRecoveredTerminal(proof);
 assert.equal(fs.readFileSync(path.join(dir,'inputs'),'utf8'),'1');
 const successorLease=NativeSessionLease.acquire(dir,session);successorLease.releaseAfterExit(true);
});

test('Q3：没有本实例所有权时不能凭终态抢第三方活owner',async t=>{
 const dir=temporaryDirectory(t,'projectorch-other-owner-'),session={harnessId:'codex',hostId:'synthetic',profileId:'recovery',nativeConversationId:'native'};
 const lease=NativeSessionLease.acquire(dir,session);
 const driver=new CodexCliExecutionDriver(session,dir,new NativeCompatibilityRegistry(),{executable:process.execPath,env:{},cwd:dir,leaseDirectory:dir});
 try{assert.throws(()=>driver.confirmRecoveredTerminal({session,executionId:'turn-one',status:'completed',terminalConfirmed:true}),/OWNER_STILL_ALIVE/);lease.assertCurrent(session);}finally{lease.releaseAfterExit(true);}
});

test('原生已完成但缺业务标记时关闭自己的空闲传输，不误报成功、不占住下一轮租约',async t=>{
 const dir=temporaryDirectory(t,'projectorch-markerless-');
 fs.writeFileSync(path.join(dir,'app-server'),`const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const q=JSON.parse(line);if(!q.id)return;let result={};if(q.method==='thread/resume')result={thread:{id:'native',status:{type:'idle'},turns:[]}};if(q.method==='turn/start'){fs.appendFileSync('inputs','1');result={turn:{id:'turn-one'}};}console.log(JSON.stringify({id:q.id,result}));if(q.method==='turn/start')console.log(JSON.stringify({method:'turn/completed',params:{threadId:'native',turn:{id:'turn-one',status:'completed'}}}));});rl.on('close',()=>process.exit(0));`);
 const session={harnessId:'codex',hostId:'synthetic',profileId:'markerless',nativeConversationId:'native'},registry=new NativeCompatibilityRegistry();
 const driver=new CodexCliExecutionDriver(session,dir,registry,{executable:process.execPath,env:{},cwd:dir,leaseDirectory:dir,timeoutMs:1000,prepareTurn:()=>({env:{},configOverrides:[]})});
 t.after(()=>driver.close());registry.recordTrustedProbe({identity:driver.identity(),probeId:'synthetic',evidenceSha256:'e'.repeat(64),capabilities:{textInput:'verified',resume:'verified',historyRead:'verified',roleTools:'verified'}});
 const result=await driver.start({spec:{goal:'synthetic'}},()=>{}).result;
 assert.equal(result.status,'unknown');assert.equal(result.terminalConfirmed,false);assert.equal(result.executionId,'turn-one');
 const nextOwner=NativeSessionLease.acquire(dir,session);nextOwner.releaseAfterExit(true);
 assert.equal(fs.readFileSync(path.join(dir,'inputs'),'utf8'),'1','关闭空闲连接不能补发一次输入');
});

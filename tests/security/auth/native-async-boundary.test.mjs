import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {registerWorkspace} from '../../../packages/domain/dist/workspaces/index.js';
import {executionFixture} from './execution-fixture.mjs';
import {issueAgentCredential,authenticateAgentCredential} from '../../../apps/kernel/dist/auth/agent-credential.js';
import {ExecutionCoordinator} from '../../../apps/kernel/dist/execution/coordinator.js';
import {CodexCliExecutionDriver,ZcodeCliExecutionDriver} from '../../../apps/kernel/dist/execution/zcode-supervisor.js';
import {CodexAdapter} from '../../../apps/kernel/dist/adapters/codex-adapter.js';
import {NativeRpcError} from '../../../apps/kernel/dist/native/stdio-peer.js';

test('Q4：Codex生产协调器/驱动模型前置拒绝为cancelled并释放预约，修复后正式新请求可运行',async t=>{
 const f=executionFixture(t);f.store.db.exec("UPDATE sessions SET harness_id='codex' WHERE id='session'");
 const session={...f.session,harnessId:'codex'},credential=issueAgentCredential(f.store,'binding',1,{isolation:'verified_session',session},200,60000).credential,principal=authenticateAgentCredential(f.store,credential,210);
 let unavailable=true,sends=0;
 const driver=new CodexCliExecutionDriver(session,f.driver.workspaceRoot,f.registry,{executable:process.execPath,env:{},cwd:f.driver.workspaceRoot,leaseDirectory:f.dir,modelSelection:()=>{if(unavailable)throw new NativeRpcError('MODEL_SELECTION_UNRESOLVED','not_sent');return null;}});
 f.registry.recordTrustedProbe({identity:driver.identity(),probeId:'synthetic',evidenceSha256:'d'.repeat(64),capabilities:{textInput:'verified',resume:'verified',historyRead:'verified',roleTools:'verified'}});
 const old={resume:CodexAdapter.prototype.resumeThread,run:CodexAdapter.prototype.runTurn,close:CodexAdapter.prototype.close};
 CodexAdapter.prototype.resumeThread=async()=>({threadId:session.nativeConversationId});CodexAdapter.prototype.close=async()=>{};
 CodexAdapter.prototype.runTurn=async(_a,_b,_c,onStarted,guard)=>{guard();sends++;onStarted('new-turn');return{status:'completed',markerSeen:true,text:'ok'}};
 const coordinator=new ExecutionCoordinator(f.store,{...f.services,principalForBinding:()=>principal,driverForBinding:()=>driver});
 try{
  const first=coordinator.prepare(principal,{requestKey:'selection-rejected',taskId:'task',workspaceId:'workspace'});assert.equal(await coordinator.run(first),'cancelled');assert.equal(sends,0);assert.equal(f.reservation().state,'released');
  assert.equal(f.row(first).native_execution_id,null);
  unavailable=false;const second=coordinator.prepare(principal,{requestKey:'selection-repaired',taskId:'task',workspaceId:'workspace'});assert.equal(await coordinator.run(second),'succeeded');assert.equal(sends,1);
 }finally{coordinator.close();await driver.close();CodexAdapter.prototype.resumeThread=old.resume;CodexAdapter.prototype.runTurn=old.run;CodexAdapter.prototype.close=old.close;}
});

test('生产Codex驱动在异步resume之后重核：暂停/撤权/owner/策略/hold/预约变化均无模型发送',async t=>{
  const old={resume:CodexAdapter.prototype.resumeThread,run:CodexAdapter.prototype.runTurn,close:CodexAdapter.prototype.close};
  try {
    for(const change of ['normal','pause','revoke','owner','policy','hold','fence','overlap','path-change']){
      await t.test(change,async inner=>{
        const f=executionFixture(inner);f.store.db.prepare("UPDATE sessions SET harness_id='codex' WHERE id='session'").run();
        const session={...f.session,harnessId:'codex'};const raw=issueAgentCredential(f.store,'binding',1,{isolation:'verified_session',session},200,60000).credential;
        const principal=authenticateAgentCredential(f.store,raw,210);
        const driver=new CodexCliExecutionDriver(session,f.driver.workspaceRoot,f.registry,{executable:process.execPath,env:{},cwd:f.driver.workspaceRoot,leaseDirectory:f.dir});
        f.registry.recordTrustedProbe({identity:driver.identity(),probeId:'synthetic',evidenceSha256:'d'.repeat(64),capabilities:{textInput:'verified',resume:'verified',historyRead:'verified',roleTools:'verified'}});
        let sawResume,release;const observed=new Promise(r=>sawResume=r),gate=new Promise(r=>release=r);let sends=0;
        CodexAdapter.prototype.resumeThread=async()=>{sawResume();await gate;return{threadId:session.nativeConversationId}};
        CodexAdapter.prototype.runTurn=async(_a,_b,_c,onStarted,guard)=>{guard();sends++;onStarted('native-production-turn');return{threadId:session.nativeConversationId,turnId:'native-production-turn',status:'completed',markerSeen:true,text:'ok',textLength:2}};
        CodexAdapter.prototype.close=async()=>{};
        const coordinator=new ExecutionCoordinator(f.store,{...f.services,principalForBinding:()=>principal,driverForBinding:()=>driver});
        const id=coordinator.prepare(principal,{requestKey:'async-'+change,taskId:'task',workspaceId:'workspace'});const run=coordinator.run(id);await observed;
        if(change==='pause')f.store.db.exec("UPDATE projects SET user_paused=1 WHERE id='p'");
        if(change==='revoke')f.store.db.exec('UPDATE agent_credentials SET revoked_at=250');
        if(change==='owner')f.setOwner(false);
        if(change==='policy')f.store.db.exec("UPDATE projects SET policy_revision=policy_revision+1 WHERE id='p'");
        if(change==='hold')f.store.db.exec("UPDATE projects SET hold_revision=hold_revision+1 WHERE id='p'");
        if(change==='fence')f.store.db.exec('UPDATE workspace_reservations SET fence=fence+1');
        if(change==='overlap'){const nested=path.join(f.driver.workspaceRoot,'nested');fs.mkdirSync(nested);registerWorkspace(f.store,{id:'foreign',projectId:'p',canonicalPath:nested,enforcement:'enforced'},220);f.store.db.prepare("UPDATE workspaces SET state='unknown' WHERE id='foreign'").run();}
        if(change==='path-change')f.store.db.prepare("UPDATE workspaces SET canonical_path=? WHERE id='workspace'").run(f.dir);
        release();const phase=await run;
        assert.equal(sends,change==='normal'?1:0,change);
        if(change==='normal')assert.equal(phase,'succeeded');
        if(['pause','revoke','policy','hold'].includes(change))assert.equal(phase,'cancelled','确定未发送可释放');
        if(change==='owner')f.setOwner(true);
        coordinator.close();await driver.close();
      });
    }
  } finally {CodexAdapter.prototype.resumeThread=old.resume;CodexAdapter.prototype.runTurn=old.run;CodexAdapter.prototype.close=old.close;}
});

test('两端生产驱动对未证明的enforced_paths强制拒绝；不自动降低用户策略',()=>{
  for(const Driver of [ZcodeCliExecutionDriver,CodexCliExecutionDriver]){
    assert.throws(()=>Driver.prototype.assertIsolation({writeIsolation:'enforced_paths'}),/PATH_ENFORCEMENT_UNAVAILABLE/);
    assert.doesNotThrow(()=>Driver.prototype.assertIsolation({writeIsolation:'exclusive_workspace'}));
  }
});

test('生产ZCode驱动异步工具准备后重核物理范围，正常一次/重叠及目录变化零输入',async t=>{
 for(const change of ['normal','overlap','path-change'])await t.test(change,async inner=>{
  const f=executionFixture(inner),bundle=path.join(f.dir,'controlled.cjs'),marker=path.join(f.dir,'wire-input');
  fs.writeFileSync(bundle,`if(process.argv.includes('--version')){console.log('synthetic-only');process.exit(0);}require('node:fs').writeFileSync(${JSON.stringify(marker)},'sent');console.log(JSON.stringify({type:'turn.started',sessionId:'synthetic-native',turnId:'synthetic-turn'}));setTimeout(()=>console.log(JSON.stringify({type:'result',sessionId:'synthetic-native',turnId:'synthetic-turn',isError:false,response:'ok',projection:{status:'idle',turnCount:1}})),20);`);
  let ready,release;const observed=new Promise(r=>ready=r),gate=new Promise(r=>release=r);
  const driver=new ZcodeCliExecutionDriver(f.session,f.driver.workspaceRoot,f.registry,{executable:process.execPath,bundle,cwd:f.driver.workspaceRoot,env:{},leaseDirectory:f.dir,timeoutMs:5000,beforeTurn:async()=>{ready();await gate;}});
  f.registry.recordTrustedProbe({identity:driver.identity(),probeId:'synthetic',evidenceSha256:'d'.repeat(64),capabilities:{textInput:'verified',resume:'verified',historyRead:'verified',roleTools:'verified'}});
  const coordinator=new ExecutionCoordinator(f.store,{...f.services,driverForBinding:()=>driver});
  try{
   const id=coordinator.prepare(f.principal,{requestKey:'zcode-'+change,taskId:'task',workspaceId:'workspace'}),run=coordinator.run(id);await observed;
   if(change==='overlap'){const nested=path.join(f.driver.workspaceRoot,'nested');fs.mkdirSync(nested);registerWorkspace(f.store,{id:'foreign',projectId:'p',canonicalPath:nested,enforcement:'enforced'},220);f.store.db.prepare("UPDATE workspaces SET state='unknown' WHERE id='foreign'").run();}
   if(change==='path-change')f.store.db.prepare("UPDATE workspaces SET canonical_path=? WHERE id='workspace'").run(f.dir);
   release();assert.equal(await run,change==='normal'?'succeeded':'cancelled');assert.equal(fs.existsSync(marker),change==='normal');
   if(change==='overlap')assert.equal(f.store.db.prepare("SELECT state FROM workspaces WHERE id='foreign'").get().state,'unknown');
  }finally{coordinator.close();driver.close();}
 });
});

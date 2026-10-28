import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {temporaryDirectory} from '../../adapters/temporary-directory.mjs';
import {CodexThreadFactory} from '../../../apps/kernel/dist/execution/codex-supervisor.js';
import {CodexAdapter} from '../../../apps/kernel/dist/adapters/codex-adapter.js';
import {NativeCompatibilityRegistry} from '../../../apps/kernel/dist/native/compatibility.js';
import {NativeRpcError} from '../../../apps/kernel/dist/native/stdio-peer.js';

test('Q2实际生产工厂管道：连接准备期间撤权不创建线程；线程创建后撤权不发送章程',async t=>{
 for(const boundary of ['connect','charter'])await t.test(boundary,async inner=>{
  let adapter;inner.after(async()=>{await adapter?.close();});
  const dir=temporaryDirectory(inner,'projectorch-factory-boundary-');
  fs.writeFileSync(path.join(dir,'app-server'),`const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const q=JSON.parse(line);if(!q.id)return;fs.appendFileSync('calls',q.method+'\\n');if(q.method==='initialize'){fs.writeFileSync('ready','1');setTimeout(()=>console.log(JSON.stringify({id:q.id,result:{}})),300);return;}const result=q.method==='thread/start'?{thread:{id:'new-thread',turns:[],status:{type:'idle'}}}:{};console.log(JSON.stringify({id:q.id,result}));});rl.on('close',()=>process.exit(0));`);
  const registry=new NativeCompatibilityRegistry(),factory=new CodexThreadFactory({executable:process.execPath,cwd:dir,env:{},leaseDirectory:dir,registry,timeoutMs:2000}),identity=factory.identity();
  registry.recordTrustedProbe({identity,probeId:'synthetic',evidenceSha256:'a'.repeat(64),capabilities:{textInput:'verified',resume:'verified',historyRead:'verified'}});
  adapter=new CodexAdapter({executable:process.execPath,cwd:dir,env:{},leaseDirectory:dir,hostId:'synthetic',profileId:'factory',compatibility:{registry,identity}});
  const steps=[];let authorized=true;const run=factory.createThreadWithCharter({adapter,charter:'synthetic',marker:'unused',hostId:'synthetic',profileId:'factory',assertCanSend:()=>{if(!authorized)throw new NativeRpcError('CONTROL_REVOKED','not_sent');},onStep:s=>{steps.push(s);if(boundary==='charter'&&s.step==='create-thread'&&s.state==='observed')authorized=false;}});
  // 立即挂拒绝处理，避免准备期间的Promise rejection变成未处理异常。
  const rejected=assert.rejects(run,e=>e instanceof NativeRpcError&&e.delivery==='not_sent');
  if(boundary==='connect'){
   const deadline=Date.now()+3000;while(!fs.existsSync(path.join(dir,'ready'))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
   assert.ok(fs.existsSync(path.join(dir,'ready')));authorized=false;
  }
  await rejected;const methods=fs.readFileSync(path.join(dir,'calls'),'utf8').trim().split('\n');
  assert.equal(methods.filter(m=>m==='turn/start').length,0);
  assert.equal(methods.filter(m=>m==='thread/start').length,boundary==='charter'?1:0);
  if(boundary==='charter'){assert.ok(steps.some(s=>s.step==='create-thread'&&s.state==='observed'));assert.equal(steps.some(s=>s.step==='create-thread'&&s.state==='failed'),false);assert.ok(steps.some(s=>s.step==='deliver-charter'&&s.state==='failed'));}
 });
});

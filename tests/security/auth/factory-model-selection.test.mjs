import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {temporaryDirectory} from '../../adapters/temporary-directory.mjs';
import {ZcodeSessionFactory} from '../../../apps/kernel/dist/execution/zcode-supervisor.js';
import {CodexThreadFactory} from '../../../apps/kernel/dist/execution/codex-supervisor.js';
import {NativeCompatibilityRegistry} from '../../../apps/kernel/dist/native/compatibility.js';
import {NativeSessionLease} from '../../../apps/kernel/dist/native/session-lease.js';
import {selectZcodeModel} from '../../../apps/kernel/dist/native/model-selection.js';
const selected={modelId:'GLM-5.3-Flash',reasoningLevel:null};
function fixture(t,mode='ok'){
 const dir=temporaryDirectory(t,'projectorch-factory-model-'),bundle=path.join(dir,'native.cjs'),log=path.join(dir,'calls.jsonl'),state=path.join(dir,'model.json'),leases=path.join(dir,'leases');fs.mkdirSync(leases);
 fs.writeFileSync(bundle,`const fs=require('node:fs'),readline=require('node:readline');const mode=${JSON.stringify(mode)},log=${JSON.stringify(log)},state=${JSON.stringify(state)},args=process.argv.slice(2);const emit=v=>console.log(JSON.stringify(v)),record=v=>fs.appendFileSync(log,JSON.stringify(v)+'\\n');
 if(args.includes('--version')){console.log('synthetic-model');process.exit(0);}
 const sid='sess_strict_factory',model=()=>fs.existsSync(state)?JSON.parse(fs.readFileSync(state)):{providerId:'synthetic-provider',modelId:'default',options:{}};
 if(args.includes('app-server')){readline.createInterface({input:process.stdin}).on('line',line=>{const f=JSON.parse(line);record(f);let result={};if(f.method==='session/create')result={session:{sessionId:sid}};if(f.method==='session/resume')result={sessionId:sid};if(f.method==='session/read')result={session:{sessionId:mode==='wrong-session'?'other':sid,status:'idle'},settings:{model:{current:model()}}};if(f.method==='session/setModel'){if(mode==='reject'){emit({id:f.id,error:{code:-32602,message:'Model not available'}});return;}if(mode!=='mismatch')fs.writeFileSync(state,JSON.stringify(f.params.model));}
 if(f.method==='session/subscribe')result={sessionId:sid,eventSeq:0};
 if(f.method==='session/send'){
  if(mode==='post-drift')fs.writeFileSync(state,JSON.stringify({providerId:'synthetic-provider',modelId:'unexpected'}));
  emit({method:'v4/telemetry/event',params:{sessionId:sid,eventSeq:1,sourceCommandId:f.params.inputId,kind:'turn.started',turnId:'t1'}});
  emit({method:'v4/telemetry/event',params:{sessionId:sid,eventSeq:2,kind:'turn.terminal',turnId:mode==='wrong-terminal'?'other':'t1',status:'success'}});
 }emit({id:f.id,result});});}
 else {record({method:'prompt',args});const resume=args[args.indexOf('--resume')+1];if(resume!==sid){process.exit(2);}if(mode==='post-drift')fs.writeFileSync(state,JSON.stringify({providerId:'synthetic-provider',modelId:'unexpected'}));for(const frame of [{type:'system',subtype:'session_created',sessionId:sid,turnId:null},{type:'assistant',subtype:'text',text:'ACK',sessionId:sid,turnId:'t1'},{type:'result',isError:false,sessionId:sid,turnId:'t1',response:'ACK',projection:{status:'idle',turnCount:1}}])emit(frame);}
 `);
 const factory=new ZcodeSessionFactory({executable:process.execPath,bundle,env:{},leaseDirectory:leases,registry:new NativeCompatibilityRegistry(),timeoutMs:mode==='wrong-terminal'?500:15000});const steps=[];
 return {dir,leases,steps,read:()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse):[],run:(guard)=>factory.createSessionWithCharter({modelSelection:selected,assertCanSend:guard,charter:'ACK',workspaceRoot:dir,hostId:'h',profileId:'p',onStep:s=>steps.push(s)})};
}
test('ZCode首输入之前setModel并读回，同连接同会话完成首轮而不依赖空会话跨进程持久化',async t=>{
 const f=fixture(t),outcome=await f.run();assert.equal(outcome.effectiveModel.modelId,selected.modelId);assert.equal(outcome.nativeSessionId,'sess_strict_factory');const calls=f.read();assert.equal(calls.find(x=>x.method==='session/create').params.persistence,'immediate');assert.ok(calls.findIndex(x=>x.method==='session/setModel')<calls.findIndex(x=>x.method==='session/send'));assert.equal(calls.filter(x=>x.method==='session/send').length,1);assert.equal(calls.filter(x=>x.method==='prompt').length,0);assert.equal(outcome.receipt.protocol,'official_rpc');assert.equal(f.steps.filter(s=>s.step==='create-session'&&s.state==='observed').length,1);
 const lease=NativeSessionLease.acquire(f.leases,outcome.sessionRef);lease.releaseAfterExit(true);
});
for(const mode of ['cross-provider','unavailable','ambiguous'])test('ZCode从官方目录解析目标provider：'+mode,async()=>{
 let current={modelId:'default',providerId:'default-provider'},sets=0;
 const available=mode==='unavailable'?[{ref:current}]:[{ref:{modelId:selected.modelId,providerId:'target-provider'}},...(mode==='ambiguous'?[{ref:{modelId:selected.modelId,providerId:'second-provider'}}]:[])];
 const peer={request:async(method,args,guard)=>{guard?.();if(method==='session/read')return {session:{sessionId:'s',status:'idle'},settings:{model:{current,available}}};if(method==='session/setModel'){sets++;current=args.model;return {};}}};
 if(mode==='cross-provider'){await selectZcodeModel(peer,'s',selected,()=>{});assert.equal(current.providerId,'target-provider');assert.equal(sets,1);}
 else{await assert.rejects(selectZcodeModel(peer,'s',selected,()=>{}),e=>e.delivery==='not_sent'&&/MODEL_SELECTION_UNAVAILABLE|MODEL_PROVIDER_AMBIGUOUS/.test(e.message));assert.equal(sets,0);}
});
for(const mode of ['reject','mismatch','wrong-session'])test('ZCode模型'+mode+'不发送默认模型章程；真实空会话ID可追踪',async t=>{
 const f=fixture(t,mode);await assert.rejects(f.run(),e=>e.delivery==='not_sent');assert.equal(f.read().filter(x=>x.method==='session/send'||x.method==='prompt').length,0);assert.ok(f.steps.some(s=>s.step==='create-session'&&s.state==='observed'&&s.detail==='sess_strict_factory'));
});
test('ZCode首轮后模型身份不一致不能宣称工厂成功或释放未知owner',async t=>{
 const f=fixture(t,'post-drift');await assert.rejects(f.run(),/FACTORY_MODEL_SELECTION_UNCONFIRMED/);assert.equal(f.read().filter(x=>x.method==='session/send').length,1);assert.throws(()=>NativeSessionLease.acquire(f.leases,{harnessId:'zcode',hostId:'h',profileId:'p',nativeConversationId:'sess_strict_factory',nativeWorkspaceId:f.dir}),/OCCUPIED/);
});
test('ZCode其他turn的终态不冒充首轮完成，超时保留owner且不重发',async t=>{
 const f=fixture(t,'wrong-terminal');await assert.rejects(f.run(),e=>e.delivery==='uncertain');assert.equal(f.read().filter(x=>x.method==='session/send').length,1);assert.throws(()=>NativeSessionLease.acquire(f.leases,{harnessId:'zcode',hostId:'h',profileId:'p',nativeConversationId:'sess_strict_factory',nativeWorkspaceId:f.dir}),/OCCUPIED/);
});
for(const mode of ['ok','mismatch','rejected','changed'])test('Codex工厂严格模型 '+mode,async t=>{
 const dir=temporaryDirectory(t,'projectorch-codex-factory-model-'),exe=path.join(dir,'codex.cmd'),inner=path.join(dir,'version.cjs');fs.writeFileSync(inner,"console.log('synthetic')");fs.writeFileSync(exe,`@echo off\r\n"${process.execPath}" "${inner}"\r\n`);const f=new CodexThreadFactory({executable:exe,cwd:dir,env:{},leaseDirectory:dir,registry:new NativeCompatibilityRegistry()});let turns=0,created=false;const steps=[];
 const adapter={startThread:async(args,guard)=>{guard();assert.equal(args.model,'gpt-6-luna');if(mode==='rejected')throw Error('MODEL_REJECTED');created=true;return {threadId:'strict-thread',model:mode==='mismatch'?'other':'gpt-6-luna'};},runTurn:async(text,marker,ms,on,guard,selection)=>{guard();turns++;assert.equal(selection.modelId,'gpt-6-luna');return {threadId:'strict-thread',status:'completed',markerSeen:true};},close(){}};
 const call=f.createThreadWithCharter({adapter,modelSelection:{modelId:'gpt-6-luna',reasoningLevel:null},assertCanSend:()=>{if(mode==='changed'&&created)throw Error('MODEL_SELECTION_CONFIG_CHANGED');},charter:'ACK',marker:'ACK',hostId:'h',profileId:'p',onStep:s=>steps.push(s)});
 if(mode==='ok'){assert.equal((await call).nativeThreadId,'strict-thread');assert.equal(turns,1);}else{await assert.rejects(call);assert.equal(turns,0);if(mode!=='rejected')assert.ok(steps.some(s=>s.step==='create-thread'&&s.state==='observed'));}
});

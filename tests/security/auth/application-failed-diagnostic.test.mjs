// 标准应用消息接线到持久回执；适配器回执为显式合成输入，不启动官方Harness。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startApplication} from '../../../apps/kernel/dist/lifecycle/application.js';
import {detectCodexIdentity} from '../../../apps/kernel/dist/execution/codex-supervisor.js';
import {createProject} from '../../../packages/domain/dist/projects/index.js';
import {bootstrapRole} from '../../../packages/domain/dist/bootstrap/index.js';
import {installSyntheticPolicy} from './synthetic-policy.mjs';
import {temporaryDirectory} from '../../adapters/temporary-directory.mjs';
import {CodexAdapter} from '../../../apps/kernel/dist/adapters/codex-adapter.js';

for(const mode of ['usage-limit','private-failure'])test(`标准消息路径failed安全诊断持久化：${mode}`,async t=>{
 const dir=temporaryDirectory(t,'projectorch-app-failed-diagnostic-'),workspace=path.join(dir,'workspace');fs.mkdirSync(workspace);
 const matrix=path.join(dir,'matrix.json');fs.writeFileSync(matrix,JSON.stringify({schemaVersion:1,entries:[{identity:{harnessId:'codex',...detectCodexIdentity(process.execPath),bundleSha256:null,adapterProtocol:'codex-app-server-jsonl-v2',route:'official_rpc'},capabilities:{textInput:'verified',resume:'verified',historyRead:'verified',roleTools:'verified'},evidence:'SYNTHETIC_ONLY',testedAt:new Date().toISOString()}]}));
 const rt=await startApplication(dir,{workflowPollMs:20,compatibilityMatrixPath:matrix,native:{codex:{executable:process.execPath,profileDirectory:path.join(dir,'profile'),leaseDirectory:path.join(dir,'leases'),timeoutMs:3000},workspaceForTask:()=>workspace}});
 const resume=CodexAdapter.prototype.resumeThread,run=CodexAdapter.prototype.runTurn;let turns=0;
 CodexAdapter.prototype.resumeThread=async()=>({threadId:'synthetic-thread'});
 CodexAdapter.prototype.runTurn=async function(_input,_marker,_timeout,onStarted,guard){guard();turns++;onStarted('synthetic-turn');return {turnId:'synthetic-turn',status:'failed',text:'',markerSeen:false,...(mode==='usage-limit'?{diagnostics:{code:'CODEX_USAGE_LIMIT_EXCEEDED',elapsedMs:1,message:'SECRET'}}:{})};};
 try{
  const s=rt.store,now=Date.now();createProject(s,{id:'p',name:'合成失败诊断',hostId:'synthetic',canonicalRoot:dir,objective:'offline only'},now);
  bootstrapRole(s,{projectId:'p',localRef:'worker',name:'执行',charter:'synthetic',permissionProfileId:'team',permissionProfileRevision:1,expectedPolicyRevision:0,principalId:'synthetic-user',requestId:'b'},now);
  installSyntheticPolicy(s,'p',[{id:'team',revision:1,actions:['identity'],readPaths:[],writePaths:[],roleIds:[],delegableActions:[],maxDelegationDepth:0}]);
  s.db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id,native_workspace_id,verified_origin) VALUES('s','codex','synthetic','test','synthetic-thread',?,1)").run(workspace);
  s.db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b','p','worker','s',1,?)").run(now);
  s.db.exec("UPDATE roles SET binding_state='ready' WHERE id='worker'");
  let sid,seq=0;const token=rt.mcpEntrypoint.bearerToken;
  const rpc=async(method,params,notification=false)=>{
   const res=await fetch(rt.mcpEntrypoint.url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(sid?{'Mcp-Session-Id':sid}:{})},body:JSON.stringify({jsonrpc:'2.0',...(notification?{}:{id:++seq}),method,params})});sid=res.headers.get('mcp-session-id')??sid;
   if(notification){assert.equal(res.status,202);return;}
   const v=await res.json();assert.equal(v.error,undefined);assert.equal(v.result?.isError??false,false);return v.result;
  };
  await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'synthetic-test',version:'1'}});await rpc('notifications/initialized',{},true);
  await rpc('tools/call',{name:'projectorch_message_send',arguments:{projectId:'p',toRoleId:'worker',requestId:'one',body:'synthetic'}});
  let row;for(let i=0;i<150;i++){row=s.db.prepare('SELECT state,delivery_json FROM messages').get();if(row?.state==='failed')break;await delay(40);}
  assert.equal(row?.state,'failed',row?.delivery_json);const receipt=JSON.parse(row.delivery_json).transitions.at(-1).receipt;
  assert.equal(receipt.failureCode,'CODEX_TURN_FAILED');
  if(mode==='usage-limit'){assert.equal(receipt.diagnostics.code,'CODEX_USAGE_LIMIT_EXCEEDED');assert.ok(Number.isSafeInteger(receipt.diagnostics.elapsedMs));}
  else assert.equal(receipt.diagnostics,undefined);
  const effect=s.db.prepare('SELECT state,evidence_json FROM native_write_effects WHERE purpose=\'message\'').get();assert.equal(effect.state,'settled');
  assert.deepEqual(JSON.parse(effect.evidence_json).receipt.diagnostics,receipt.diagnostics);
  assert.doesNotMatch(row.delivery_json+effect.evidence_json,/SECRET|additionalDetails|codexErrorInfo/);
  assert.equal(turns,1);
 }finally{await rt.stop();CodexAdapter.prototype.resumeThread=resume;CodexAdapter.prototype.runTurn=run;}
});

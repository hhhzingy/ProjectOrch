// 标准应用/MCP/真实生产工厂/受控JSONL进程；不是官方Harness E2E，零模型调用。
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {setTimeout as delay} from 'node:timers/promises';
import {startApplication} from '../../../apps/kernel/dist/lifecycle/application.js';
import {detectCodexIdentity} from '../../../apps/kernel/dist/execution/codex-supervisor.js';
import {createProject} from '../../../packages/domain/dist/projects/index.js';import {createRole} from '../../../packages/domain/dist/roles/index.js';
import {bootstrapRole} from '../../../packages/domain/dist/bootstrap/index.js';import {openStore} from '../../../packages/persistence/dist/index.js';
import {installSyntheticPolicy} from './synthetic-policy.mjs';import {temporaryDirectory} from '../../adapters/temporary-directory.mjs';
import {readOperation,settleFactoryOrchestrations} from '../../../apps/kernel/dist/tools/orchestration-tools.js';
import {unresolvedFactoryCapacity} from '../../../apps/kernel/dist/execution/native-capacity.js';

for(const route of ['bootstrap','message'])for(const boundary of ['within-deadline','after-deadline'])test(`标准应用${route}工厂创建响应${boundary}：观察落盘或隔离，原操作不重建`,async t=>{
 const directory=temporaryDirectory(t,'projectorch-app-factory-stop-'),workspace=path.join(directory,'native-workspace');fs.mkdirSync(workspace);
 const responseDelay=boundary==='within-deadline'?35:300,drainMs=boundary==='within-deadline'?800:30;
 fs.writeFileSync(path.join(workspace,'app-server'),`const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const q=JSON.parse(line);if(!q.id)return;fs.appendFileSync('calls',q.method+'\\n');if(q.method==='thread/start'){fs.writeFileSync('request-received','1');setTimeout(()=>console.log(JSON.stringify({id:q.id,result:{thread:{id:'original-created',turns:[],status:{type:'idle'}}}})),${responseDelay});return;}console.log(JSON.stringify({id:q.id,result:{}}));});rl.on('close',()=>process.exit(0));`);
 const matrix=path.join(directory,'synthetic-matrix.json');fs.writeFileSync(matrix,JSON.stringify({schemaVersion:1,entries:[{identity:{harnessId:'codex',...detectCodexIdentity(process.execPath),bundleSha256:null,adapterProtocol:'codex-app-server-jsonl-v2',route:'official_rpc'},capabilities:{textInput:'verified',resume:'verified',historyRead:'verified',roleTools:'verified'},evidence:'SYNTHETIC_CONTROLLED_TRANSPORT_NOT_NATIVE_EVIDENCE',testedAt:new Date().toISOString()}]}));
 const options={shutdownDrainMs:drainMs,compatibilityMatrixPath:matrix,native:{codex:{executable:process.execPath,profileDirectory:path.join(directory,'profile'),leaseDirectory:path.join(directory,'leases'),timeoutMs:2000},workspaceForTask:()=>workspace}};
 const runtime=await startApplication(directory,options),store=runtime.store;let stopped=false;
 try{
  createProject(store,{id:'p',name:'合成标准应用退出',hostId:'synthetic',canonicalRoot:directory,objective:'精确停机边界'},Date.now());
  bootstrapRole(store,{projectId:'p',localRef:'lead',name:'负责人',charter:'合成',permissionProfileId:'team',permissionProfileRevision:1,expectedPolicyRevision:0,principalId:'synthetic-user',requestId:'lead'},Date.now());
  installSyntheticPolicy(store,'p',[{id:'team',revision:1,actions:['identity'],readPaths:[],writePaths:[],roleIds:[],delegableActions:[],maxDelegationDepth:0}]);
  if(route==='message')createRole(store,{id:'member',projectId:'p',name:'成员',charter:'合成章程',permissionProfileId:'team'},Date.now());
  const token=JSON.parse(fs.readFileSync(path.join(directory,'control-entry.json'))).token;let sid,id=0;
  const rpc=async(method,params,notification=false)=>{const frame={jsonrpc:'2.0',method,params};if(!notification)frame.id=++id;const response=await fetch(runtime.mcpEntrypoint.url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(sid?{'Mcp-Session-Id':sid}:{})},body:JSON.stringify(frame)});sid=response.headers.get('mcp-session-id')??sid;if(response.status===202)return null;const result=await response.json();assert.equal(result.error,undefined);assert.equal(result.result?.isError??false,false);return result.result;};
  await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'synthetic-app-stop',version:'1'}});await rpc('notifications/initialized',{},true);
  const roles=[{roleId:'member',harnessId:'codex',permissionProfileId:'team'}];if(route==='bootstrap'&&boundary==='within-deadline')roles.push({roleId:'future-member',harnessId:'codex',permissionProfileId:'team'});
  const reply=await rpc('tools/call',{name:route==='bootstrap'?'projectorch_project_bootstrap':'projectorch_message_send',arguments:route==='bootstrap'?{projectId:'p',objective:'合成',roles}:{projectId:'p',toRoleId:'member',harnessId:'codex',body:'合成测试',requestId:'original-message'}});
  const payload=JSON.parse(reply.content[0].text),operationId=payload.operationId;assert.ok(operationId);
  const until=Date.now()+5000;while(!fs.existsSync(path.join(workspace,'request-received'))&&Date.now()<until)await delay(3);assert.ok(fs.existsSync(path.join(workspace,'request-received')));
  await runtime.stop();stopped=true;
  const reopened=openStore(path.join(directory,'state.sqlite'));let before;
  try{before=readOperation(reopened,operationId);assert.equal(before.state,'unknown');assert.equal(unresolvedFactoryCapacity(reopened.db,'p','member').role,1);
   assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM roles WHERE id='future-member'").get().n,0,'停止后不开始登记下一角色，也不以其未发送错误覆盖原unknown');
   assert.equal(before.steps.some(s=>s.step.endsWith('create-thread')&&s.state==='observed'),boundary==='within-deadline');
   assert.equal(before.steps.some(s=>s.step==='observation-detached'),boundary==='after-deadline');
  }finally{reopened.close();}
  const next=await startApplication(directory,options);
  try{await settleFactoryOrchestrations(store);assert.deepEqual(readOperation(next.store,operationId).steps,before.steps);assert.equal(next.store.db.prepare("SELECT COUNT(*) AS n FROM role_bindings WHERE role_id='member'").get().n,0);}
  finally{await next.stop();}
  const methods=fs.readFileSync(path.join(workspace,'calls'),'utf8').trim().split('\n');assert.equal(methods.filter(m=>m==='thread/start').length,1);assert.equal(methods.filter(m=>m==='turn/start').length,0,'停止后章程不发送');
 }finally{if(!stopped)await runtime.stop();await settleFactoryOrchestrations(store);}
});

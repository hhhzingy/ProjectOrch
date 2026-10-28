// 合成官方通知，不启动官方Harness；不引用任何真实会话正文或账号信息。
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {CodexAdapter} from '../../apps/kernel/dist/adapters/codex-adapter.js';
import {CodexThreadFactory} from '../../apps/kernel/dist/execution/codex-supervisor.js';
import {NativeCompatibilityRegistry} from '../../apps/kernel/dist/native/compatibility.js';
import {openStore} from '../../packages/persistence/dist/index.js';
import {createProject} from '../../packages/domain/dist/projects/index.js';
import {createDurableOperation,recordStep,readOperation} from '../../apps/kernel/dist/tools/orchestration-tools.js';
import {safeExecutionDiagnostic} from '../../apps/kernel/dist/native/execution-diagnostics.js';
import {CodexCliExecutionDriver} from '../../apps/kernel/dist/execution/zcode-supervisor.js';
import {temporaryDirectory} from './temporary-directory.mjs';
const cwd=fileURLToPath(new URL('./fixtures/codex-managed/',import.meta.url));
for(const mode of ['usage-limit','private-failure'])test(`生产任务driver保留官方失败诊断且不猜测通用错误：${mode}`,async t=>{
 const dir=temporaryDirectory(t,'projectorch-codex-driver-error-'),registry=new NativeCompatibilityRegistry();
 const driver=new CodexCliExecutionDriver({harnessId:'codex',hostId:'synthetic',profileId:'test',nativeConversationId:'synthetic-thread'},dir,registry,{executable:process.execPath,cwd,env:{SYNTHETIC_MODE:mode},leaseDirectory:dir,timeoutMs:3000});
 registry.recordTrustedProbe({identity:driver.identity(),probeId:'synthetic-only',evidenceSha256:'b'.repeat(64),capabilities:{textInput:'verified',resume:'verified',historyRead:'verified'}});
 try{let observed;const receipt=await driver.start({spec:{goal:'synthetic'}},(_s,id)=>observed=id).result;
  assert.equal(receipt.status,'failed');assert.equal(receipt.terminalConfirmed,true);assert.equal(receipt.executionId,observed);
  if(mode==='usage-limit'){assert.equal(receipt.diagnostics.code,'CODEX_USAGE_LIMIT_EXCEEDED');assert.ok(Number.isSafeInteger(receipt.diagnostics.elapsedMs));}
  else assert.equal(receipt.diagnostics,undefined);
  assert.doesNotMatch(JSON.stringify(receipt),/SECRET|path\/account/);
 }finally{await driver.close();}
});
for(const mode of ['usage-limit','private-failure'])test(`官方turn/completed错误经生产adapter到工厂持久步骤：${mode}`,async t=>{
 const dir=temporaryDirectory(t,'projectorch-codex-error-'),log=path.join(dir,'calls.log'),registry=new NativeCompatibilityRegistry();
 const factory=new CodexThreadFactory({executable:process.execPath,cwd,env:{},leaseDirectory:dir,registry}),identity=factory.identity();
 registry.recordTrustedProbe({identity,probeId:'synthetic-notification-only',evidenceSha256:'a'.repeat(64),capabilities:{textInput:'verified',resume:'verified',historyRead:'verified'}});
 const adapter=new CodexAdapter({executable:process.execPath,cwd,env:{SYNTHETIC_MODE:mode,SYNTHETIC_LOG:log},leaseDirectory:dir,hostId:'synthetic',profileId:'test',compatibility:{registry,identity}});
 const store=openStore(path.join(dir,'state.sqlite'));createProject(store,{id:'p',name:'synthetic',hostId:'synthetic',canonicalRoot:dir,objective:'safe diagnostic only'},100);
 const {operationId}=createDurableOperation(store,{operationKey:'one',kind:'project.bootstrap',projectId:'p',payload:{}},110);let receipt;
 try{
  const wrapped={startThread:(...args)=>adapter.startThread(...args),runTurn:async(...args)=>{receipt=await adapter.runTurn(...args);return receipt;},close:()=>adapter.close()};
  await assert.rejects(factory.createThreadWithCharter({adapter:wrapped,charter:'synthetic',marker:'unused',hostId:'synthetic',profileId:'test',onStep:s=>recordStep(store,operationId,s,s.at)}),/FACTORY_TURN_FAILED/);
  assert.equal(receipt.status,'failed');assert.equal(adapter.phase,'idle');assert.equal(receipt.turnId,'turn-1');
  const first=readOperation(store,operationId),failed=first.steps.find(s=>s.step==='deliver-charter'&&s.state==='failed');assert.equal(first.state,'failed');
  if(mode==='usage-limit'){assert.equal(receipt.diagnostics.code,'CODEX_USAGE_LIMIT_EXCEEDED');assert.equal(JSON.parse(failed.detail).code,'CODEX_USAGE_LIMIT_EXCEEDED');}
  else{assert.equal(receipt.diagnostics,undefined);assert.equal(failed.detail,'TURN_FAILED');}
  // 后续unknown标签仍生效，但不能覆盖早先真实原因；本测试不改变partial状态机。
  recordStep(store,operationId,{step:'tool-entry-inject-failed',state:'unknown',detail:null,at:Date.now()},Date.now());
  const final=readOperation(store,operationId);assert.equal(final.state,'unknown');assert.deepEqual(final.steps.find(s=>s.step==='deliver-charter'&&s.state==='failed'),failed);
  assert.doesNotMatch(JSON.stringify({receipt,steps:final.steps}),/SECRET|path\/account/);
  assert.equal(fs.readFileSync(log,'utf8').split('\n').filter(l=>l==='turn/start').length,1,'仅一次发送，无自动重试');
 }finally{await adapter.close();store.close();}
});
test('新增额度枚举沿用诊断白名单，任意私密错误字段仍丢弃',()=>{
 assert.deepEqual(safeExecutionDiagnostic({code:'CODEX_USAGE_LIMIT_EXCEEDED',message:'SECRET',path:'SECRET',stack:'SECRET'}),{code:'CODEX_USAGE_LIMIT_EXCEEDED'});
 assert.deepEqual(safeExecutionDiagnostic({code:'usage_limit_exceeded SECRET',message:'usageLimitExceeded'}),{code:'NATIVE_EXECUTION_UNCERTAIN'});
});

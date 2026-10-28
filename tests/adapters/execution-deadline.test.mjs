import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';import {setImmediate as immediate} from 'node:timers/promises';
import {executionTimeout,rpcRequestTimeout} from '../../apps/kernel/dist/native/execution-timeout.js';
import {ZCodeTextProcess} from '../../apps/kernel/dist/native/zcode-text-process.js';
import {CodexAdapter,codexAdapterProtocol} from '../../apps/kernel/dist/adapters/codex-adapter.js';
import {ZcodeAdapter} from '../../apps/kernel/dist/adapters/zcode-adapter.js';
import {NativeCompatibilityRegistry} from '../../apps/kernel/dist/native/compatibility.js';
import {zcodeTextAdapterProtocol} from '../../apps/kernel/dist/native/verified-zcode-session.js';
import {StdioPeer} from '../../apps/kernel/dist/native/stdio-peer.js';
import {startApplication} from '../../apps/kernel/dist/lifecycle/application.js';
import {safeExecutionDiagnostic} from '../../apps/kernel/dist/native/execution-diagnostics.js';
import {temporaryDirectory} from './temporary-directory.mjs';
const worker=fileURLToPath(new URL('./zcode-cli-worker.mjs',import.meta.url)),cwd=fileURLToPath(new URL('./fixtures/codex-managed/',import.meta.url));
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function compatibility(harnessId,bundle){const registry=new NativeCompatibilityRegistry(),identity={harnessId,version:'synthetic-deadline',executableSha256:hash(process.execPath),bundleSha256:bundle?hash(bundle):null,adapterProtocol:bundle?zcodeTextAdapterProtocol:codexAdapterProtocol,route:bundle?'official_cli':'official_rpc'};registry.recordTrustedProbe({identity,probeId:'synthetic-only',evidenceSha256:'a'.repeat(64),capabilities:{textInput:'verified',resume:'verified',historyRead:'verified',nativeCancel:'verified'}});return {registry,identity};}
const realSetTimeout=globalThis.setTimeout;
async function until(predicate){const deadline=Date.now()+15000;while(Date.now()<deadline){if(predicate())return;await new Promise(r=>realSetTimeout(r,10));}throw Error('fixture did not reach required boundary');}
test('诊断拒绝任意错误正文/帧名/无效计量，仅保留安全白名单',()=>{
 const safe=safeExecutionDiagnostic({code:'SECRET',lastType:'SECRET',elapsedMs:NaN,frames:-1,stdoutBytes:Infinity,message:'SECRET',stderr:'SECRET'});
 assert.deepEqual(safe,{code:'NATIVE_EXECUTION_UNCERTAIN',lastType:'unknown'});assert.equal(JSON.stringify(safe).includes('SECRET'),false);
});
test('执行期限15分钟默认/30分钟上界与旧显式240秒；RPC独立封顶60秒',()=>{
 assert.equal(executionTimeout({}),900000);assert.equal(executionTimeout({timeoutMs:240000}),240000);assert.equal(executionTimeout({executionTimeoutMs:1800000}),1800000);
 assert.equal(rpcRequestTimeout(undefined),20000);assert.equal(rpcRequestTimeout(60000),60000);
 for(const options of [{timeoutMs:1800001},{executionTimeoutMs:0},{executionTimeoutMs:NaN},{timeoutMs:'240000'},{timeoutMs:240000,executionTimeoutMs:900000}])assert.throws(()=>executionTimeout(options));
 assert.throws(()=>rpcRequestTimeout(60001),/INVALID_RPC_TIMEOUT/);
 assert.throws(()=>new StdioPeer({executable:process.execPath,args:[],cwd,env:{},timeoutMs:60001}),/INVALID_TRANSPORT_LIMIT/);
});
test('启动配置在目录/进程/输入之前校验，无效执行或RPC期限不产生数据目录',async t=>{
 const base=temporaryDirectory(t,'projectorch-deadline-config-');
 for(const config of [{executionTimeoutMs:1800001},{timeoutMs:240000,executionTimeoutMs:900000},{rpcTimeoutMs:60001}]){
  const directory=path.join(base,'not-created');await assert.rejects(startApplication(directory,{native:{codex:{executable:'not-invoked',profileDirectory:base,leaseDirectory:base,...config}}}));assert.equal(fs.existsSync(directory),false);
 }
});
test('ZCode生产适配器实际接收大于旧300秒配置并正常回执',async t=>{
 const dir=temporaryDirectory(t,'projectorch-long-zcode-'),ref={harnessId:'zcode',hostId:'synthetic',profileId:'synthetic',nativeConversationId:'synthetic-existing'};
 const adapter=new ZcodeAdapter({executable:process.execPath,bundle:worker,cwd:dir,env:{},leaseDirectory:dir,executionTimeoutMs:900000,compatibility:compatibility('zcode',worker)},ref);
 try{assert.equal((await adapter.runTurn('LONG_CONFIG_OK','LONG_CONFIG_OK')).status,'completed');}finally{adapter.close();}
});
for(const duration of [240000,900000])test(`ZCode受控进程：${duration}前不终止，到期限才unknown，不能重发`,async t=>{
 const dir=temporaryDirectory(t,'projectorch-deadline-clock-');const bundle=path.join(dir,'controlled.cjs');fs.writeFileSync(bundle,`console.log(JSON.stringify({type:'turn.started',sessionId:'synthetic-existing',turnId:'exact-turn'}));setInterval(()=>{},1000);`);
 t.mock.timers.enable({apis:['setTimeout']});
 const runner=new ZCodeTextProcess({executable:process.execPath,bundle,cwd:dir,env:{},executionTimeoutMs:duration});const pending=runner.execute('work','synthetic-existing');
 const settled=pending.then(value=>({value}),error=>({error}));
 t.after(async()=>{if(runner.phase==='running')runner.requestOwnedProcessTermination(runner.snapshot.processEpoch);t.mock.timers.reset();await settled;});
 await until(()=>runner.snapshot.nativeTurnId==='exact-turn');t.mock.timers.tick(duration-1);assert.equal(runner.phase,'running');assert.equal(runner.snapshot.exitConfirmed,false);
 t.mock.timers.tick(1);const {error}=await settled;assert.equal(error.code,'CLI_TIMEOUT');assert.equal(error.delivery,'uncertain');assert.equal(runner.phase,'unknown');assert.equal(runner.snapshot.nativeTurnId,'exact-turn');assert.equal(runner.snapshot.exitConfirmed,true);
 await assert.rejects(runner.execute('no retry','synthetic-existing'),/CLI_OWNER_NOT_IDLE/);t.mock.timers.reset();
});
test('Codex长轮与RPC分离：超过300秒继续，到执行期限unknown且精确核验才解锁',async t=>{
 let adapter;t.after(()=>adapter?.close());
 const dir=temporaryDirectory(t,'projectorch-codex-deadline-'),log=path.join(dir,'requests.log');adapter=new CodexAdapter({executable:process.execPath,cwd,env:{SYNTHETIC_MODE:'reconcile',SYNTHETIC_LOG:log},executionTimeoutMs:900000,rpcTimeoutMs:1000,leaseDirectory:dir,hostId:'synthetic',profileId:'synthetic',compatibility:compatibility('codex',null)});
 await adapter.startThread();t.mock.timers.enable({apis:['setTimeout']});
 const pending=adapter.runTurn('one input','');await until(()=>adapter.execution.turnId==='turn-1');await immediate();
 t.mock.timers.tick(300001);assert.equal(adapter.phase,'running');t.mock.timers.tick(599998);assert.equal(adapter.phase,'running');t.mock.timers.tick(1);
 const receipt=await pending;assert.equal(receipt.status,'unknown');assert.equal(receipt.diagnostics.code,'EXECUTION_DEADLINE_REACHED');await assert.rejects(adapter.runTurn('no retry',''),/ADAPTER_OWNER_NOT_IDLE/);
 t.mock.timers.reset();assert.equal((await adapter.reconcileTurn()).status,'completed');
 assert.equal(fs.readFileSync(log,'utf8').split('\n').filter(x=>x==='turn/start').length,1);
});

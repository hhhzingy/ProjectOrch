import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {openStore} from '../../../packages/persistence/dist/index.js';
import {createProject} from '../../../packages/domain/dist/projects/index.js';
import {createRole} from '../../../packages/domain/dist/roles/index.js';
import {pathMatches,templateInside,isWellFormedPathTemplate} from '../../../packages/domain/dist/policy/index.js';
import {roleCodexSandbox} from '../../../apps/kernel/dist/native/codex-sandbox.js';
import {CodexAdapter} from '../../../apps/kernel/dist/adapters/codex-adapter.js';
import {NativeCompatibilityRegistry} from '../../../apps/kernel/dist/native/compatibility.js';
import {StdioPeer} from '../../../apps/kernel/dist/native/stdio-peer.js';
import {NativeRpcError} from '../../../apps/kernel/dist/native/stdio-peer.js';
import {CodexCliExecutionDriver} from '../../../apps/kernel/dist/execution/zcode-supervisor.js';
import {temporaryDirectory} from '../../adapters/temporary-directory.mjs';
import {installSyntheticPolicy} from './synthetic-policy.mjs';

test('递归授权必须显式，旧单段模板和委派均不能扩大',()=>{
 assert.equal(pathMatches(['*'],'a/b'),false);assert.equal(pathMatches(['**'],'a/b'),true);
 assert.equal(pathMatches(['work/**'],'work/a/b'),true);assert.equal(pathMatches(['work/**'],'other/a'),false);
 assert.equal(isWellFormedPathTemplate('a/**/b'),false);assert.equal(isWellFormedPathTemplate('a/**'),true);
 for(const [parent,child,expected] of [[['**'],['work/**'],true],[['work/*'],['work/**'],false],[['work/**'],['work/a/**'],true],[['work/a/**'],['work/**'],false],[['work/**'],['other/**'],false]])assert.equal(templateInside(parent,child),expected);
});
test('持久角色授权：只读/可写并存、路径范围、撤权、暂停和junction',t=>{
 let store;t.after(()=>store?.close());const dir=temporaryDirectory(t,'projectorch-sandbox-policy-');store=openStore(path.join(dir,'state.sqlite'));
 const workspace=path.join(dir,'work');fs.mkdirSync(workspace);
 createProject(store,{id:'p',name:'synthetic',hostId:'local',canonicalRoot:dir,objective:'授权测试'},1);
 const profile=(id,writes)=>({id,revision:1,actions:['identity'],readPaths:['**'],writePaths:writes,roleIds:[],delegableActions:[],maxDelegationDepth:0});
 for(const [id,writes] of [['writer',['work/**']],['reader',[]]])createRole(store,{id,projectId:'p',name:id,charter:'test',permissionProfileId:id},2);
 const install=(writes=['work/**'])=>installSyntheticPolicy(store,'p',[profile('writer',writes),profile('reader',[])]);install();
 assert.deepEqual(roleCodexSandbox(store,'p','reader',workspace),{type:'readOnly',networkAccess:false});
 const grant=roleCodexSandbox(store,'p','writer',workspace);assert.equal(grant.type,'workspaceWrite');assert.deepEqual(grant.writableRoots,[fs.realpathSync.native(workspace)]);assert.equal(grant.excludeTmpdirEnvVar,true);assert.equal(grant.excludeSlashTmp,true);
 assert.throws(()=>roleCodexSandbox(store,'p','writer',path.dirname(dir)),/OUTSIDE_PROJECT/);
 store.db.prepare('UPDATE roles SET scope_paths_json=? WHERE id=?').run(JSON.stringify(['other/**']),'writer');assert.throws(()=>roleCodexSandbox(store,'p','writer',workspace),/RECURSIVE_GRANT_REQUIRED/);
 store.db.prepare('UPDATE roles SET scope_paths_json=? WHERE id=?').run('[]','writer');
 install(['work/*']);assert.throws(()=>roleCodexSandbox(store,'p','writer',workspace),/RECURSIVE_GRANT_REQUIRED/);
 install([]);assert.equal(roleCodexSandbox(store,'p','writer',workspace).type,'readOnly');
 store.db.exec('UPDATE projects SET user_paused=1');assert.throws(()=>roleCodexSandbox(store,'p','reader',workspace),/ROLE_NOT_ENABLED/);store.db.exec('UPDATE projects SET user_paused=0');
 const link=path.join(dir,'link');fs.symlinkSync(workspace,link,process.platform==='win32'?'junction':'dir');try{assert.throws(()=>roleCodexSandbox(store,'p','reader',link),/IDENTITY_CHANGED/);}finally{fs.unlinkSync(link);}
});

function adapter(t,mode,policy){
 let a;t.after(()=>a?.close());
 const dir=temporaryDirectory(t,'projectorch-sandbox-adapter-'),frames=path.join(dir,'frames'),registry=new NativeCompatibilityRegistry();
 const identity={harnessId:'codex',version:'synthetic-only',executableSha256:createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),bundleSha256:null,adapterProtocol:'codex-app-server-jsonl-v2',route:'official_rpc'};
 registry.recordTrustedProbe({identity,probeId:'synthetic-only',evidenceSha256:'a'.repeat(64),capabilities:{resume:'verified',textInput:'verified'}});
 a=new CodexAdapter({executable:process.execPath,cwd:fileURLToPath(new URL('../../adapters/fixtures/codex-managed/',import.meta.url)),env:{SYNTHETIC_MODE:mode,SYNTHETIC_FRAMES:frames},timeoutMs:3000,leaseDirectory:dir,hostId:'synthetic',profileId:'synthetic',sandboxPolicy:policy,compatibility:{registry,identity}});
 return {a,frames};
}
const ro={type:'readOnly',networkAccess:false},rw={type:'workspaceWrite',writableRoots:[fileURLToPath(new URL('../../adapters/fixtures/codex-managed/',import.meta.url))],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true};
test('两个适配器并行执行权限独立，恢复不继承历史可写，后续降权生效',async t=>{
 let policy=rw;const writer=adapter(t,'complete',()=>policy),reader=adapter(t,'complete',()=>ro);
 await Promise.all([writer.a.resumeThread('synthetic-thread'),reader.a.resumeThread('synthetic-thread')]);
 await Promise.all([writer.a.runTurn('write',''),reader.a.runTurn('read','')]);policy=ro;await writer.a.runTurn('downgraded','');
 const requests=file=>fs.readFileSync(file,'utf8').trim().split('\n').map(x=>JSON.parse(x));
 const w=requests(writer.frames),r=requests(reader.frames);
 assert.equal(w.find(x=>x.method==='thread/resume').params.sandbox,'read-only');
 assert.deepEqual(w.find(x=>x.method==='thread/resume').params.runtimeWorkspaceRoots,rw.writableRoots);
 assert.deepEqual(w.filter(x=>x.method==='turn/start').map(x=>x.params.sandboxPolicy),[rw,ro]);
 assert.deepEqual(r.find(x=>x.method==='turn/start').params.sandboxPolicy,ro);
 assert.equal(r.find(x=>x.method==='turn/start').params.approvalPolicy,'never');
});
test('实际发送边界重新核对授权，撤权竞争不发送输入',async t=>{
 let policy=rw;const {a,frames}=adapter(t,'complete',()=>policy);await a.resumeThread('synthetic-thread');
 const original=StdioPeer.prototype.request;
 try{StdioPeer.prototype.request=async function(method,params,guard){if(method==='turn/start')policy=ro;return original.call(this,method,params,guard);};
 await assert.rejects(a.runTurn('never sent',''),/AUTHORIZATION_CHANGED/);assert.equal(a.phase,'idle');
 assert.equal(fs.readFileSync(frames,'utf8').includes('turn/start'),false);
 }finally{StdioPeer.prototype.request=original;}
});
test('原生未确认只读配置不发送模型输入；创建参数不能扩权',async t=>{
 const bad=adapter(t,'unsafe-sandbox',()=>rw);await assert.rejects(bad.a.startThread(),/SANDBOX_NOT_CONFIRMED/);assert.equal(fs.readFileSync(bad.frames,'utf8').includes('turn/start'),false);
 const injected=adapter(t,'complete',()=>ro);await assert.rejects(injected.a.startThread({sandbox:'danger-full-access'}),/UNTRUSTED_THREAD_OPTIONS/);
});
test('隐含 cwd 必须获准，不能仅用另一个目录的 writableRoots 冒充隔离',async t=>{
 const {a}=adapter(t,'complete',()=>({...rw,writableRoots:[path.dirname(rw.writableRoots[0])]}));
 await assert.rejects(a.startThread(),/CWD_NOT_AUTHORIZED/);assert.equal(a.phase,'disconnected');
});
test('任务驱动明确未发送的权限失败可重新授权后执行，不遗留 unknown/owner',async t=>{
 let driver;t.after(()=>driver?.close());const dir=temporaryDirectory(t,'projectorch-sandbox-driver-'),frames=path.join(dir,'frames');let denied=true;
 driver=new CodexCliExecutionDriver({harnessId:'codex',hostId:'synthetic',profileId:'test',nativeConversationId:'synthetic-thread'},dir,new NativeCompatibilityRegistry(),{executable:process.execPath,cwd:fileURLToPath(new URL('../../adapters/fixtures/codex-managed/',import.meta.url)),env:{SYNTHETIC_MODE:'complete',SYNTHETIC_FRAMES:frames},leaseDirectory:dir,timeoutMs:3000,sandboxPolicy:()=>{if(denied)throw new NativeRpcError('CODEX_SANDBOX_PROFILE_CONFLICT','not_sent');return ro;}});
 await assert.rejects(driver.start({spec:{goal:'synthetic'}},()=>{}).result,/CODEX_SANDBOX_PROFILE_CONFLICT/);assert.equal(fs.existsSync(frames),false);
 denied=false;const result=await driver.start({spec:{goal:'synthetic'}},()=>{}).result;assert.equal(result.executionId,'turn-1');
 assert.equal(fs.readFileSync(frames,'utf8').split('\n').filter(l=>l.includes('"method":"turn/start"')).length,1);
});

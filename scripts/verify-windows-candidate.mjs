/** 在当前Windows普通用户下解压实际候选并用包内运行时检查；不冒充干净OS验收。 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {unzipSync} from 'fflate';
import {verifyWindowsCandidate} from './build-windows-candidate.mjs';

const ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
async function bounded(promise,ms=15000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('CANDIDATE_CHECK_TIMEOUT')),ms);})]);}finally{clearTimeout(timer);}}
export async function verifyInstalledCandidate(filename){
 const bytes=fs.readFileSync(filename),sha256=createHash('sha256').update(bytes).digest('hex');assert.deepEqual(verifyWindowsCandidate(bytes),[]);
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'projectorch candidate ')),install=path.join(parent,'install with spaces'),data=path.join(parent,'user data'),project=path.join(parent,'project source');fs.mkdirSync(install);fs.mkdirSync(project);
 const report={scope:'actual ZIP on development Windows user; isolated PATH and data; NOT clean Windows acceptance',sha256,node:process.version,platform:process.platform,architecture:process.arch,checks:[],status:'INCOMPLETE',nativeInputs:0};let child;
 const entries=unzipSync(bytes);
 try{
  for(const [name,content] of Object.entries(entries)){const target=path.join(install,...name.split('/'));fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content,{flag:'wx'});}
  const app=path.join(install,'ProjectOrch'),node=path.join(app,'runtime/node.exe'),entry=path.join(app,'apps/kernel/dist/main.js');
  const env={PATH:'',TEMP:parent,TMP:parent,LOCALAPPDATA:path.join(parent,'local app data'),SystemRoot:process.env.SystemRoot??'C:\\Windows'};
  const check=(args)=>{const r=spawnSync(node,[entry,...args],{cwd:parent,env,encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(r.status,0,r.stderr);return r;};
  check(['--help']);report.checks.push('bundled runtime help with empty PATH');
  check(['--check','--data-dir',data]);report.checks.push('first startup and migration');
  const start=async()=>{
   child=spawn(node,[entry,'--data-dir',data],{cwd:parent,env,stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});const exited=once(child,'exit');let output='',errorOutput='';
   child.stderr.on('data',b=>{errorOutput+=b;if(errorOutput.length>65536)child.kill();});
   const ready=await bounded(new Promise((resolve,reject)=>{
    child.once('error',reject);child.once('exit',()=>reject(Error('CANDIDATE_EXITED_EARLY')));
    child.stdout.on('data',b=>{
     output+=b;if(output.length>65536)return reject(Error('CANDIDATE_OUTPUT_LIMIT'));
     if(output.includes('\n')){try{resolve(JSON.parse(output.split('\n')[0]));}catch{reject(Error('CANDIDATE_INVALID_READY'));}}
    });
   }));
   assert.equal(ready.status,'ready');assert.match(ready.origin,/^http:\/\/127\.0\.0\.1:\d+$/);
   return {ready,exited,output:()=>output,errorOutput:()=>errorOutput};
  };
  const pair=async runtime=>{const reply=bounded(once(child,'message'));child.send({type:'pair'});const [challenge]=await reply;const res=await fetch(runtime.ready.origin+'/api/v1/pairing',{method:'POST',headers:{Origin:runtime.ready.origin,'Content-Type':'application/json'},body:JSON.stringify({schemaVersion:2,requestId:randomUUID(),challengeId:challenge.challengeId,oneTimeCode:challenge.oneTimeCode})});assert.equal(res.status,200);const {csrfToken}=await res.json();assert.equal(runtime.output().includes(challenge.oneTimeCode),false);assert.equal(runtime.errorOutput().includes(challenge.oneTimeCode),false);return {Origin:runtime.ready.origin,Cookie:res.headers.get('set-cookie').split(';')[0],'Content-Type':'application/json','x-projectorch-csrf':csrfToken};};
  const stop=async runtime=>{child.send({type:'shutdown'});assert.equal((await bounded(runtime.exited))[0],0);child=null;};
  const first=await start();assert.equal((await fetch(first.ready.origin)).status,200);const headers=await pair(first);report.checks.push('web assets, IPC pairing and secret-free stdout');
  const duplicate=spawnSync(node,[entry,'--check','--data-dir',data],{cwd:parent,env,encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(duplicate.status,1);assert.match(duplicate.stderr,/KERNEL_ALREADY_RUNNING/);report.checks.push('second owner denied');
  const policy={id:'candidate-test',revision:0,profiles:[{id:'reader',revision:1,actions:['identity','project.read'],readPaths:[],writePaths:[],roleIds:[],delegableActions:[],maxDelegationDepth:0}],limits:{totalConcurrency:1,roleConcurrency:1,maxAttempts:2,maxCorrectionTurns:1,maxManagementRounds:1,maxDynamicRoles:0,wallTimeMs:10000,costCeiling:null,costEnforcement:'unavailable'},nativeMode:'disabled',writeIsolation:'exclusive_workspace'};
  const created=await fetch(first.ready.origin+'/api/v1/projects',{method:'POST',headers,body:JSON.stringify({schemaVersion:2,requestId:'candidate-project',hostId:os.hostname(),name:'candidate synthetic',rootPath:project,objective:'local ZIP verification',initialPolicy:policy})});assert.ok([200,201,202].includes(created.status));const projectReceipt=await created.json();assert.equal(projectReceipt.status,'completed');
  const catalogResponse=await fetch(first.ready.origin+'/api/v1/check-entries',{headers});assert.equal(catalogResponse.status,200);const checkEntry=(await catalogResponse.json()).entries[0];
  for(const [index,filename] of ['apps/kernel/dist/checks/validators.js','node_modules/@projectorch/domain/dist/policy/index.js','node_modules/@projectorch/persistence/dist/outbox/index.js','node_modules/@projectorch/persistence/dist/outbox/json.js'].entries())assert.equal(checkEntry.entryManifest[index].sha256,createHash('sha256').update(entries['ProjectOrch/'+filename]).digest('hex'));
  const definition={id:'private-package-check',version:'1',runner:checkEntry.runner,entryId:checkEntry.entryId,entrySha256:checkEntry.entrySha256,parameterSchemaId:checkEntry.parameterSchemaId,permissions:checkEntry.permissions,scopePaths:['source/*'],timeoutMs:5000,enabled:true};
  const registered=await fetch(first.ready.origin+'/api/v1/commands',{method:'POST',headers,body:JSON.stringify({schemaVersion:2,requestId:'candidate-check-register',projectId:projectReceipt.projectId,type:'check.register',payload:{definition}})});assert.equal(registered.status,200);assert.equal((await registered.json()).status,'completed');report.checks.push('installed trusted check bundle resolves packaged dependencies and authenticated registration');
  await stop(first);report.checks.push('graceful stop');
  const second=await start(),readHeaders=await pair(second);const overview=await fetch(second.ready.origin+'/api/v1/overview',{headers:readHeaders});assert.equal(overview.status,200);const state=await overview.json();assert.ok(state.projects.some(p=>p.projectId===projectReceipt.projectId));const checkRead=await fetch(second.ready.origin+'/api/v1/checks/private-package-check?projectId='+projectReceipt.projectId+'&version=1',{headers:readHeaders});assert.equal(checkRead.status,200);assert.deepEqual(await checkRead.json(),definition);await stop(second);report.checks.push('restart retains API-created project and trusted check definition');
  assert.ok(fs.existsSync(path.join(data,'state.sqlite')));fs.writeFileSync(path.join(project,'user-asset.txt'),'synthetic user asset');
  // 仅删除本函数新建并验证边界的安装目录；项目和数据在目录外。
  const resolved=fs.realpathSync(install);assert.equal(resolved,path.join(fs.realpathSync(parent),'install with spaces'));fs.rmSync(resolved,{recursive:true});
  assert.ok(fs.existsSync(path.join(data,'state.sqlite')));assert.equal(fs.readFileSync(path.join(project,'user-asset.txt'),'utf8'),'synthetic user asset');report.checks.push('uninstall removes only owned installation, preserves external data and project');
  report.status='LOCAL_PACKAGE_SMOKE_PASS';return report;
 }finally{
  if(child){child.kill();await bounded(once(child,'exit'),8000).catch(()=>{});}
  // 全部内容均由本函数创建；不接受外部传入的清理目录，不遍历链接。
  const resolved=fs.realpathSync(parent);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('projectorch candidate '));fs.rmSync(resolved,{recursive:true});
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length!==3)throw Error('EXPECTED_CANDIDATE_ZIP');
 const result=await verifyInstalledCandidate(path.resolve(process.argv[2]));const out=path.join(ROOT,'reports/release');fs.mkdirSync(out,{recursive:true});const name='windows-local-'+result.sha256.slice(0,16)+'.json';fs.writeFileSync(path.join(out,name),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}

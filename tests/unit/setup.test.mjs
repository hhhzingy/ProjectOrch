import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {runSetup} from '../../scripts/setup.mjs';import {temporaryDirectory} from '../adapters/temporary-directory.mjs';import {startApplication} from '../../apps/kernel/dist/lifecycle/application.js';
function fixture(t){const dir=temporaryDirectory(t,'projectorch-setup-'),root=path.join(dir,'软件 空格'),data=path.join(dir,'数据 空格');fs.mkdirSync(root,{recursive:true});for(const name of ['apps/kernel/dist/main.js','apps/web/dist/index.html','scripts/mcp-control-bridge.mjs']){const p=path.join(root,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,'synthetic');}return{dir,root,data};}
const save=(data,raw)=>{fs.mkdirSync(data,{recursive:true});fs.writeFileSync(path.join(data,'native-config.json'),JSON.stringify(raw));};
test('配置工具首次创建可复用登录的无密钥配置，含中文空格；再次创建不覆盖',async t=>{
 const f=fixture(t),bundle=path.join(f.dir,'zcode.cjs');fs.writeFileSync(bundle,'synthetic');
 const args=['init','--data-dir',f.data,'--codex-executable',process.execPath,'--share-codex-login','--zcode-bundle',bundle,'--zcode-account-provider','account:bigmodel-individual-coding-plan'];
 const result=await runSetup(args,{root:f.root});assert.equal(result.exitCode,0);const file=path.join(f.data,'native-config.json'),before=fs.readFileSync(file);assert.equal(JSON.parse(before).codex.sharedLogin,true);assert.equal(JSON.parse(before).zcode.executable,process.execPath);
 await assert.rejects(runSetup(args,{root:f.root}),/CONFIG_EXISTS_NOT_OVERWRITTEN/);assert.deepEqual(fs.readFileSync(file),before);
 const checked=await runSetup(['check','--data-dir',f.data,'--probe-native'],{root:f.root});assert.equal(checked.exitCode,2,'故意的非CLI bundle不能冒充原生通过');assert.equal(checked.report.nativeModelInputs,0);
});
test('静态通过只表示配置可读，不把登录/模型/真实协作写成通过；无文件改动',async t=>{
 const f=fixture(t);save(f.data,{codex:{executable:process.execPath,sharedLogin:true}});const file=path.join(f.data,'native-config.json'),before=fs.readFileSync(file);const checked=await runSetup(['check','--data-dir',f.data],{root:f.root});assert.equal(checked.exitCode,0);assert.equal(checked.report.checks.find(c=>c.code==='ACCOUNT_AND_MODEL_ACCESS').status,'NOT_VERIFIED');assert.equal(checked.report.nativeSessionsCreated,0);assert.deepEqual(fs.readFileSync(file),before);
});
test('缺失路径、占位、超时冲突、Start Plan错误映射以及未知字段明确拒绝',async t=>{
 const f=fixture(t);
 for(const raw of [{codex:{executable:'<codex.exe>'}},{codex:{executable:process.execPath,executionTimeoutMs:1,timeoutMs:2}},{codex:{executable:process.execPath,rpcTimeoutMs:60001}},{zcode:{executable:process.execPath,bundle:process.execPath},zcodeEnv:{PROJECTORCH_ZCODE_ACCOUNT_PROVIDER:'account:start-plan'}},{codex:{executable:process.execPath,unknown:'value'}}]){save(f.data,raw);assert.equal((await runSetup(['check','--data-dir',f.data],{root:f.root})).exitCode,2);}
});
test('不接受内嵌认证，错误不会回显私密值；auth文件和硬链接在读取前拒绝',async t=>{
 const f=fixture(t),privateValue='SYNTHETIC_PRIVATE_VALUE_DO_NOT_ECHO';save(f.data,{codex:{executable:process.execPath,apiKey:privateValue}});
 const report=await runSetup(['check','--data-dir',f.data,'--probe-native'],{root:f.root});assert.equal(report.exitCode,2);assert.doesNotMatch(JSON.stringify(report),new RegExp(privateValue));assert.equal(report.report.checks.find(c=>c.code==='NATIVE_CONFIG').details.code,'INLINE_AUTHENTICATION_FORBIDDEN');
 const auth=path.join(f.dir,'auth.json');fs.writeFileSync(auth,'invalid-auth-sentinel');const check=await runSetup(['check','--native',auth,'--data-dir',f.data],{root:f.root});assert.equal(check.report.checks.find(c=>c.code==='NATIVE_CONFIG').details.code,'NATIVE_CONFIG_FILENAME_REQUIRED');assert.doesNotMatch(JSON.stringify(check),/invalid-auth-sentinel/);
 fs.unlinkSync(path.join(f.data,'native-config.json'));fs.linkSync(auth,path.join(f.data,'native-config.json'));assert.equal((await runSetup(['check','--data-dir',f.data],{root:f.root})).exitCode,2);fs.unlinkSync(path.join(f.data,'native-config.json'));
});
test('格式错误、BOM和缺失文件保持失败，解析异常不输出原始文本',async t=>{
 const f=fixture(t);assert.equal((await runSetup(['check','--data-dir',f.data],{root:f.root})).exitCode,2);fs.mkdirSync(f.data);
 for(const value of ['SYNTHETIC_PRIVATE_TEXT','\ufeff{}']){fs.writeFileSync(path.join(f.data,'native-config.json'),value);const r=await runSetup(['check','--data-dir',f.data],{root:f.root});assert.equal(r.exitCode,2);assert.doesNotMatch(JSON.stringify(r),/SYNTHETIC_PRIVATE_TEXT/);}
});
test('MCP片段使用当前安装/数据目录，原配置不被修改，不含固定端口或密钥',async t=>{
 const f=fixture(t);
 for(const format of ['codex','zcode','zcode-ui']){const r=await runSetup(['mcp-config','--format',format,'--data-dir',f.data],{root:f.root});assert.equal(r.report.configurationFilesModified,false);assert.deepEqual(r.report.entry.args,[path.join(f.root,'scripts/mcp-control-bridge.mjs'),'--data-dir',f.data]);assert.doesNotMatch(r.output,/Bearer|Authorization|127\.0\.0\.1/);if(format==='zcode')assert.equal(JSON.parse(r.output).mcp.servers.projectorch.command,process.execPath);}
 assert.equal(fs.existsSync(f.data),false);
});
test('有限目录发现只找入口文件，不读取账户/供应商内容，不执行程序',async t=>{
 const f=fixture(t),local=path.join(f.dir,'local'),install=path.join(f.dir,'ZCode');const exe=path.join(local,'OpenAI/Codex/bin/version/codex.exe'),bundle=path.join(install,'resources/glm/zcode.cjs');for(const p of [exe,bundle]){fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,'SYNTHETIC_DO_NOT_EXECUTE');}
 const r=await runSetup(['discover','--zcode-install-dir',install],{root:f.root,env:{LOCALAPPDATA:local}});assert.deepEqual(r.report.codexExecutables,[exe]);assert.deepEqual(r.report.zcodeBundles,[bundle]);assert.doesNotMatch(JSON.stringify(r),/SYNTHETIC_DO_NOT_EXECUTE/);
});
test('未知/重复参数和非本地路径拒绝，未选择Harness时不生成文件',async t=>{
 const f=fixture(t);for(const args of [['init','--data-dir',f.data],['check','--probe-native','--probe-native'],['check','--data-dir','relative'],['check','--data-dir','//remote/share'],['init','--data-dir',f.data,'--zcode-account-provider','x'],['check','--force']])await assert.rejects(runSetup(args,{root:f.root}));assert.equal(fs.existsSync(f.data),false);
});
test('真实本机MCP控制身份探针零模型输入，停机后失败且不泄露控制码',async t=>{
 let app;t.after(()=>app?.stop());const f=fixture(t);save(f.data,{codex:{executable:process.execPath,sharedLogin:true}});app=await startApplication(f.data);
 const r=await runSetup(['check','--data-dir',f.data,'--probe-mcp'],{root:f.root});assert.equal(r.report.checks.find(c=>c.code==='LOCAL_MCP_IDENTITY').status,'PASS');assert.equal(r.report.nativeModelInputs,0);assert.doesNotMatch(JSON.stringify(r),/projectorch-control-/);
 await app.stop();app=null;const stopped=await runSetup(['check','--data-dir',f.data,'--probe-mcp'],{root:f.root});assert.equal(stopped.report.checks.find(c=>c.code==='LOCAL_MCP_IDENTITY').status,'FAIL');
});

import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {temporaryDirectory} from '../../adapters/temporary-directory.mjs';
import {prepareZcodeAccountProfile,usesZcodeAccountProfile,accountProviderEnv} from '../../../apps/kernel/dist/native/zcode-account-model-profile.js';
import {ZCodeTextProcess} from '../../../apps/kernel/dist/native/zcode-text-process.js';
const provider='account:bigmodel-individual-coding-plan',selection={modelId:'GLM-5.3-Flash',reasoningLevel:null};
function fixture(t){const dir=temporaryDirectory(t,'projectorch-account-model-'),builtin=path.join(dir,'zcode-builtin.json'),personal=path.join(dir,'never-read-personal.json');
 const doc={schemaVersion:1,config:{providerConfigRules:{providerRules:[provider,'account:zai-individual-coding-plan','account:bigmodel-start-plan'].map(providerId=>({providerId,config:{builtinModelIds:['GLM-5.3','GLM-5.3-Flash'],access:{type:'zhipu-account',mode:providerId.endsWith('start-plan')?'start-plan':'individual-coding-plan'}}}))}}};
 fs.writeFileSync(builtin,JSON.stringify(doc));fs.writeFileSync(personal,'not-json-user-secret-must-not-be-read');return {dir,builtin,doc,env:{[accountProviderEnv]:provider,ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:builtin,ZCODE_PERSONAL_PROVIDER_CONFIG_FILE:personal,ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE:builtin}};
}
test('账户模型用隔离配置：只保留明确供应商的指定模型；官方元数据和用户个人配置不改动',t=>{
 const f=fixture(t),before=fs.readFileSync(f.builtin),profile=prepareZcodeAccountProfile(f.env,f.dir,selection),p=JSON.parse(fs.readFileSync(profile.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE));
 assert.equal(usesZcodeAccountProfile(f.env,selection),true);assert.equal(profile.env.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE,undefined);assert.equal(profile.env[accountProviderEnv],undefined);
 assert.deepEqual(fs.readFileSync(profile.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE),before);
 assert.deepEqual(p.config.providerConfigRules.providerRules.filter(x=>x.enabled).map(x=>x.providerId),[provider]);assert.deepEqual(p.config.modelConfigRules.providerModelRules.filter(x=>x.config.enabled).map(x=>[x.providerId,x.modelId]),[[provider,selection.modelId]]);
 assert.equal(fs.readFileSync(f.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE,'utf8'),'not-json-user-secret-must-not-be-read');profile.assertCurrent();const owned=path.dirname(profile.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE);profile.cleanup();assert.equal(fs.existsSync(owned),false);assert.deepEqual(fs.readFileSync(f.builtin),before);
});
test('配置变更、未列模型、Start Plan及未核实推理等级都明确拒绝，不能回退',t=>{
 const f=fixture(t);for(const value of [{...selection,modelId:'missing'},{...selection,providerId:'account:bigmodel-start-plan'},{...selection,reasoningLevel:'high'}])assert.throws(()=>prepareZcodeAccountProfile(f.env,f.dir,value),e=>e.delivery==='not_sent');
 const p=prepareZcodeAccountProfile(f.env,f.dir,selection);fs.writeFileSync(p.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE,'{}');assert.throws(()=>p.assertCurrent(),/MODEL_PROFILE_CHANGED/);p.cleanup();
});
test('供应商必须明确，内置元数据含秘密字段拒绝且不生成副本',t=>{
 const f=fixture(t);assert.throws(()=>prepareZcodeAccountProfile({...f.env,[accountProviderEnv]:''},f.dir,selection),/MODEL_ACCOUNT_PROVIDER_REQUIRED/);f.doc.config.providerConfigRules.providerRules[0].config.apiKey='should-not-copy';fs.writeFileSync(f.builtin,JSON.stringify(f.doc));assert.throws(()=>prepareZcodeAccountProfile(f.env,f.dir,selection),/MODEL_BUILTIN_METADATA_INVALID/);assert.equal(fs.readdirSync(f.dir).some(x=>x.startsWith('zcode-model-')),false);
});
test('CLI创建及同ID续行都获得指定账户配置；关闭后清理自己的元数据，不加载用户自定义供应商',async t=>{
 const f=fixture(t),bundle=path.join(f.dir,'fixture.cjs'),log=path.join(f.dir,'observed.jsonl');fs.writeFileSync(bundle,`const fs=require('node:fs');const config=JSON.parse(fs.readFileSync(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE));fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({config,args:process.argv.slice(2),builtin:process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE})+'\\n');console.log(JSON.stringify({type:'result',sessionId:'sess_account',turnId:'turn_account',response:'OK',projection:{status:'idle',turnCount:1}}));`);
 for(const sid of [null,'sess_account']){const process=new ZCodeTextProcess({executable:globalThis.process.execPath,bundle,cwd:f.dir,env:f.env,modelSelection:()=>selection,modelProfileDirectory:f.dir});assert.equal((await process.execute('test',sid)).result.sessionId,'sess_account');}
 const records=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.equal(records.length,2);assert.equal(records[1].args.at(-1),'sess_account');for(const row of records){assert.equal(row.config.config.defaultModelSelection.modelId,selection.modelId);assert.equal(fs.existsSync(path.dirname(row.builtin)),false);}
});
test('原生输入前配置失败不会启动CLI，也不会报告成功',async t=>{
 const f=fixture(t),marker=path.join(f.dir,'must-not-exist'),bundle=path.join(f.dir,'fixture.cjs');fs.writeFileSync(bundle,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'sent')`);
 const process=new ZCodeTextProcess({executable:globalThis.process.execPath,bundle,cwd:f.dir,env:f.env,modelSelection:()=>({...selection,modelId:'missing'}),modelProfileDirectory:f.dir});await assert.rejects(process.execute('test',null),e=>e.delivery==='not_sent');assert.equal(fs.existsSync(marker),false);assert.equal(process.phase,'idle');
});

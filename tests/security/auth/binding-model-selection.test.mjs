import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {executionFixture} from './execution-fixture.mjs';
import {bindingModelSelection,bindingForSession} from '../../../apps/kernel/dist/execution/binding-model-selection.js';
import {setRoleModelPreference} from '../../../packages/domain/dist/roles/index.js';
import {ZcodeCliExecutionDriver} from '../../../apps/kernel/dist/execution/zcode-supervisor.js';
import {NativeCompatibilityRegistry} from '../../../apps/kernel/dist/native/compatibility.js';
import {NativeSessionLease} from '../../../apps/kernel/dist/native/session-lease.js';
import {NativeRpcError} from '../../../apps/kernel/dist/native/stdio-peer.js';
import {temporaryDirectory} from '../../adapters/temporary-directory.mjs';

test('严格偏好未解析时阻塞，精确会话范围取绑定，偏好不能由默认值代替',t=>{
 const f=executionFixture(t);assert.equal(bindingModelSelection(f.store,'binding'),null);assert.equal(bindingForSession(f.store,f.session),'binding');
 assert.throws(()=>bindingForSession(f.store,{...f.session,profileId:'other'}),/BINDING_NOT_FOUND/);
 setRoleModelPreference(f.store,'p','worker',{raw:'必须指定模型',recordedAt:200},null);
 assert.throws(()=>bindingModelSelection(f.store,'binding'),e=>e.delivery==='not_sent'&&e.message==='MODEL_SELECTION_UNRESOLVED');
 setRoleModelPreference(f.store,'p','worker',{raw:'精确模型',recordedAt:201},{modelId:'exact-model',reasoningLevel:'high',basis:'user-specified',resolvedAt:201});
 assert.deepEqual(bindingModelSelection(f.store,'binding'),{modelId:'exact-model',reasoningLevel:'high'});
});

test('ZCode异步模型配置失败或准备期间撤权后无CLI输入，精确租约释放',async t=>{
 const dir=temporaryDirectory(t,'projectorch-model-before-turn-'),bundle=path.join(dir,'synthetic.cjs'),log=path.join(dir,'model-input.log');
 fs.writeFileSync(bundle,`if(process.argv.includes('--version')){console.log('0.17.0-synthetic');process.exit(0);}require('fs').writeFileSync(${JSON.stringify(log)},'SENT');`);
 const session={harnessId:'zcode',hostId:'h',profileId:'p',nativeConversationId:'native'};
 for(const mode of ['config-rejected','revoked']){
   let release,reached,changed=false;const gate=new Promise(r=>release=r),ready=new Promise(r=>reached=r);
   const beforeTurn=async()=>{reached();await gate;if(mode==='config-rejected')throw new NativeRpcError('MODEL_SELECTION_UNAVAILABLE','not_sent');};
   const driver=new ZcodeCliExecutionDriver(session,dir,new NativeCompatibilityRegistry(),{executable:process.execPath,bundle,cwd:dir,env:{},leaseDirectory:dir,beforeTurn});
   const handle=driver.start({spec:{goal:'never send'}},()=>{},()=>{if(changed)throw new Error('REVOKED');});await ready;changed=mode==='revoked';release();
   await assert.rejects(handle.result,/MODEL_SELECTION_UNAVAILABLE|EXECUTION_ADMISSION_CHANGED/);assert.equal(fs.existsSync(log),false);
   const lease=NativeSessionLease.acquire(dir,session);lease.releaseAfterExit(true);driver.close();
 }
});

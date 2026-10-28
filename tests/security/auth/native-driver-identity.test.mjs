import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {temporaryDirectory} from '../../adapters/temporary-directory.mjs';
import {ZcodeCliExecutionDriver} from '../../../apps/kernel/dist/execution/zcode-supervisor.js';
import {NativeCompatibilityRegistry} from '../../../apps/kernel/dist/native/compatibility.js';
import {NativeSessionLease} from '../../../apps/kernel/dist/native/session-lease.js';

test('ZCode任务驱动只登记原生turn，持有精确owner到退出，另一个owner不能并发发送',async t=>{
  const root=temporaryDirectory(t,'projectorch-native-driver-id-');const bundle=path.join(root,'synthetic.cjs');
  fs.writeFileSync(bundle,`if(process.argv.includes('--version')){console.log('0.17.0-synthetic');process.exit(0);}
  console.log(JSON.stringify({type:'turn.started',sessionId:'session-owned',turnId:'native-turn-123'}));
  setTimeout(()=>console.log(JSON.stringify({type:'result',sessionId:'session-owned',turnId:'native-turn-123',isError:false,response:'done',projection:{status:'idle',turnCount:1}})),100);`);
  const session={harnessId:'zcode',hostId:'h',profileId:'p',nativeConversationId:'session-owned'};
  const driver=new ZcodeCliExecutionDriver(session,root,new NativeCompatibilityRegistry(),{executable:process.execPath,bundle,cwd:root,env:{},leaseDirectory:root,executionTimeoutMs:900000});
  let seen=null;const result=driver.start({spec:{goal:'synthetic'}},(_session,id)=>{
    seen=id;assert.equal(id,'native-turn-123');assert.throws(()=>NativeSessionLease.acquire(root,session),/OWNER_OCCUPIED/);
  });
  assert.equal(seen,null,'不能在start同步栈中伪报已执行');
  const receipt=await result.result;assert.equal(receipt.executionId,'native-turn-123');assert.equal(receipt.status,'completed');
  const next=NativeSessionLease.acquire(root,session);next.releaseAfterExit(true);driver.close();
});

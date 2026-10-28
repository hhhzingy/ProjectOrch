import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { startApplication } from '../../../apps/kernel/dist/lifecycle/application.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

test('应用装配在内核监听后失败，仍关闭监听并释放锁；同目录可立即重新启动', async t => {
  const dir=temporaryDirectory(t,'projectorch-app-cleanup-');
  const db=openStore(path.join(dir,'state.sqlite'));
  db.db.exec("CREATE TRIGGER reject_control_entry BEFORE INSERT ON control_entries BEGIN SELECT RAISE(ABORT,'APP_WIRING_FAILED'); END");
  db.close();
  await assert.rejects(startApplication(dir),/APP_WIRING_FAILED/);
  const repaired=openStore(path.join(dir,'state.sqlite'));
  assert.equal(repaired.db.prepare('SELECT holder FROM kernel_lock WHERE id=1').get().holder,'');
  repaired.db.exec('DROP TRIGGER reject_control_entry');repaired.close();
  const runtime=await startApplication(dir);
  try {
    assert.equal((await fetch(runtime.gateway.origin.origin)).status,200);
    assert.equal(runtime.workflowStatus().enabled,false);
  } finally { await runtime.stop(); }
  await runtime.stop();
});

test('仅配置Codex也装配任务工作流，不以ZCode环境为隐含前置',async t=>{
 const dir=temporaryDirectory(t,'projectorch-codex-only-');
 const runtime=await startApplication(dir,{native:{codex:{executable:process.execPath,profileDirectory:path.join(dir,'profile'),leaseDirectory:path.join(dir,'nested','leases')},workspaceForTask:()=>dir}});
 try{assert.equal(runtime.workflowStatus().enabled,true);assert.equal(runtime.workflowStatus().healthy,true);}finally{await runtime.stop();}
});

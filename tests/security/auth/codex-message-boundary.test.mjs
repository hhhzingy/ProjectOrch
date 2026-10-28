import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {CodexAdapter,codexAdapterProtocol} from '../../../apps/kernel/dist/adapters/codex-adapter.js';
import {StdioPeer,NativeRpcError} from '../../../apps/kernel/dist/native/stdio-peer.js';
import {NativeCompatibilityRegistry} from '../../../apps/kernel/dist/native/compatibility.js';
import {runCodexMessageTurn} from '../../../apps/kernel/dist/execution/codex-message-turn.js';
import {temporaryDirectory} from '../../adapters/temporary-directory.mjs';

test('消息生产接线：实际管道写入前暂停/撤权为not_sent且0帧，正常仅1帧',async t=>{
  const original=StdioPeer.prototype.request;
  try {
    for(const change of ['normal','pause','revoke']) await t.test(change,async inner=>{
      let adapter;
      inner.after(()=>adapter?.close());
      const dir=temporaryDirectory(inner,'projectorch-message-boundary-');
      const log=path.join(dir,'requests.log');
      const identity={harnessId:'codex',version:'synthetic-only',executableSha256:createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),bundleSha256:null,adapterProtocol:codexAdapterProtocol,route:'official_rpc'};
      const registry=new NativeCompatibilityRegistry();
      registry.recordTrustedProbe({identity,probeId:'synthetic-only',evidenceSha256:'a'.repeat(64),capabilities:{resume:'verified',textInput:'verified'}});
      adapter=new CodexAdapter({executable:process.execPath,cwd:fileURLToPath(new URL('../../adapters/fixtures/codex-managed/',import.meta.url)),env:{SYNTHETIC_MODE:'complete',SYNTHETIC_LOG:log},timeoutMs:3000,leaseDirectory:dir,hostId:'synthetic',profileId:'synthetic',compatibility:{registry,identity}});
      let reached,release;const pending=new Promise(r=>reached=r),gate=new Promise(r=>release=r);
      StdioPeer.prototype.request=async function(method,params,guard){if(method==='turn/start'){reached();await gate;}return original.call(this,method,params,guard);};
      let paused=false,revoked=false,checks=0;
      const guard=()=>{checks++;if(paused||revoked)throw new NativeRpcError(paused?'MESSAGE_ADMISSION_CHANGED':'MESSAGE_SENDER_REVOKED','not_sent');};
      const run=runCodexMessageTurn(adapter,'synthetic-thread','synthetic',3000,guard);
      await pending;
      assert.equal(checks,2,'恢复前后检查已通过，尚未到传输边界');
      paused=change==='pause';revoked=change==='revoke';release();
      if(change==='normal')assert.equal((await run).status,'completed');
      else await assert.rejects(run,e=>e instanceof NativeRpcError&&e.delivery==='not_sent');
      await adapter.close();
      const frames=fs.readFileSync(log,'utf8').split('\n').filter(x=>x==='turn/start');
      assert.equal(frames.length,change==='normal'?1:0);
      assert.equal(checks,3,'生产消息回调到达StdioPeer实际写入边界');
    });
  } finally {StdioPeer.prototype.request=original;}
});

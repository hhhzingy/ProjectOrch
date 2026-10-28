// 合成官方形状RPC子进程；不调用官方模型，不作为真实项目验收。
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {executionFixture} from './execution-fixture.mjs';
import {reserveNativeWriteWithin,activateNativeWriteWithin,finishNativeWriteWithin,reconcileInterruptedMessageWithin} from '../../../packages/domain/dist/workspaces/index.js';
import {claimForSending,markUncertainDelivery} from '../../../packages/domain/dist/messages/index.js';
import {recoverInterruptedCodexMessage} from '../../../apps/kernel/dist/execution/message-negative-recovery.js';
import {detectCodexIdentity} from '../../../apps/kernel/dist/execution/codex-supervisor.js';import {NativeCompatibilityRegistry} from '../../../apps/kernel/dist/native/compatibility.js';
import {mcpToolEntries,mcpToolDescription,mcpToolArguments} from '../../../apps/kernel/dist/tools/mcp-catalog.js';

function setup(t,status='interrupted'){
 const f=executionFixture(t),session={...f.session,harnessId:'codex',nativeWorkspaceId:f.driver.workspaceRoot};f.store.db.prepare("UPDATE sessions SET harness_id='codex',native_workspace_id=? WHERE id='session'").run(f.driver.workspaceRoot);
 f.store.db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('message-command','p','synthetic','message-request',?,'message.send','{}','completed',220)").run('0'.repeat(64));
 f.store.db.exec("INSERT INTO messages(id,project_id,command_id,to_role_id,kind,body,delivery_json,state,created_at) VALUES('message','p','message-command','worker','information','SYNTHETIC','{\"transitions\":[]}','queued',220)");
 const proof=f.store.transaction(()=>reserveNativeWriteWithin(f.store,{kind:'message',sourceId:'message',projectId:'p',roleId:'worker',bindingId:'binding',bindingEpoch:1,targetRoot:f.driver.workspaceRoot},230));
 claimForSending(f.store,'p','message',240,()=>activateNativeWriteWithin(f.store,proof,'message',240));
 const receipt={harnessId:'codex',nativeConversationId:session.nativeConversationId,nativeTurnId:'original-turn',status:'unknown',exitConfirmed:false};
 markUncertainDelivery(f.store,'p','message',receipt,250,()=>finishNativeWriteWithin(f.store,proof,'unknown',{sourceId:'message',receipt},250));
 const script=path.join(f.driver.workspaceRoot,'app-server');fs.writeFileSync(script,`const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);fs.appendFileSync('rpc-calls',q.method+'\\n');if(!q.id)return;const result=q.method==='thread/read'?{thread:{id:'synthetic-native',status:{type:'notLoaded'},turns:[{id:'original-turn',status:${JSON.stringify(status)}}]}}:{};console.log(JSON.stringify({id:q.id,result}));});`);
 const leaseDirectory=path.join(f.dir,'leases');fs.mkdirSync(leaseDirectory);const registry=new NativeCompatibilityRegistry(),identity={harnessId:'codex',...detectCodexIdentity(process.execPath),bundleSha256:null,adapterProtocol:'codex-app-server-jsonl-v2',route:'official_rpc'};registry.recordTrustedProbe({identity,probeId:'synthetic-only',evidenceSha256:'a'.repeat(64),capabilities:{historyRead:'verified'}});
 const services={executable:process.execPath,env:{SystemRoot:process.env.SystemRoot??''},leaseDirectory,registry,assertOwner:()=>{},now:()=>300},input={projectId:'p',messageId:'message',sessionRef:session,nativeTurnId:'original-turn',status:'interrupted',terminalConfirmed:true};
 return {...f,session,proof,input,services,recover:()=>recoverInterruptedCodexMessage(f.store,'p','message',services)};
}

for(const status of ['interrupted','failed'])test(`原${status}终态：消息失败/写效果结束/审计原子，原owner和unknown保留，重复不重发`,async t=>{
 const f=setup(t,status),before=f.store.db.prepare('SELECT owner_key,fence FROM native_write_effects').get();
 f.store.db.exec("UPDATE projects SET user_paused=1");const result=await f.recover();assert.equal(result.nativeStatus,status);assert.equal(result.state,'failed');
 assert.equal(f.store.db.prepare("SELECT state FROM messages WHERE id='message'").get().state,'failed');const effect=f.store.db.prepare('SELECT owner_key,fence,state FROM native_write_effects').get();assert.equal(effect.state,'settled');assert.equal(effect.owner_key,before.owner_key);assert.equal(effect.fence,before.fence);
 assert.ok(f.store.db.prepare("SELECT 1 FROM native_write_effect_observations WHERE state='unknown'").get());assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM events WHERE type='message.changed'").get().n,1);
 assert.equal((await f.recover()).replay,true);assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM events WHERE type='message.changed'").get().n,1);assert.equal(f.store.db.prepare('SELECT user_paused FROM projects').get().user_paused,1);
 assert.throws(()=>f.store.transaction(()=>finishNativeWriteWithin(f.store,f.proof,'terminal',{sourceId:'message',nativeConversationId:f.session.nativeConversationId,nativeExecutionId:'original-turn',terminalConfirmed:true},310)),/OWNER_OR_FENCE/,'旧回调不能覆盖已核对终态');
 assert.doesNotMatch(fs.readFileSync(path.join(f.driver.workspaceRoot,'rpc-calls'),'utf8'),/turn\/start|thread\/start|thread\/resume/);
});

for(const status of ['inProgress','completed'])test(`${status}不进入明确失败恢复分支`,async t=>{const f=setup(t,status);await assert.rejects(f.recover(),/NEGATIVE_TERMINAL_NOT_PROVEN/);assert.equal(f.store.db.prepare('SELECT state FROM native_write_effects').get().state,'unknown');});

test('审计失败整笔回滚；异步期间来源变化/owner失效不结算',async t=>{
 for(const mode of ['audit','source','owner'])await t.test(mode,async inner=>{
  const f=setup(inner);if(mode==='audit')f.store.db.exec("CREATE TRIGGER reject_recovery_audit BEFORE INSERT ON events WHEN NEW.type='message.changed' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_AUDIT_FAILURE'); END;");
  let checks=0;f.services.assertOwner=()=>{if(++checks===2){if(mode==='source')f.store.db.exec("UPDATE messages SET body='CHANGED' WHERE id='message'");if(mode==='owner')throw Error('OWNER_LOST');}};
  await assert.rejects(f.recover(),/AUDIT_FAILURE|SOURCE_CHANGED|OWNER_LOST/);assert.equal(f.store.db.prepare('SELECT state FROM native_write_effects').get().state,'unknown');assert.equal(f.store.db.prepare("SELECT state FROM messages WHERE id='message'").get().state,'uncertain');
 });
});

test('错原轮/完整会话/来源/旧绑定/历史unattributed全部阻断',t=>{
 for(const mode of ['turn','session','source','binding','unattributed']){
  const f=setup(t),input={...f.input,sessionRef:{...f.session}};
  if(mode==='turn')input.nativeTurnId='another-turn';if(mode==='session')input.sessionRef.profileId='wrong';if(mode==='source')f.store.db.exec("UPDATE messages SET body='changed' WHERE id='message'");if(mode==='binding')f.store.db.exec("UPDATE role_bindings SET ended_at=260 WHERE id='binding'");if(mode==='unattributed'){f.store.db.exec("UPDATE native_write_effects SET evidence_json=json_set(evidence_json,'$.unattributed',json('true'))");f.store.db.exec("UPDATE native_write_effects SET evidence_json=json_remove(evidence_json,'$.unattributed')");}
  assert.throws(()=>f.store.transaction(()=>reconcileInterruptedMessageWithin(f.store,input,300)),/REQUIRED|CHANGED/);assert.equal(f.store.db.prepare('SELECT state FROM native_write_effects').get().state,'unknown');
 }
});

test('并发重复核对只落一次终态与审计，CAS冲突可幂等再读',async t=>{
 const f=setup(t),results=await Promise.allSettled([f.recover(),f.recover()]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/SOURCE_CHANGED/);
 assert.equal((await f.recover()).replay,true);assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM events WHERE type='message.changed'").get().n,1);
});

test('管理描述的最小task.create示例通过当前完整Schema，不依赖MCP resources',()=>{
 const entry=mcpToolEntries.find(e=>e.tool==='management.apply_changes'),description=mcpToolDescription(entry).description,raw=description.slice(description.indexOf('{"requestId"'),description.indexOf('。真实项目'));
 assert.equal(mcpToolArguments(entry,JSON.parse(raw)).operations[0].type,'task.create');
});

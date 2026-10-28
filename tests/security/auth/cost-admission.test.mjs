import test from 'node:test';
import assert from 'node:assert/strict';
import {executionFixture} from './execution-fixture.mjs';
import {pumpMessageDelivery} from '../../../apps/kernel/dist/execution/message-delivery.js';
import {createDurableOperation} from '../../../apps/kernel/dist/tools/orchestration-tools.js';

test('未证明官方费用上限时任务准备与发送边界均拒绝，策略标签不冒充可执行硬限制',async t=>{
 for(const mode of ['unavailable','advisory','harness_enforced'])await t.test(mode,async inner=>{
  const f=executionFixture(inner);f.store.db.prepare("UPDATE projects SET policy_json=json_set(policy_json,'$.limits.costCeiling',1,'$.limits.costEnforcement',?)").run(mode);
  assert.throws(()=>f.prepare(),/COST_ENFORCEMENT_UNAVAILABLE/);assert.equal(f.calls,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n,0);
 });
 const f=executionFixture(t),id=f.prepare();f.store.db.exec("UPDATE projects SET policy_json=json_set(policy_json,'$.limits.costCeiling',1)");assert.equal(await f.coordinator.run(id),'cancelled');assert.equal(f.calls,0);assert.equal(f.reservation().state,'released');
});
test('费用上限未经验证时排队消息保留，不发送、不伪造delivered；显式解除上限后才可继续',async t=>{
 const f=executionFixture(t);f.store.db.prepare("UPDATE sessions SET native_workspace_id=? WHERE id='session'").run(f.driver.workspaceRoot);const op=createDurableOperation(f.store,{operationKey:'cost-message',kind:'message.send',projectId:'p',payload:{}},300);
 f.store.transaction(db=>{db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('cost-message-command','p','synthetic-user',?,?,'message.send','{}','completed',300)").run(op.operationId,'a'.repeat(64));db.prepare("INSERT INTO messages(id,project_id,command_id,to_role_id,kind,body,delivery_json,state,created_at) VALUES('cost-message','p','cost-message-command','worker','information','synthetic','{\"transitions\":[]}','queued',300)").run();db.prepare("UPDATE projects SET policy_json=json_set(policy_json,'$.limits.costCeiling',1)").run();});
 let calls=0;const services={now:()=>1000,runInBinding:async(_binding,target,_body,guard)=>{guard();calls++;return {harnessId:'zcode',nativeConversationId:target.nativeConversationId,nativeTurnId:'synthetic-turn',status:'completed',responseText:'synthetic',exitConfirmed:true};}};
 await pumpMessageDelivery(f.store,services);assert.equal(calls,0);assert.equal(f.store.db.prepare("SELECT state FROM messages WHERE id='cost-message'").get().state,'queued');
 f.store.db.exec("UPDATE projects SET policy_json=json_set(policy_json,'$.limits.costCeiling',NULL)");await pumpMessageDelivery(f.store,services);assert.equal(calls,1);assert.equal(f.store.db.prepare("SELECT state FROM messages WHERE id='cost-message'").get().state,'delivered');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {executionFixture} from './execution-fixture.mjs';
import {configureRoleModelPreference} from '../../../apps/kernel/dist/commands/role-model-preference.js';
import {bindingModelSelection} from '../../../apps/kernel/dist/execution/binding-model-selection.js';
import {readRoleModelPreference,recordModelEffective} from '../../../packages/domain/dist/roles/index.js';

const input=(f,requestId='config',expectedModelRevision=0,changes={})=>({schemaVersion:2,requestId,projectId:'p',roleId:'worker',expectedRevision:Number(f.store.db.prepare("SELECT revision FROM roles WHERE id='worker'").get().revision),expectedModelRevision,modelRequested:'  严格测试原文  ',modelId:'exact-model',reasoningLevel:'medium',...changes});
const configure=(f,args,guard=()=>{})=>configureRoleModelPreference(f.store,'synthetic-user',args,300,guard);

test('模型配置独立版本、原文、持久幂等与工作流评估：不使原生启动握手失效',t=>{
 const f=executionFixture(t),roleRevision=Number(f.store.db.prepare("SELECT revision FROM roles WHERE id='worker'").get().revision);
 const args=input(f),first=configure(f,args);assert.equal(first.revision,roleRevision);assert.equal(first.modelRevision,1);assert.equal(first.modelRequested.raw,args.modelRequested);assert.deepEqual(configure(f,args),first);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM role_model_revisions').get().n,1);assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE type='role.model_preference.configure'").get().n,1);
 assert.ok(f.store.db.prepare("SELECT 1 FROM outbox WHERE command_id=? AND operation_key LIKE '%:configuration:%'").get(first.receipt.commandId));
 assert.equal(f.store.db.prepare("SELECT role_revision FROM role_startup_acks WHERE binding_id='binding'").get().role_revision,roleRevision);
 const prepared=f.prepare('after-configuration');assert.equal(f.row(prepared).phase,'reserved');assert.equal(f.calls,0);
 assert.throws(()=>configure(f,{...args,modelId:'different'}),/IDEMPOTENCY_CONFLICT/);
});

test('频繁改模型合并同任务尚未评估候选；历史配置完整，已准备/不确定候选不重放',t=>{
 const f=executionFixture(t);for(let n=0;n<100;n++)configure(f,input(f,'batch-'+n,n));
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM role_model_revisions').get().n,100);
 assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state='pending' AND json_extract(payload_json,'$.event')='workflow.evaluate'").get().n,2,'两个任务各保留一个尚待评估候选');
 const original=f.store.db.prepare("SELECT id,command_id FROM outbox WHERE json_extract(payload_json,'$.taskId')='task'").get();
 f.store.db.prepare("UPDATE outbox SET state='uncertain' WHERE id=?").run(original.id);configure(f,input(f,'after-unknown',100));
 assert.equal(f.store.db.prepare('SELECT state FROM outbox WHERE id=?').get(original.id).state,'uncertain');
 assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE json_extract(payload_json,'$.taskId')='task' AND state='pending'").get().n,1,'新增待评估意图不改旧unknown，由消费者继续阻塞同任务');
 assert.equal(f.calls,0);
});

test('并发旧配置版本拒绝；显式跟随默认模型清除严格请求，但权限/预算/暂停原样保留',t=>{
 const f=executionFixture(t);configure(f,input(f));configure(f,input(f,'next',1,{modelId:'next-model'}));
 assert.throws(()=>configure(f,input(f,'stale',1)),/MODEL_REVISION_CONFLICT/);
 const before=f.store.db.prepare("SELECT policy_json,user_paused FROM projects WHERE id='p'").get();
 const reset={schemaVersion:2,requestId:'default',projectId:'p',roleId:'worker',expectedRevision:input(f).expectedRevision,expectedModelRevision:2,resetToDefault:true};
 const saved=configure(f,reset);assert.equal(saved.modelRevision,3);assert.equal(saved.modelRequested,null);assert.equal(saved.modelResolved,null);assert.equal(bindingModelSelection(f.store,'binding'),null);
 assert.deepEqual(f.store.db.prepare("SELECT policy_json,user_paused FROM projects WHERE id='p'").get(),before);
 assert.equal(readRoleModelPreference(f.store,'p','worker').modelRevision,3);
 assert.throws(()=>f.store.db.exec("UPDATE role_model_revisions SET requested_json='{}'"),/MODEL_HISTORY_IMMUTABLE/);
 assert.throws(()=>f.store.db.exec('DELETE FROM role_model_revisions'),/MODEL_HISTORY_IMMUTABLE/);
});

test('模型接口拒绝截断、缺配置版本、伪造身份和模糊reset载荷，失败不生成命令/历史',t=>{
 const f=executionFixture(t);
 const bad=[{modelRequested:'x'.repeat(513)},{modelId:'x'.repeat(129)},{reasoningLevel:'x'.repeat(33)},{expectedModelRevision:undefined},{expectedRevision:'2'},{sourcePrincipalId:'spoof'},{resetToDefault:true}];
 for(const change of bad){const value=input(f,'invalid-'+bad.indexOf(change));for(const [k,v] of Object.entries(change)){if(v===undefined)delete value[k];else value[k]=v;}assert.throws(()=>configure(f,value),/VALIDATION|VERSION_REQUIRED/);}
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM role_model_revisions').get().n,0);
 assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE type='role.model_preference.configure'").get().n,0);
});

test('配置保存审计失败或事务内撤权：状态/历史/命令/Outbox全部回滚',t=>{
 const f=executionFixture(t);
 assert.throws(()=>configure(f,input(f),()=>{throw Error('UNAUTHENTICATED');}),/UNAUTHENTICATED/);
 f.store.db.exec("CREATE TRIGGER fail_model_event BEFORE INSERT ON events WHEN NEW.type='role.model_preference.updated' BEGIN SELECT RAISE(ABORT,'MODEL_AUDIT_FAILURE'); END");
 assert.throws(()=>configure(f,input(f)),/MODEL_AUDIT_FAILURE/);
 assert.equal(readRoleModelPreference(f.store,'p','worker').modelRevision,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM role_model_revisions').get().n,0);assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE type='role.model_preference.configure'").get().n,0);
});

test('模型配置变化拒绝已预约旧输入；旧观察不能冒充新配置的生效记录',async t=>{
 const f=executionFixture(t),old=f.prepare('old-configuration');
 configure(f,input(f));assert.equal(await f.coordinator.run(old),'cancelled');assert.equal(f.calls,0);
 assert.throws(()=>recordModelEffective(f.store,'p','worker',{modelId:'old-model',providerId:null,observedAt:300,basis:'session-authoritative'},0),/MODEL_OBSERVATION_CONFIG_CHANGED/);
 assert.equal(f.store.db.prepare("SELECT model_effective_json FROM roles WHERE id='worker'").get().model_effective_json,null);
});

test('配置变化只作用于下一安全轮次；已经在途的旧轮次仍按原生终态结算',async t=>{
 const f=executionFixture(t),id=f.prepare('already-sent');const running=f.coordinator.run(id);for(let i=0;i<3;i++)await new Promise(r=>setImmediate(r));assert.equal(f.calls,1);
 configure(f,input(f));f.finish();assert.equal(await running,'succeeded');assert.equal(f.calls,1);assert.equal(readRoleModelPreference(f.store,'p','worker').modelRevision,1);
});

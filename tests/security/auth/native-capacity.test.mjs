import assert from 'node:assert/strict';
import test from 'node:test';
import {executionFixture} from './execution-fixture.mjs';
import {createDurableOperation,recordStep} from '../../../apps/kernel/dist/tools/orchestration-tools.js';
import {unresolvedFactoryCapacity} from '../../../apps/kernel/dist/execution/native-capacity.js';

function unknownFactory(f,role='another'){
 const {operationId}=createDurableOperation(f.store,{operationKey:'unknown-'+role,kind:'project.bootstrap',projectId:'p',payload:{roles:[{roleId:role}]}},200);
 recordStep(f.store,operationId,{step:`role:${role}:factory-call`,state:'sent',detail:null,at:201},201);
 recordStep(f.store,operationId,{step:`role:${role}:session-unknown`,state:'unknown',detail:null,at:202},202);return operationId;
}
test('未知工厂占用同一总/角色容量，不能从任务通路绕开；时间推进不释放',async t=>{
 for(const mode of ['total','role'])await t.test(mode,async inner=>{
  const f=executionFixture(inner),role=mode==='role'?'worker':'another',operation=unknownFactory(f,role);
  if(mode==='total')f.store.db.exec("UPDATE projects SET policy_json=json_set(policy_json,'$.limits.totalConcurrency',1)");
  assert.deepEqual(unresolvedFactoryCapacity(f.store.db,'p','worker'),{total:1,role:mode==='role'?1:0});
  assert.throws(()=>f.prepare(),/DISPATCH_CONCURRENCY_EXCEEDED/);assert.equal(f.calls,0);
  recordStep(f.store,operation,{step:`role:${role}:binding-registration`,state:'failed',detail:null,at:100000},100000);assert.equal(unresolvedFactoryCapacity(f.store.db,'p','worker').total,1,'失败登记不是结束证据');
  recordStep(f.store,operation,{step:`role:${role}:session-not-sent`,state:'failed',detail:'合成：确认未发送',at:100001},100001);
  const id=f.prepare();const running=f.coordinator.run(id);await new Promise(r=>setImmediate(r));f.finish();assert.equal(await running,'succeeded');assert.equal(f.calls,1);
 });
});
test('准备之后另一路工厂进入unknown，最后发送前仍拒绝且释放本次未发送预约',async t=>{
 const f=executionFixture(t);f.store.db.exec("UPDATE projects SET policy_json=json_set(policy_json,'$.limits.totalConcurrency',1)");const id=f.prepare();unknownFactory(f);
 assert.equal(await f.coordinator.run(id),'cancelled');assert.equal(f.calls,0);assert.equal(f.reservation().state,'released');assert.equal(unresolvedFactoryCapacity(f.store.db,'p','worker').total,1);
});

test('已观察创建后错误的整体not_sent、或未确认章程的绑定登记，均不能清除占位',t=>{
 const f=executionFixture(t),operation=unknownFactory(f);
 recordStep(f.store,operation,{step:'role:another:create-thread',state:'observed',detail:'original-id',at:203},203);
 recordStep(f.store,operation,{step:'role:another:session-not-sent',state:'failed',detail:'历史错误阶段标记',at:204},204);
 assert.equal(unresolvedFactoryCapacity(f.store.db,'p','another').role,1);
 recordStep(f.store,operation,{step:'role:another:binding-registration',state:'observed',detail:JSON.stringify({bindingId:'b',charterDelivered:false}),at:205},205);
 assert.equal(unresolvedFactoryCapacity(f.store.db,'p','another').role,1);
 recordStep(f.store,operation,{step:'role:another:binding-registration',state:'observed',detail:JSON.stringify({bindingId:'b',charterDelivered:true}),at:206},206);
 assert.equal(unresolvedFactoryCapacity(f.store.db,'p','another').role,0);
});

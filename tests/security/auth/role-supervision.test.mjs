import assert from 'node:assert/strict';
import test from 'node:test';
import {executionFixture} from './execution-fixture.mjs';
import {WorkflowConsumer} from '../../../apps/kernel/dist/execution/workflow-consumer.js';
import {enqueueWorkflowCandidatesWithin} from '../../../apps/kernel/dist/execution/workflow-intents.js';
import {roleSupervisionState} from '../../../apps/kernel/src/http/role-supervision.ts';

test('监督读投影显示当前暂停/禁用/绑定/模型/费用原因与处理者，完全没有写副作用',t=>{
 const f=executionFixture(t),read=()=>roleSupervisionState(f.store,'p','worker');const before=f.store.db.prepare('SELECT total_changes() AS n').get().n;assert.equal(read().nextAction,'等待准入评估');assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n,before);
 f.store.db.exec("UPDATE projects SET user_paused=1");assert.equal(read().waitingReason,'用户暂停项目');assert.equal(read().decisionBy,'用户');
 f.store.db.exec("UPDATE projects SET user_paused=0,policy_json=json_set(policy_json,'$.nativeMode','disabled')");assert.equal(read().waitingReason,'项目原生执行未启用');
 f.store.db.exec("UPDATE projects SET policy_json=json_set(policy_json,'$.nativeMode','verified_only');UPDATE roles SET binding_state='provisioning'");assert.equal(read().waitingReason,'原生绑定未就绪');
 f.store.db.exec("UPDATE roles SET binding_state='ready',model_requested_json='{}';UPDATE projects SET policy_json=json_set(policy_json,'$.limits.costCeiling',1)");assert.equal(read().waitingReason,'费用上限尚无官方执行证明');
 f.store.db.exec("UPDATE projects SET policy_json=json_set(policy_json,'$.limits.costCeiling',NULL)");assert.equal(read().waitingReason,'模型请求尚未解析');
 assert.equal(f.calls,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n,0);
});
test('工作流阻塞原因必须匹配当前任务实体/规格版本，旧记录不被当作当前原因',t=>{
 const f=executionFixture(t);f.store.transaction(db=>{db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('supervision-command','p','synthetic','supervision',?,'test','{}','completed',200)").run('a'.repeat(64));enqueueWorkflowCandidatesWithin(db,'p','supervision-command',300,['task']);});
 f.store.db.exec("UPDATE projects SET user_paused=1");const consumer=new WorkflowConsumer(f.store,f.coordinator,{workspaceForTask:()=>'workspace'});assert.equal(consumer.pump().blocked,1);
 f.store.db.exec("UPDATE projects SET user_paused=0");assert.equal(roleSupervisionState(f.store,'p','worker').waitingReason,'当前角色或项目授权未通过');
 f.store.db.exec("UPDATE tasks SET revision=revision+1 WHERE id='task'");assert.equal(roleSupervisionState(f.store,'p','worker').waitingReason,null);assert.equal(roleSupervisionState(f.store,'p','worker').nextAction,'等待准入评估');assert.equal(f.calls,0);
});
test('未知在途执行优先显示，只读不释放预约；暂停不伪装为原生停止',t=>{
 const f=executionFixture(t),id=f.prepare();f.store.db.prepare("UPDATE attempts SET state='unknown' WHERE id=?").run(id);f.store.db.exec('UPDATE projects SET user_paused=1');const before=f.store.db.prepare('SELECT total_changes() AS n').get().n;
 const view=roleSupervisionState(f.store,'p','worker');assert.equal(view.currentTask,'task');assert.equal(view.waitingReason,'未知执行待核对');assert.equal(view.nextAction,'只读核对原执行，不重发');assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n,before);assert.equal(f.reservation().state,'reserved');assert.equal(f.calls,0);
});

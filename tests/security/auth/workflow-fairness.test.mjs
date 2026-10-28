import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {openStore} from '../../../packages/persistence/dist/index.js';
import {createProject} from '../../../packages/domain/dist/projects/index.js';
import {createRoleWithin} from '../../../packages/domain/dist/roles/index.js';
import {createTask} from '../../../packages/domain/dist/tasks/index.js';
import {enqueueOutbox} from '../../../packages/persistence/dist/outbox/index.js';
import {WorkflowConsumer} from '../../../apps/kernel/dist/execution/workflow-consumer.js';
import {selectFairWorkflowCandidate} from '../../../apps/kernel/dist/execution/fair-workflow-selection.js';
import {installSyntheticPolicy} from './synthetic-policy.mjs';
import {temporaryDirectory} from '../../adapters/temporary-directory.mjs';

function fixture(t){
 let store;const directory=temporaryDirectory(t,'projectorch-fair-workflow-',()=>store?.close()),filename=path.join(directory,'state.sqlite');store=openStore(filename);
 const profiles=[{id:'worker',revision:1,actions:['identity','task.read'],readPaths:['tasks/*'],writePaths:[],roleIds:[],delegableActions:[],maxDelegationDepth:0},{id:'manager',revision:1,actions:['identity','change.apply'],readPaths:['tasks/*'],writePaths:['tasks/*'],roleIds:[],delegableActions:[],maxDelegationDepth:0}];
 for(const project of ['a','b']){createProject(store,{id:project,name:project,hostId:'synthetic',canonicalRoot:path.join(directory,project),objective:'合成调度测试'},10);installSyntheticPolicy(store,project,profiles);for(const profile of profiles)store.transaction(db=>createRoleWithin(db,{id:project+'-'+profile.id,projectId:project,name:profile.id,charter:'合成，不运行模型',permissionProfileId:profile.id,permissionProfileRevision:1,parentId:null},20));}
 const queue=(project,id,profile='worker',due=100)=>{createTask(store,{id,projectId:project,roleId:project+'-'+profile,goal:id,acceptance:[{ruleId:'u',mode:'user',description:'u'}],outputRequirements:[{name:'r',kind:'report',description:'r'}]},30);store.transaction(db=>{const command='command-'+id;db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES(?,?,'synthetic',?,?,'test','{}','completed',40)").run(command,project,id,'a'.repeat(64));enqueueOutbox(db,{id:'out-'+id,commandId:command,operationKey:id,payload:{schemaVersion:2,event:'workflow.evaluate',projectId:project,taskId:id,taskRevision:1,specRevision:1},nextAttemptAt:due});});};
 const consumer=()=>new WorkflowConsumer(store,{store,services:{isKernelOwner:()=>true,now:()=>1000},consumeStopRequests(){},recover(){return 0;}},{workspaceForTask:()=>'',maxPerPump:1,retryDelayMs:1});
 return {get store(){return store;},queue,consumer,reopen(){store.close();store=openStore(filename);}};
}
test('生产工作流单项目洪泛不能饿死另一项目；阻塞评估也计入公平轮转，重启保持',t=>{
 const f=fixture(t);for(let n=0;n<100;n++)f.queue('a','a-task-'+n);f.queue('b','z-b-task');
 const first=selectFairWorkflowCandidate(f.store.db,1000);assert.equal(first.project_id,'a');assert.equal(f.consumer().pump().blocked,1);
 f.reopen();assert.equal(selectFairWorkflowCandidate(f.store.db,1000).project_id,'b');assert.equal(f.consumer().pump().blocked,1);
 assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM workflow_evaluations WHERE project_id='b'").get().n,1);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n,0);
});
test('管理类别从当前持久档案取值，管理与执行均有机会；伪装m-任务ID不能提权或变管理',t=>{
 const f=fixture(t);for(let n=0;n<10;n++)f.queue('a','m-fake-manager-'+n);for(let n=0;n<10;n++)f.queue('a','z-actual-manager-'+n,'manager');
 assert.equal(JSON.parse(selectFairWorkflowCandidate(f.store.db,1000).payload_json).taskId,'z-actual-manager-0');f.consumer().pump();
 assert.match(JSON.parse(selectFairWorkflowCandidate(f.store.db,1000).payload_json).taskId,/^m-fake-manager-/);f.consumer().pump();
 assert.match(JSON.parse(selectFairWorkflowCandidate(f.store.db,1000).payload_json).taskId,/^z-actual-manager-/);
 f.store.db.prepare("UPDATE roles SET permission_profile='worker' WHERE id='a-manager'").run();assert.match(JSON.parse(selectFairWorkflowCandidate(f.store.db,1000).payload_json).taskId,/^m-fake-manager-/);
});
test('未来候选与非工作流副作用不被公平选择，空队列返回空',t=>{
 const f=fixture(t);f.queue('a','future','manager',2000);assert.equal(selectFairWorkflowCandidate(f.store.db,1000),undefined);
 f.store.db.prepare("UPDATE outbox SET payload_json=json_set(payload_json,'$.event','external.message')").run();assert.equal(selectFairWorkflowCandidate(f.store.db,3000),undefined);
});

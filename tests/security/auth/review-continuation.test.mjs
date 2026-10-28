/** 合成原生驱动，只验证程序续行事务；结果和退回使用真实Agent工具/命令，不冒充原生验收。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {executionFixture} from './execution-fixture.mjs';
import {installSyntheticPolicy} from './synthetic-policy.mjs';
import {createRole} from '../../../packages/domain/dist/roles/index.js';
import {completeStartupAck} from '../../../packages/domain/dist/bootstrap/index.js';
import {issueAgentCredential,authenticateAgentCredential} from '../../../apps/kernel/dist/auth/agent-credential.js';
import {createToolDispatcher} from '../../../apps/kernel/dist/tools/gateway-tools.js';
import {ExecutionCoordinator} from '../../../apps/kernel/dist/execution/coordinator.js';
import {advanceReviewWorkflow} from '../../../apps/kernel/dist/execution/review-continuation.js';
import {openStore} from '../../../packages/persistence/dist/index.js';

function fixture(t){
 const f=executionFixture(t);
 createRole(f.store,{id:'reviewer',projectId:'p',name:'reviewer',charter:'独立复核',permissionProfileId:'review'},150);
 f.store.db.exec("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('review-session','codex','host','synthetic-only','review-native'); INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('review-binding','p','reviewer','review-session',1,150); UPDATE roles SET binding_state='provisioning' WHERE id='reviewer'");
 const makeProfile=(id,actions)=>({id,revision:1,actions,readPaths:['tasks/*'],writePaths:['tasks/*'],roleIds:[],delegableActions:[],maxDelegationDepth:0});
 installSyntheticPolicy(f.store,'p',[makeProfile('execution',['identity','task.read','task.claim','task.submit_own','message.send']),makeProfile('review',['identity','task.read','task.accept_assigned'])]);
 const p=JSON.parse(f.store.db.prepare("SELECT policy_json FROM projects WHERE id='p'").get().policy_json);p.limits.maxCorrectionTurns=1;f.store.db.prepare("UPDATE projects SET policy_json=? WHERE id='p'").run(JSON.stringify(p));
 const rule=[{ruleId:'review',mode:'designated_reviewer',reviewerRoleId:'reviewer',independent:true,description:'独立核对'}];f.store.db.prepare("UPDATE tasks SET acceptance_json=? WHERE id='task'").run(JSON.stringify(rule));
 for(const roleId of ['worker','reviewer'])completeStartupAck(f.store,{projectId:'p',roleId,bindingEpoch:1,protocolVersion:2,policyRevision:1,planRevision:0,roleRevision:Number(f.store.db.prepare('SELECT revision FROM roles WHERE id=?').get(roleId).revision),taskSpecRevisions:[{taskId:'task',specRevision:1}]},170);
 const exec=issueAgentCredential(f.store,'binding',1,{isolation:'verified_session',session:f.session},180,60000);
 const review=issueAgentCredential(f.store,'review-binding',1,{isolation:'verified_session',session:{harnessId:'codex',hostId:'host',profileId:'synthetic-only',nativeConversationId:'review-native'}},180,60000);
 const principal=authenticateAgentCredential(f.store,exec.credential,200),reviewer=authenticateAgentCredential(f.store,review.credential,200);
 const execTool=createToolDispatcher(f.store,{now:()=>300,callerNativeConversationId:f.session.nativeConversationId});
 const reviewTool=createToolDispatcher(f.store,{now:()=>310,callerNativeConversationId:'review-native'});
 const coordinator=new ExecutionCoordinator(f.store,{...f.services,principalForBinding:()=>principal});
 let n=0;f.setStart((_input,started)=>{const id='synthetic-turn-'+(++n);queueMicrotask(()=>started(f.session,id));return{result:Promise.resolve({session:f.session,executionId:id,status:'completed',terminalConfirmed:true})};});
 const submit=async()=>{
   const dispatch=coordinator.prepare(principal,{requestKey:'round-'+n,taskId:'task',workspaceId:'workspace'});
   assert.equal(await coordinator.run(dispatch),'succeeded');
   const result=execTool(principal,'task.submit_result',{requestId:'submit-'+n,taskId:'task',taskRevision:1,attemptId:dispatch,bindingEpoch:1,outcome:'inconclusive',outputs:[],checks:[],remainingIssues:[],summary:'合成原生终态，真实工具提交'});
   assert.equal(result.ok,true,JSON.stringify(result));return result.payload.resultId;
 };
 const reject=id=>{const result=reviewTool(reviewer,'task.accept',{requestId:'reject-'+id,taskId:'task',taskRevision:1,resultId:id,ruleId:'review',decision:'reject',reason:'缺少要求的摘要',evidenceArtifactIds:[]});assert.equal(result.ok,true,JSON.stringify(result));};
 return{...f,coordinator,submit,reject,reviewCredentialId:reviewer.credentialId,execCredentialId:principal.credentialId};
}

test('真实提交/裁决命令→一次复核通知→同绑定有界返工；重放不重复，超限保持blocked',async t=>{
 const f=fixture(t),first=await f.submit();
 assert.deepEqual(advanceReviewWorkflow(f.store,305,8),{notices:1,reopened:0});
 assert.deepEqual(advanceReviewWorkflow(f.store,306,8),{notices:0,reopened:0});
 const message=f.store.db.prepare("SELECT command_id,to_role_id FROM messages WHERE id LIKE 'review-notice-%'").get();assert.equal(message.to_role_id,'reviewer');
 assert.ok(f.store.db.prepare('SELECT 1 FROM agent_command_scopes WHERE command_id=? AND role_id=?').get(message.command_id,'worker'));
 f.reject(first);assert.deepEqual(advanceReviewWorkflow(f.store,315,8),{notices:0,reopened:1});
 assert.deepEqual(advanceReviewWorkflow(f.store,316,8),{notices:0,reopened:0});
 assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='task.reopened'").get().n,1);
 const candidate=f.store.db.prepare("SELECT payload_json FROM outbox WHERE operation_key LIKE 'workflow.task:%'").get();assert.equal(JSON.parse(candidate.payload_json).taskId,'task');
 const second=await f.submit();f.reject(second);assert.deepEqual(advanceReviewWorkflow(f.store,320,8),{notices:0,reopened:0});
 assert.equal(f.store.db.prepare("SELECT state FROM tasks WHERE id='task'").get().state,'blocked');
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM role_bindings WHERE role_id=?').get('worker').n,1);
});

test('暂停/hold/撤权和未知执行均不触发通知或返工，恢复只推进一次',async t=>{
 const f=fixture(t),result=await f.submit();
 f.store.db.exec("UPDATE projects SET user_paused=1 WHERE id='p'");assert.deepEqual(advanceReviewWorkflow(f.store,305,8),{notices:0,reopened:0});
 f.store.db.exec("UPDATE projects SET user_paused=0 WHERE id='p'; UPDATE attempts SET state='unknown' WHERE task_id='task'");assert.deepEqual(advanceReviewWorkflow(f.store,305,8),{notices:0,reopened:0});
 f.store.db.exec("UPDATE attempts SET state='succeeded' WHERE task_id='task'");
 f.store.db.exec("INSERT INTO goal_holds(id,project_id,revision,source_kind,provenance_json,affected_tasks_json,scope_known,state) VALUES('hold','p',0,'authenticated_user','{}','[]',1,'pending')");
 assert.deepEqual(advanceReviewWorkflow(f.store,305,8),{notices:0,reopened:0});
 f.store.db.exec("UPDATE goal_holds SET state='resolved' WHERE id='hold'");
 f.store.db.prepare('UPDATE agent_credentials SET revoked_at=301 WHERE id=?').run(f.execCredentialId);assert.deepEqual(advanceReviewWorkflow(f.store,305,8),{notices:0,reopened:0});
 f.reject(result);f.store.db.exec("UPDATE projects SET user_paused=1 WHERE id='p'");assert.equal(advanceReviewWorkflow(f.store,315,8).reopened,0);
 f.store.db.exec("UPDATE projects SET user_paused=0 WHERE id='p'");f.store.db.prepare('UPDATE agent_credentials SET revoked_at=312 WHERE id=?').run(f.reviewCredentialId);assert.equal(advanceReviewWorkflow(f.store,315,8).reopened,0);
 assert.equal(f.store.db.prepare("SELECT state FROM tasks WHERE id='task'").get().state,'blocked');
});

test('真实关闭重开控制库后从既有拒绝续行；同结果不重复重开或派发',async t=>{
 const f=fixture(t),result=await f.submit();f.reject(result);f.store.close();
 const resumed=openStore(f.filename);f.stores.push(resumed);
 assert.deepEqual(advanceReviewWorkflow(resumed,315,8),{notices:0,reopened:1});resumed.close();
 const again=openStore(f.filename);f.stores.push(again);
 assert.deepEqual(advanceReviewWorkflow(again,316,8),{notices:0,reopened:0});
 assert.equal(again.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='task.reopened'").get().n,1);
 assert.equal(again.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE operation_key LIKE 'workflow.task:%'").get().n,1);
});

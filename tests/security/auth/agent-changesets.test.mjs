import test from 'node:test';
import assert from 'node:assert/strict';
import {executionFixture} from './execution-fixture.mjs';
import {installSyntheticPolicy} from './synthetic-policy.mjs';
import {createToolDispatcher} from '../../../apps/kernel/dist/tools/gateway-tools.js';
import {mcpToolEntries,mcpToolDescription,mcpToolArguments} from '../../../apps/kernel/dist/tools/mcp-catalog.js';
import {issueAgentCredential,authenticateAgentCredential} from '../../../apps/kernel/dist/auth/agent-credential.js';
import {budgetView} from '../../../packages/domain/dist/budget/index.js';

const child={id:'child',revision:1,actions:['identity','task.read'],readPaths:['tasks/*'],writePaths:[],roleIds:[],delegableActions:[],maxDelegationDepth:0};
const manager={id:'execution',revision:1,actions:['identity','change.apply','role.create','role.update','role.pause','role.enable','role.disable','task.create','task.assign','task.cancel','task.spec.revise','task.dependencies.replace','task.read','artifact.read'],readPaths:['roles/*','tasks/*','reports/*'],writePaths:['roles/*','tasks/*','reports/*'],roleIds:[],delegableActions:['identity','task.read'],maxDelegationDepth:1};
const spec={goal:'synthetic',inputArtifacts:[],outputRequirements:[{name:'report',kind:'report',description:'required report'}],acceptance:[{ruleId:'user',mode:'user',description:'required user approval'}],dependencies:[]};
const role=(id='new')=>({type:'role.create',localRef:id,name:id,charter:'synthetic child',parentRoleId:'worker',permissionProfileId:'child',permissionProfileRevision:1,scopePaths:['tasks/*']});
const task=(id='new-task',assignee='new')=>({type:'task.create',localRef:id,assigneeRoleId:assignee,spec});
const input=(requestId,operations,expectedPlanRevision=0)=>({requestId,expectedPlanRevision,reason:'synthetic management',operations});
function fixture(t,profile=manager){
 const f=executionFixture(t);installSyntheticPolicy(f.store,'p',[profile,child]);
 const dispatch=createToolDispatcher(f.store,{now:()=>300,callerNativeConversationId:f.session.nativeConversationId});
 return {...f,call:args=>dispatch(f.principal,'management.apply_changes',args),dispatch};
}

test('管理Agent一次创建角色和依赖任务：严格MCP合同、幂等来源、委派收窄、Outbox原子保存',t=>{
 const f=fixture(t);const entry=mcpToolEntries.find(e=>e.tool==='management.apply_changes');assert.ok(entry);assert.ok(mcpToolDescription(entry).inputSchema.properties.operations);
 const args=input('batch',[role(),task(),{...task('next-created'),spec:{...spec,dependencies:[{taskId:'new-task',requiredTaskRevision:1,condition:'accepted'}]}}]);
 assert.deepEqual(mcpToolArguments(entry,args),args);assert.throws(()=>mcpToolArguments(entry,{...args,projectId:'other'}));
 const result=f.call(args);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.payload.status,'completed',JSON.stringify(result));assert.equal(f.store.db.prepare("SELECT parent_id,binding_state FROM roles WHERE id='new'").get().parent_id,'worker');assert.equal(f.store.db.prepare("SELECT binding_state FROM roles WHERE id='new'").get().binding_state,'unbound');
 assert.equal(f.store.db.prepare("SELECT role_id FROM tasks WHERE id='new-task'").get().role_id,'new');assert.equal(f.store.db.prepare('SELECT plan_revision FROM projects').get().plan_revision,1);
 const reissue=issueAgentCredential(f.store,'binding',1,{isolation:'verified_session',session:f.session},250,60000).credential;const current=authenticateAgentCredential(f.store,reissue,300);
 assert.deepEqual(f.dispatch(current,'management.apply_changes',args),result);assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE type='management.apply_changes'").get().n,1);
 assert.equal(f.store.db.prepare("SELECT role_id FROM agent_command_scopes WHERE command_id=?").get(result.payload.commandId).role_id,'worker');
 assert.ok(f.store.db.prepare("SELECT 1 FROM outbox WHERE command_id=?").get(result.payload.commandId));
 f.store.db.prepare('UPDATE outbox SET attempts=3 WHERE id=(SELECT id FROM outbox WHERE command_id=? ORDER BY id LIMIT 1)').run(result.payload.commandId);
 assert.equal(budgetView(f.store,'p','worker').adminCycles,1);assert.equal(budgetView(f.store,'p','worker').outboxRetries,3);
 assert.equal(budgetView(f.store,'p','new').adminCycles,0);assert.equal(budgetView(f.store,'p','new').outboxRetries,0,'接收/被创建角色不承担管理者命令预算');
 const conflict=f.call({...args,reason:'different payload'});assert.equal(conflict.ok,false);assert.match(conflict.payload.error,/IDEMPOTENCY_CONFLICT/);
});

test('管理Agent逐操作和路径授权：change.apply不能单独授权整册，非法后项不部分创建',t=>{
 for(const mode of ['missing-action','path','delegate','parent','depth','dynamic','pause','revoke','project']){
  const profile=structuredClone(manager);if(mode==='missing-action')profile.actions=profile.actions.filter(a=>a!=='task.create');if(mode==='path')profile.writePaths=['roles/only'];if(mode==='delegate')profile.delegableActions=['identity'];if(mode==='depth')profile.maxDelegationDepth=0;
  const f=fixture(t,profile);if(mode==='dynamic')f.store.db.exec("UPDATE projects SET policy_json=json_set(policy_json,'$.limits.maxDynamicRoles',0)");if(mode==='pause')f.store.db.exec('UPDATE projects SET user_paused=1');if(mode==='revoke')f.store.db.exec('UPDATE agent_credentials SET revoked_at=250');
  const r=role();if(mode==='parent')r.parentRoleId=null;const args=input('deny',[r,task()]);if(mode==='project')args.projectId='other';
  const result=f.call(args);assert.equal(result.ok,false,mode);assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM roles WHERE id='new'").get().n,0,mode);assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id='new-task'").get().n,0,mode);
 }
});

test('管理变更冲突返回持久失败回执，旧计划不落部分新角色',t=>{
 const f=fixture(t);const result=f.call(input('stale',[role()],99));assert.equal(result.ok,true);assert.equal(result.payload.status,'failed');assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM roles WHERE id='new'").get().n,0);assert.deepEqual(f.call(input('stale',[role()],99)),result);
 assert.equal(f.store.db.prepare('SELECT plan_revision FROM projects').get().plan_revision,0);
});

test('管理Agent不能移除原有用户验收/具名输出，绑定角色改配不通过管理捷径',t=>{
 const f=fixture(t);const original=f.store.db.prepare("SELECT goal,inputs_json,outputs_json,acceptance_json,spec_revision,revision FROM tasks WHERE id='task'").get();
 const revise={type:'task.spec.revise',taskId:'task',expectedRevision:original.revision,expectedSpecRevision:original.spec_revision,spec:{goal:original.goal,inputArtifacts:JSON.parse(original.inputs_json),outputRequirements:JSON.parse(original.outputs_json),acceptance:[{ruleId:'replacement',mode:'user',description:'replacement'}],dependencies:[]},affectedTaskIds:[],inFlightPolicy:'finish_stale',outputReuse:'none',reason:'attempt to weaken'};
 const result=f.call(input('weaken',[revise]));assert.equal(result.ok,false);assert.match(result.payload.error,/CANNOT_WEAKEN/);assert.equal(f.store.db.prepare("SELECT spec_revision FROM tasks WHERE id='task'").get().spec_revision,1);
 const bound=f.call(input('bound',[{type:'role.update',roleId:'worker',expectedRevision:1,charter:'new charter'}]));assert.equal(bound.ok,false);assert.match(bound.payload.error,/bound_role_reconfiguration/);
});

test('管理循环额度和调用事务内撤权不被幂等或批次绕过',t=>{
 const f=fixture(t);f.store.db.exec("UPDATE projects SET policy_json=json_set(policy_json,'$.limits.maxManagementRounds',1)");
 const first=input('one',[task('planned-one','worker')]);const accepted=f.call(first);assert.equal(accepted.payload.status,'completed');
 const excess=f.call(input('two',[task('planned-two','worker')],1));assert.equal(excess.ok,false);assert.match(excess.payload.error,/MANAGEMENT_ROUNDS_EXCEEDED/);assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id='planned-two'").get().n,0);
 assert.deepEqual(f.call(first),accepted,'合法重放不消耗第二轮预算');
 let checks=0;const guarded=createToolDispatcher(f.store,{now:()=>300,callerNativeConversationId:f.session.nativeConversationId,assertTrustedConnection:()=>{checks++;if(checks===2)f.store.db.exec('UPDATE agent_credentials SET revoked_at=250');}});
 const revoked=guarded(f.principal,'management.apply_changes',input('revoke',[task('never','worker')],1));assert.equal(revoked.ok,false);assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id='never'").get().n,0);
});

test('委派不能放宽读取路径或再委派深度，role.create授权不隐含高权限档案',t=>{
 const profile={...manager,readPaths:['roles/*','tasks/only','reports/*']};const f=fixture(t,profile);
 const denied=f.call(input('scope',[role()]));assert.equal(denied.ok,false);assert.match(denied.payload.error,/DELEGATION_FORBIDDEN:PATH_OUT_OF_SCOPE/);
 const g=fixture(t);g.store.db.exec("UPDATE projects SET policy_json=json_set(policy_json,'$.profiles[1].maxDelegationDepth',1)");
 const depth=g.call(input('depth',[role()]));assert.equal(depth.ok,false);assert.match(depth.payload.error,/DELEGATION_FORBIDDEN:DELEGATION_DEPTH_EXCEEDED/);
});

// 合成工厂合同验证，不代表真实三角色项目完成。
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {hostname} from 'node:os';
import {executionFixture} from './execution-fixture.mjs';
import {alphaTeamPolicy,alphaTeamPrompt} from '../../../apps/web/dist/team-template.js';
import {createProjectForUser} from '../../../apps/kernel/dist/commands/project-create.js';
import {projectBootstrapOrchestration,settleFactoryOrchestrations} from '../../../apps/kernel/dist/tools/orchestration-tools.js';
import {issueAgentCredential,authenticateAgentCredential} from '../../../apps/kernel/dist/auth/agent-credential.js';
import {createToolDispatcher} from '../../../apps/kernel/dist/tools/gateway-tools.js';
import {issueControlEntryToken,authenticateControlEntry} from '../../../apps/kernel/dist/auth/control-entry.js';

test('三角色新项目模板经过真实创建/编排/管理管线：负责人可创建执行任务，执行者不能自验收',async t=>{
 const f=executionFixture(t),root=path.join(f.dir,'alpha-project');fs.mkdirSync(root);
 const created=createProjectForUser(f.store,'synthetic-user',hostname(),{schemaVersion:2,requestId:'alpha-project',hostId:hostname(),name:'Alpha synthetic',rootPath:root,objective:'受控组件测试',initialPolicy:alphaTeamPolicy()},Date.now());
 const projectId=created.projectId,prompt=alphaTeamPrompt(projectId,'受控组件测试'),args=JSON.parse(prompt.slice(prompt.indexOf('\n{')+1,prompt.indexOf('\n三角色全部ready')));
 assert.equal(args.roles.length,3);assert.deepEqual(args.roles.map(r=>r.harnessId),['codex','zcode','codex']);assert.equal(new Set(args.roles.map(r=>r.roleId)).size,3);
 let creates=0;const factory={ensureBoundSession:async input=>{input.assertCanSend();creates++;return{sessionRef:{harnessId:input.harnessId,hostId:'synthetic',profileId:'template',nativeConversationId:'native-'+input.roleId,nativeWorkspaceId:input.workspaceRoot},nativeSessionId:'native-'+input.roleId,nativeTurnId:'charter-'+input.roleId,charterDelivered:true};}};
 const control=issueControlEntryToken(f.store,projectId,['project.bootstrap'],Date.now(),60000),bootstrap=projectBootstrapOrchestration(f.store,factory,r=>r,undefined,(_project,role)=>path.join(root,role)),result=bootstrap(f.store,authenticateControlEntry(f.store,control.token,Date.now()),args);assert.equal(result.ok,true,JSON.stringify(result));
 await settleFactoryOrchestrations(f.store);assert.equal(creates,3,JSON.stringify(f.store.db.prepare('SELECT state,steps_json FROM durable_operations WHERE project_id=?').all(projectId)));assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM roles WHERE project_id=? AND binding_state='ready'").get(projectId).n,3);
 const lead=args.roles[0].roleId,executor=args.roles[1].roleId,reviewer=args.roles[2].roleId,bindingId='bnd-'+lead,row=f.store.db.prepare('SELECT s.harness_id,s.host_id,s.profile_id,s.native_conversation_id,s.native_workspace_id FROM role_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.id=?').get(bindingId),session={harnessId:row.harness_id,hostId:row.host_id,profileId:row.profile_id,nativeConversationId:row.native_conversation_id,nativeWorkspaceId:row.native_workspace_id};
 const now=Date.now(),secret=issueAgentCredential(f.store,bindingId,1,{isolation:'verified_session',session},now,60000).credential,principal=authenticateAgentCredential(f.store,secret,now),dispatch=createToolDispatcher(f.store,{now:()=>now,callerNativeConversationId:session.nativeConversationId});
 const plan=Number(f.store.db.prepare('SELECT plan_revision FROM projects WHERE id=?').get(projectId).plan_revision);
 const task=dispatch(principal,'management.apply_changes',{requestId:'plan',expectedPlanRevision:plan,reason:'测试模板负责人创建任务',operations:[{type:'task.create',localRef:'alpha-work',assigneeRoleId:executor,spec:{goal:'实际组件测试',inputArtifacts:[],outputRequirements:[{name:'report',kind:'file',description:'文件'}],acceptance:[{ruleId:'review',mode:'designated_reviewer',reviewerRoleId:reviewer,independent:true,description:'独立核对文件'}],dependencies:[]}}]});
 assert.equal(task.ok,true,JSON.stringify(task));assert.equal(task.payload.status,'completed',JSON.stringify(task));assert.equal(f.store.db.prepare("SELECT role_id FROM tasks WHERE id='alpha-work'").get().role_id,executor);
 const policy=alphaTeamPolicy();assert.equal(policy.limits.totalConcurrency,1);assert.equal(policy.limits.maxDynamicRoles,3);assert.equal(policy.limits.costEnforcement,'unavailable');assert.ok(!policy.profiles.find(p=>p.id==='executor').actions.includes('task.accept_assigned'));assert.ok(policy.profiles.every(p=>!p.actions.includes('policy.configure')));
});

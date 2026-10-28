import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {hostname} from 'node:os';
import {executionFixture} from './execution-fixture.mjs';
import {issueControlEntryToken,controlEntryBackend} from '../../../apps/kernel/dist/auth/control-entry.js';
import {projectBootstrapOrchestration,messageSendOrchestration,taskDispatchOrchestration} from '../../../apps/kernel/dist/tools/orchestration-tools.js';

function fixture(t,scope=null,permissions=['project.bootstrap']){
 const f=executionFixture(t);let calls=0;
 const factory={ensureBoundSession:async input=>{input.assertCanSend();calls++;return {sessionRef:{harnessId:input.harnessId,hostId:'synthetic',profileId:'control',nativeConversationId:'created-'+input.roleId,nativeWorkspaceId:input.workspaceRoot},nativeSessionId:'created-'+input.roleId,nativeTurnId:'charter',charterDelivered:true};}};
 const token=issueControlEntryToken(f.store,scope,permissions,Date.now()-100,60000).token;
 const backend=controlEntryBackend(f.store,token,{now:()=>Date.now()},{projectBootstrap:projectBootstrapOrchestration(f.store,factory,x=>x,undefined,(projectId,roleId)=>path.join(String(f.store.db.prepare('SELECT canonical_root FROM projects WHERE id=?').get(projectId).canonical_root),roleId)),messageSend:messageSendOrchestration(f.store,factory),taskDispatch:taskDispatchOrchestration(f.store)});
 const root=path.join(f.dir,'registered root');fs.mkdirSync(root);
 const policy=JSON.parse(f.store.db.prepare("SELECT policy_json FROM projects WHERE id='p'").get().policy_json);
 return {...f,backend,get calls(){return calls;},args:{requestId:'registered-project',hostId:hostname(),name:'registered project',rootPath:root,objective:'synthetic only',initialPolicy:policy}};
}

test('全局控制MCP按既有合同创建项目并保留初始策略：幂等、主机一致、来源unknown',async t=>{
 const f=fixture(t),identity=f.backend.call('projectorch_identity',{});assert.equal(identity.payload.kernelHostId,hostname());assert.equal(identity.payload.sourceIdentity,'unknown');
 const definition=f.backend.list().find(x=>x.name==='projectorch_project_create');assert.ok(definition.inputSchema.properties.initialPolicy);
 const created=f.backend.call('projectorch_project_create',f.args);assert.equal(created.ok,true,JSON.stringify(created));assert.equal(created.payload.status,'completed');assert.deepEqual(f.backend.call('projectorch_project_create',f.args),created);
 const p=f.store.db.prepare('SELECT policy_json,policy_revision FROM projects WHERE id=?').get(created.payload.projectId);assert.deepEqual(JSON.parse(p.policy_json),f.args.initialPolicy);assert.equal(p.policy_revision,f.args.initialPolicy.revision);assert.equal(f.calls,0);
 const bootstrap=f.backend.call('projectorch_project_bootstrap',{projectId:created.payload.projectId,objective:'synthetic team',roles:[{roleId:'lead-registration',permissionProfileId:'execution',createSession:false}]});assert.equal(bootstrap.ok,true,JSON.stringify(bootstrap));await new Promise(r=>setImmediate(r));
 const role=f.store.db.prepare("SELECT permission_profile,permission_profile_revision,binding_state FROM roles WHERE id='lead-registration'").get();assert.equal(role.permission_profile,'execution');assert.equal(role.permission_profile_revision,1);assert.equal(role.binding_state,'unbound');assert.equal(f.calls,0,'登记原负责人不另建替代会话');assert.ok(f.store.db.prepare("SELECT 1 FROM role_revisions WHERE role_id='lead-registration' AND revision=1").get());
});

test('项目控制入口拒绝越权/撤销/错主机/未知字段，建组不再隐式创建空策略项目',t=>{
 for(const mode of ['scoped','readonly','revoked','host','unknown']){
  const f=fixture(t,mode==='scoped'?'p':null,mode==='readonly'?[]:['project.bootstrap']);
  if(mode==='revoked'){assert.equal(f.backend.call('projectorch_projects',{}).ok,true);f.store.db.prepare('UPDATE control_entries SET revoked_at=?').run(Date.now());}
  const args={...f.args};if(mode==='host')args.hostId='wrong-host';if(mode==='unknown')args.roleId='spoof';
  const result=f.backend.call('projectorch_project_create',args);assert.equal(result.ok,false,mode);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n,1,mode);
 }
 const f=fixture(t);const missing=f.backend.call('projectorch_project_bootstrap',{projectId:'does-not-exist',objective:'synthetic',roles:[]});assert.equal(missing.ok,false);assert.equal(missing.payload.error,'PROJECT_NOT_FOUND');assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE id='does-not-exist'").get().n,0);
 const malformed=f.backend.call('projectorch_project_bootstrap',{projectId:'p',objective:'synthetic',roles:[{roleId:'new',model:'silently-ignored'}]});assert.equal(malformed.ok,false);assert.equal(f.calls,0);
});

test('先登记并接纳原负责人，再建四个角色：初始角色不重复占用动态额度，档案版本和父角色正确',async t=>{
 const f=fixture(t);const created=f.backend.call('projectorch_project_create',f.args);const projectId=created.payload.projectId;
 f.backend.call('projectorch_project_bootstrap',{projectId,objective:'lead first',roles:[{roleId:'existing-lead',permissionProfileId:'execution',createSession:false}]});await new Promise(r=>setImmediate(r));
 const adopted=f.backend.call('projectorch_adopt_conversation',{projectId,roleId:'existing-lead',nativeSession:{harnessId:'codex',hostId:'synthetic',profileId:'original',nativeConversationId:'existing-conversation',nativeWorkspaceId:f.args.rootPath}});assert.equal(adopted.ok,true,JSON.stringify(adopted));
 assert.equal(f.store.db.prepare('SELECT role_id,state FROM project_bootstrap WHERE project_id=?').get(projectId).role_id,'existing-lead');assert.equal(f.calls,0);
 const roles=['manager','reviewer','executor-one','executor-two'].map((roleId,i)=>({roleId,permissionProfileId:'execution',parentRoleId:'existing-lead',harnessId:i%2?'codex':'zcode'}));
 const boot=f.backend.call('projectorch_project_bootstrap',{projectId,objective:'four new roles',roles});assert.equal(boot.ok,true,JSON.stringify(boot));for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r));
 assert.equal(f.calls,4);const rows=f.store.db.prepare("SELECT id,parent_id,permission_profile_revision,binding_state FROM roles WHERE project_id=? AND id<>'existing-lead'").all(projectId);assert.equal(rows.length,4);assert.ok(rows.every(r=>r.parent_id==='existing-lead'&&r.permission_profile_revision===1&&r.binding_state==='ready'));
 assert.equal(f.store.db.prepare("SELECT binding_state FROM roles WHERE id='existing-lead'").get().binding_state,'provisioning','合成声明没有官方核验，不伪造负责人ready');
});

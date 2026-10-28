import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {executionFixture} from './execution-fixture.mjs';
import {installSyntheticPolicy} from './synthetic-policy.mjs';
import {createRole} from '../../../packages/domain/dist/roles/index.js';
import {registerArtifactWithin} from '../../../packages/domain/dist/artifacts/index.js';
import {completeStartupAck} from '../../../packages/domain/dist/bootstrap/index.js';
import {issueAgentCredential,authenticateAgentCredential} from '../../../apps/kernel/dist/auth/agent-credential.js';
import {createToolDispatcher} from '../../../apps/kernel/dist/tools/gateway-tools.js';
import {workspaceFingerprint} from '../../../apps/kernel/dist/tools/workspace-fingerprint.js';
import {openStore} from '../../../packages/persistence/dist/index.js';
import {mcpToolEntries,mcpToolDescription} from '../../../apps/kernel/dist/tools/mcp-catalog.js';

function fixture(t){
 const f=executionFixture(t),profile={id:'execution',revision:1,actions:['identity','task.read','task.claim','artifact.read','workspace.read','check.read','handover.prepare','handover.verify','handover.read','integration.request','integration.read'],readPaths:['tasks/*','roles/*','handovers/*','integrations/*','workspaces/*','checks/*','context.json','evidence.json','workspace/*'],writePaths:['tasks/*','roles/*','handovers/*','integrations/*','workspaces/*','checks/*','context.json','evidence.json','workspace/*'],roleIds:[],delegableActions:[],maxDelegationDepth:0};
 createRole(f.store,{id:'verifier',projectId:'p',name:'合成核验者',charter:'独立核验',permissionProfileId:'execution'},101);
 f.store.db.exec("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('verify-session','codex','host','synthetic','verify-native');INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('verify-binding','p','verifier','verify-session',1,100);UPDATE roles SET binding_state='provisioning' WHERE id='verifier'");
 const session={harnessId:'codex',hostId:'host',profileId:'synthetic',nativeConversationId:'verify-native'},token=issueAgentCredential(f.store,'verify-binding',1,{isolation:'verified_session',session},110,60000).credential,verifier=authenticateAgentCredential(f.store,token,120);
 installSyntheticPolicy(f.store,'p',[profile]);for(const roleId of ['worker','verifier'])completeStartupAck(f.store,{projectId:'p',roleId,bindingEpoch:1,protocolVersion:2,policyRevision:1,planRevision:0,roleRevision:Number(f.store.db.prepare('SELECT revision FROM roles WHERE id=?').get(roleId).revision),taskSpecRevisions:[{taskId:'task',specRevision:1},{taskId:'next',specRevision:1}]},140);
 const file=(id,content)=>{const location=path.join(f.dir,id+'.json'),bytes=Buffer.from(typeof content==='string'?content:JSON.stringify(content));fs.writeFileSync(location,bytes);f.store.transaction(db=>registerArtifactWithin(db,{id,projectId:'p',version:'v1',pathRef:id+'.json',sha256:createHash('sha256').update(bytes).digest('hex'),byteSize:bytes.length},200));return {artifactId:id,version:'v1'};};
 const ref=file('context',{projectId:'p',roleId:'worker',fromBindingEpoch:1,notes:'持久目标/决策与工作进度'}),evidence=file('evidence','合成独立证据');
 const prepare={requestId:'prepare',roleId:'worker',expectedBindingEpoch:1,artifact:ref,taskSpecRevisions:[{taskId:'task',specRevision:1},{taskId:'next',specRevision:1}],workspaceVersions:[],unresolvedIssueIds:[],pendingEffects:[],verifierRoleId:'verifier'};
 const call=(actor,tool,args)=>{const p=actor==='worker'?f.principal:verifier;return createToolDispatcher(f.store,{now:()=>300,callerNativeConversationId:p.session.nativeConversationId})(p,tool,args);};
 return Object.assign(f,{verifier,profile,file,ref,evidence,prepareArgs:prepare,call});
}

test('固定交接工具：完整版本快照/真实成果、独立核验、幂等回放与重启持久',t=>{
 const f=fixture(t);for(const tool of ['handover.prepare','handover.verify','handover.read','integration.request','integration.read'])assert.ok(mcpToolDescription(mcpToolEntries.find(e=>e.tool===tool)).inputSchema.properties);
 const prepared=f.call('worker','handover.prepare',f.prepareArgs);assert.equal(prepared.ok,true,JSON.stringify(prepared));assert.deepEqual(f.call('worker','handover.prepare',f.prepareArgs),prepared);
 const handover=prepared.payload.entity,args={requestId:'verify',handoverId:handover.id,expectedRevision:1,decision:'verified',evidence:[f.evidence]};
 assert.equal(f.call('worker','handover.verify',args).ok,false);const verified=f.call('verifier','handover.verify',args);assert.equal(verified.ok,true,JSON.stringify(verified));assert.equal(verified.payload.entity.state,'verified');assert.deepEqual(f.call('verifier','handover.verify',args),verified);
 assert.equal(f.call('verifier','handover.read',{handoverId:handover.id}).payload.revision,2);
 f.store.close();const next=openStore(f.filename);f.stores.push(next);assert.equal(next.db.prepare('SELECT state FROM handovers').get().state,'verified');
});

test('交接拒绝缺任务/错代次/自核验，旧规格与已改变成果不得确认',t=>{
 const f=fixture(t);for(const delta of [{taskSpecRevisions:[]},{expectedBindingEpoch:2},{verifierRoleId:'worker'}])assert.equal(f.call('worker','handover.prepare',{...f.prepareArgs,...delta}).ok,false);
 const q=f.call('worker','handover.prepare',f.prepareArgs).payload.entity;
 fs.writeFileSync(path.join(f.dir,'context.json'),'changed');assert.equal(f.call('verifier','handover.verify',{requestId:'verify',handoverId:q.id,expectedRevision:1,decision:'verified',evidence:[f.evidence]}).ok,false);
 assert.equal(f.store.db.prepare('SELECT state FROM handovers').get().state,'prepared');
 const stale=f.call('verifier','handover.verify',{requestId:'stale',handoverId:q.id,expectedRevision:1,decision:'stale',evidence:[f.evidence]});assert.equal(stale.ok,true);assert.equal(stale.payload.entity.state,'stale');
});

test('交接包含未决原生副作用；运行/unknown未核对前不能通过',t=>{
 const f=fixture(t),id=f.prepare('pending-native');const args={...f.prepareArgs,pendingEffects:['attempt:'+id]};
 const q=f.call('worker','handover.prepare',args);assert.equal(q.ok,true,JSON.stringify(q));
 const answer=f.call('verifier','handover.verify',{requestId:'verify',handoverId:q.payload.entity.id,expectedRevision:1,decision:'verified',evidence:[f.evidence]});assert.equal(answer.ok,false);assert.equal(answer.payload.error,'HANDOVER_PENDING_EFFECTS');assert.equal(f.calls,0);
});

test('工作区快照有界且真实变化可发现；指定内容哈希不允许模型伪造',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.driver.workspaceRoot,'file.txt'),'one');const hash=workspaceFingerprint(f.store,'p','workspace',()=>{});
 const prepared=f.call('worker','handover.prepare',{...f.prepareArgs,workspaceVersions:[{workspaceId:'workspace',contentHash:hash}]});assert.equal(prepared.ok,true,JSON.stringify(prepared));
 fs.writeFileSync(path.join(f.driver.workspaceRoot,'file.txt'),'two');assert.notEqual(workspaceFingerprint(f.store,'p','workspace',()=>{}),hash);
 assert.equal(f.call('verifier','handover.verify',{requestId:'verify',handoverId:prepared.payload.entity.id,expectedRevision:1,decision:'verified',evidence:[f.evidence]}).payload.error,'HANDOVER_WORKSPACE_CHANGED');
});

test('集成固定请求保存精确版本与检查引用；不执行合并，不把请求当通过',t=>{
 const f=fixture(t);f.store.db.exec("UPDATE workspaces SET base_version='target-v1';INSERT INTO check_definitions(project_id,id,version,definition_json,enabled) VALUES('p','build','1','{}',1)");
 const args={requestId:'integration',taskId:'task',taskRevision:1,targetWorkspaceId:'workspace',targetVersion:'target-v1',artifacts:[f.evidence],checkRefs:[{id:'build',version:'1'}]};
 const requested=f.call('worker','integration.request',args);assert.equal(requested.ok,true,JSON.stringify(requested));assert.equal(requested.payload.entity.state,'pending');assert.deepEqual(f.call('worker','integration.request',args),requested);
 assert.deepEqual(f.call('worker','integration.read',{integrationId:requested.payload.entity.id}).payload,requested.payload.entity);assert.equal(f.calls,0);
 for(const delta of [{taskRevision:2},{targetVersion:'newer'},{checkRefs:[{id:'unknown',version:'1'}]},{artifacts:[{artifactId:'unknown',version:'v1'}]}])assert.equal(f.call('worker','integration.request',{...args,requestId:'negative',...delta}).ok,false);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM integrations').get().n,1);
});

test('审计失败原子回滚、暂停/撤权拒绝，读取跨项目记录不泄露内容',t=>{
 const f=fixture(t);f.store.db.exec("CREATE TRIGGER reject_handover BEFORE INSERT ON events WHEN NEW.type='handover.prepare' BEGIN SELECT RAISE(ABORT,'TEST_AUDIT_FAILURE'); END");assert.equal(f.call('worker','handover.prepare',f.prepareArgs).ok,false);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM handovers').get().n,0);
 f.store.db.exec('DROP TRIGGER reject_handover;UPDATE projects SET user_paused=1');assert.equal(f.call('worker','handover.prepare',f.prepareArgs).ok,false);
 f.store.db.exec('UPDATE projects SET user_paused=0');const prepared=f.call('worker','handover.prepare',f.prepareArgs);assert.equal(prepared.ok,true);
 assert.equal(f.call('verifier','handover.read',{handoverId:'another-project-object'}).ok,false);
 f.store.db.prepare('UPDATE agent_credentials SET revoked_at=200 WHERE id=?').run(f.verifier.credentialId);assert.equal(f.call('verifier','handover.read',{handoverId:prepared.payload.entity.id}).ok,false);
});


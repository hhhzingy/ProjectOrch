// 生产用户命令/实际SQLite/内置验证器；无官方Harness与模型输入。
import test from 'node:test';import assert from 'node:assert/strict';
import {executionFixture} from './execution-fixture.mjs';
import {createCommandRunner} from '../../../apps/kernel/dist/commands/index.js';import {userCommandServices} from '../../../apps/kernel/dist/commands/user-review.js';
import {trustedCheckEntries,trustedCheckDefinitionForRun} from '../../../apps/kernel/dist/checks/registry.js';
import {runJsonAssertions,jsonAssertionParameters} from '../../../apps/kernel/dist/checks/validators.js';
import {createToolDispatcher} from '../../../apps/kernel/dist/tools/gateway-tools.js';
import {startLocalGateway} from '../../../apps/kernel/dist/http/local-gateway.js';import {issuePairingChallenge} from '../../../apps/kernel/dist/auth/pairing.js';import {commandErrorStatus} from '../../../apps/kernel/dist/commands/lifecycle-services.js';
import{installSyntheticPolicy}from'./synthetic-policy.mjs';

function fixture(t){const f=executionFixture(t),entry=trustedCheckEntries()[0],definition={id:'integrated-json',version:'1',runner:entry.runner,entryId:entry.entryId,entrySha256:entry.entrySha256,parameterSchemaId:entry.parameterSchemaId,permissions:entry.permissions,scopePaths:['workspace/*'],timeoutMs:5000,enabled:true},runner=createCommandRunner(f.store,userCommandServices(f.store));const register=(requestId='register',patch={})=>runner('authenticated-synthetic-user',{schemaVersion:2,requestId,projectId:'p',type:'check.register',payload:{definition:{...definition,...patch}}});return Object.assign(f,{definition,register});}

test('真实HTTP配对用户注册可信检查，缺认证/CSRF拒绝，来源从会话固定并发重放不重复授权',async t=>{
 const f=fixture(t),gateway=await startLocalGateway({store:f.store,principalId:'paired-check-user',commandRunner:createCommandRunner(f.store,userCommandServices(f.store)),commandErrorStatus});try{
  const origin=gateway.origin.origin,challenge=issuePairingChallenge(f.store),pair=await fetch(origin+'/api/v1/pairing',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({schemaVersion:2,requestId:'pair-check',challengeId:challenge.challengeId,oneTimeCode:challenge.oneTimeCode})});assert.equal(pair.status,200);const{csrfToken}=await pair.json(),headers={Origin:origin,Cookie:pair.headers.get('set-cookie').split(';')[0],'Content-Type':'application/json','x-projectorch-csrf':csrfToken};
  const command={schemaVersion:2,requestId:'http-register',projectId:'p',type:'check.register',payload:{definition:f.definition}},post=async(h=headers)=>{const r=await fetch(origin+'/api/v1/commands',{method:'POST',headers:h,body:JSON.stringify(command)});return{status:r.status,body:await r.json()};};
  assert.equal((await post({Origin:origin,'Content-Type':'application/json'})).status,401);assert.equal((await post({...headers,'x-projectorch-csrf':'wrong'})).status,401);
  assert.equal((await fetch(origin+'/api/v1/check-entries',{headers:{Origin:origin}})).status,401);const entries=await fetch(origin+'/api/v1/check-entries',{headers});assert.equal(entries.status,200);assert.equal((await entries.json()).entries[0].entrySha256,f.definition.entrySha256);
  const replies=await Promise.all([post(),post()]);assert.deepEqual(replies.map(r=>r.status),[200,200]);assert.deepEqual(replies[0].body,replies[1].body);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM check_definition_authorizations').get().n,1);assert.equal(f.store.db.prepare('SELECT authorized_user_id FROM check_definition_authorizations').get().authorized_user_id,'paired-check-user');assert.equal(trustedCheckDefinitionForRun(f.store,'p',f.definition.id,f.definition.version).definition.enabled,true);
  const read=await fetch(origin+'/api/v1/checks/'+f.definition.id+'?projectId=p&version=1',{headers});assert.equal(read.status,200);assert.deepEqual(await read.json(),f.definition);assert.equal((await fetch(origin+'/api/v1/checks/'+f.definition.id+'?projectId=other&version=1',{headers})).status,404);
 }finally{await gateway.close();}
});

test('角色仅按本项目授权读取固定检查版本；读取不是注册或执行证明',t=>{
 const f=fixture(t);f.register();installSyntheticPolicy(f.store,'p',[{id:'execution',revision:1,actions:['identity','check.read'],readPaths:['checks/*'],writePaths:[],roleIds:[],delegableActions:[],maxDelegationDepth:0}]);const call=(args)=>createToolDispatcher(f.store,{now:()=>300,callerNativeConversationId:f.session.nativeConversationId})(f.principal,'check.read',args);
 assert.deepEqual(call({checkId:f.definition.id,version:f.definition.version}).payload,f.definition);assert.equal(call({checkId:'other',version:'1'}).ok,false);assert.equal(call({checkId:f.definition.id,version:'1',projectId:'other'}).ok,false);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM integration_check_runs').get().n,0);
});

test('用户固定入口注册/停用/重新启用留不可改写授权，重放幂等，旧版本不可换代码',t=>{
 const f=fixture(t),registered=f.register();assert.equal(registered.status,'completed');assert.deepEqual(f.register(),registered);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM check_definition_authorizations').get().n,1);
 assert.equal(trustedCheckDefinitionForRun(f.store,'p','integrated-json','1').definition.entrySha256,f.definition.entrySha256);
 f.register('disable',{enabled:false});assert.throws(()=>trustedCheckDefinitionForRun(f.store,'p','integrated-json','1'),/NOT_ENABLED/);f.register('enable',{enabled:true});assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM check_definition_authorizations').get().n,3);
 assert.throws(()=>f.register('changed',{scopePaths:['other/*']}),/NEW_VERSION_REQUIRED/);assert.throws(()=>f.store.db.exec('UPDATE check_definition_authorizations SET created_at=0'),/IMMUTABLE/);assert.throws(()=>f.store.db.exec('DELETE FROM check_definition_authorizations'),/PRESERVED/);
});

test('角色无注册入口，未知runner/入口漂移/强权限拒绝，审计故障整册回滚',t=>{
 const f=fixture(t),call=createToolDispatcher(f.store,{now:()=>120,callerNativeConversationId:f.session.nativeConversationId});assert.equal(call(f.principal,'check.register',{}).ok,false);
 for(const patch of [{runner:'registered_process'},{entrySha256:'0'.repeat(64)},{permissions:['network']},{scopePaths:['../secret']},{parameterSchemaId:'arbitrary-code'},{timeoutMs:20000}])assert.throws(()=>f.register('invalid',patch));
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM check_definitions').get().n,0);
 f.store.db.exec("CREATE TRIGGER reject_check_audit BEFORE INSERT ON events WHEN NEW.type='check.registered' BEGIN SELECT RAISE(ABORT,'TEST_CHECK_AUDIT'); END");assert.throws(()=>f.register(),/TEST_CHECK_AUDIT/);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM check_definitions').get().n,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM check_definition_authorizations').get().n,0);
});

test('历史裸定义和别的项目授权不能冒充可信注册；JSON语义检查实际消费冻结字节',t=>{
 const f=fixture(t);f.store.db.prepare('INSERT INTO check_definitions(project_id,id,version,definition_json,enabled) VALUES(?,?,?,?,1)').run('p','legacy','1',JSON.stringify({...f.definition,id:'legacy'}));assert.throws(()=>trustedCheckDefinitionForRun(f.store,'p','legacy','1'),/TRUSTED_REGISTRATION_REQUIRED/);f.register();assert.throws(()=>trustedCheckDefinitionForRun(f.store,'other','integrated-json','1'),/NOT_ENABLED/);
 const parameters={files:[{path:'merged.json',assertions:[{pointer:'/sum',equals:3},{pointer:'/items/0',equals:'left'}]}]},files=new Map([['merged.json',Buffer.from('{"sum":3,"items":["left","right"]}')]]);assert.equal(runJsonAssertions(files,parameters,Date.now()+1000).outcome,'passed');
 const conflict=runJsonAssertions(new Map([['merged.json',Buffer.from('{"sum":5,"items":["left"]}')]]),parameters,Date.now()+1000);assert.equal(conflict.outcome,'failed');assert.equal(JSON.stringify(conflict).includes('"equals"'),false);
 for(const params of [{files:[{path:'../secret',assertions:[{pointer:'',equals:1}]}]}, {files:[{path:'merged.json',assertions:[{pointer:'/sum',equals:3,command:'evil'}]}]}, {files:parameters.files,passed:true}])assert.throws(()=>jsonAssertionParameters(params),/PARAMETERS_INVALID/);
 assert.throws(()=>runJsonAssertions(files,parameters,0),/TIMEOUT/);assert.equal(runJsonAssertions(files,{files:[{path:'merged.json',assertions:[{pointer:'/__proto__',equals:{}}]}]},Date.now()+1000).outcome,'failed');
});


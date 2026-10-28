import test from 'node:test';
import assert from 'node:assert/strict';
import {executionFixture} from './execution-fixture.mjs';
import {installSyntheticPolicy} from './synthetic-policy.mjs';
import {createRole} from '../../../packages/domain/dist/roles/index.js';
import {completeStartupAck} from '../../../packages/domain/dist/bootstrap/index.js';
import {issueAgentCredential,authenticateAgentCredential} from '../../../apps/kernel/dist/auth/agent-credential.js';
import {createToolDispatcher} from '../../../apps/kernel/dist/tools/gateway-tools.js';
import {advanceQuestionWorkflow} from '../../../apps/kernel/dist/execution/question-continuation.js';
import {questionContract} from '../../../apps/kernel/dist/tools/question-workflow.js';
import {mcpToolEntries,mcpToolDescription,mcpToolArguments} from '../../../apps/kernel/dist/tools/mcp-catalog.js';
import {createCommandRunner} from '../../../apps/kernel/dist/commands/index.js';
import {userCommandServices} from '../../../apps/kernel/dist/commands/user-review.js';
import {openStore} from '../../../packages/persistence/dist/index.js';
import {startLocalGateway} from '../../../apps/kernel/dist/http/local-gateway.js';
import {issuePairingChallenge} from '../../../apps/kernel/dist/auth/pairing.js';

const profile={id:'execution',revision:1,actions:['identity','task.read','task.claim','task.report_own','question.ask','question.read','question.answer_designated','message.send'],readPaths:['tasks/*','questions/*','messages/*'],writePaths:['tasks/*','questions/*','messages/*'],roleIds:[],delegableActions:[],maxDelegationDepth:0};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
export async function questionFixture(t,{claim=true}={}){
 let cleanup=async()=>{};t.after(()=>cleanup()); const f=executionFixture(t);let clock=300;
 createRole(f.store,{id:'answerer',projectId:'p',name:'合成答复者',charter:'只作离线问答测试',permissionProfileId:'execution'},101);
 f.store.db.exec("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('answerer-session','zcode','host','synthetic-only','synthetic-answerer');INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('answerer-binding','p','answerer','answerer-session',1,100);UPDATE roles SET binding_state='provisioning' WHERE id='answerer'");
 const session={harnessId:'zcode',hostId:'host',profileId:'synthetic-only',nativeConversationId:'synthetic-answerer'},credential=issueAgentCredential(f.store,'answerer-binding',1,{isolation:'verified_session',session},110,60000).credential,answerer=authenticateAgentCredential(f.store,credential,120);
 installSyntheticPolicy(f.store,'p',[profile]);
 for(const role of ['worker','answerer'])completeStartupAck(f.store,{projectId:'p',roleId:role,bindingEpoch:1,protocolVersion:2,policyRevision:1,planRevision:0,roleRevision:Number(f.store.db.prepare('SELECT revision FROM roles WHERE id=?').get(role).revision),taskSpecRevisions:[{taskId:'task',specRevision:1},{taskId:'next',specRevision:1}]},140);
 f.services.now=()=>clock;
 const id=f.prepare('question-run'),run=f.coordinator.run(id);await tick();
 const call=(actor,tool,args,overrides={})=>{const principal=actor==='worker'?f.principal:answerer;return createToolDispatcher(f.store,{now:()=>clock,callerNativeConversationId:principal.session.nativeConversationId,callerNativeExecutionId:actor==='worker'?'native-turn':'answerer-turn',...overrides})(principal,tool,args);};
 if(claim){const receipt=call('worker','task.claim',{requestId:'claim',taskId:'task',expectedRevision:1,expectedSpecRevision:1});assert.equal(receipt.ok,true,JSON.stringify(receipt));}
 const ask=(requestId='ask',changes={})=>call('worker','question.ask',{requestId,taskId:'task',taskRevision:1,attemptId:id,bindingEpoch:1,prompt:'合成问题\n请确认方案',answerer:{kind:'role',roleId:'answerer'},deadline:new Date(1000).toISOString(),onTimeout:'raise_issue',...changes});
 const wait=(q,changes={})=>call('worker','task.report',{requestId:'wait-'+q.id,taskId:'task',attemptId:id,bindingEpoch:1,report:'等待指定业务答复',wait:{target:{kind:'question',questionId:q.id,questionRevision:q.revision},deadline:q.deadline,onTimeout:q.onTimeout,taskRevision:1,attemptId:id,bindingEpoch:1,...changes}});
 cleanup=async()=>{f.finish();await run.catch(()=>undefined);};
 return Object.assign(f,{answerer,credential,id,run,call,ask,wait,setClock:value=>{clock=value;}});
}

test('真实执行轮已running但任务未领取时提问拒绝；同尝试正确领取后才能创建问题',async t=>{
 const f=await questionFixture(t,{claim:false});
 assert.equal(f.store.db.prepare('SELECT state FROM attempts WHERE id=?').get(f.id).state,'running');
 assert.equal(f.store.db.prepare("SELECT state FROM tasks WHERE id='task'").get().state,'draft');
 const denied=f.ask('before-claim',{answerer:{kind:'user'}});assert.equal(denied.ok,false);assert.match(JSON.stringify(denied),/QUESTION_EXECUTION_NOT_CURRENT/);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM questions').get().n,0);
 const attemptsBefore=Number(f.store.db.prepare('SELECT COUNT(*) n FROM attempts').get().n),sendsBefore=f.calls;
 assert.equal(f.call('worker','task.claim',{requestId:'claim-current',taskId:'task',expectedRevision:1,expectedSpecRevision:1}).ok,true);
 assert.equal(f.store.db.prepare("SELECT state FROM tasks WHERE id='task'").get().state,'active');
 assert.equal(Number(f.store.db.prepare('SELECT COUNT(*) n FROM attempts').get().n),attemptsBefore);assert.equal(f.calls,sendsBefore);
 const asked=f.ask('after-claim',{answerer:{kind:'user'}});assert.equal(asked.ok,true);assert.equal(asked.payload.question.attemptId,f.id);
 assert.equal(f.store.db.prepare('SELECT attempt_id FROM questions WHERE id=?').get(asked.payload.question.id).attempt_id,f.id);
 const args={requestId:'wrong-execution',taskId:'task',taskRevision:1,attemptId:f.id,bindingEpoch:1,prompt:'合成问题',answerer:{kind:'user'},deadline:new Date(1000).toISOString(),onTimeout:'raise_issue'};
 assert.equal(f.call('worker','question.ask',args,{callerNativeExecutionId:'wrong-turn'}).ok,false);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM questions').get().n,1);
});

test('固定MCP问答合同：真实尝试提问/指定角色答复/持久幂等，未指定者与伪造来源拒绝',async t=>{
 const f=await questionFixture(t);for(const name of ['question.ask','question.answer','question.read','question.list']){const entry=mcpToolEntries.find(e=>e.tool===name);assert.ok(entry);assert.ok(mcpToolDescription(entry).inputSchema.properties);}
 const first=f.ask();assert.equal(first.ok,true,JSON.stringify(first));const q=first.payload.question;assert.equal(q.prompt,'合成问题\n请确认方案');assert.equal(q.onTimeout,'raise_issue');assert.equal(q.answer,null);assert.deepEqual(f.ask(),first);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM questions').get().n,1);assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind='question_notice'").get().n,1);
 assert.equal(f.call('worker','question.answer',{requestId:'wrong',questionId:q.id,expectedRevision:0,answer:'forged'}).ok,false);
 const args={requestId:'answer',questionId:q.id,expectedRevision:0,answer:'方案B'};const answered=f.call('answerer','question.answer',args);assert.equal(answered.ok,true,JSON.stringify(answered));assert.equal(answered.payload.question.answer,'方案B');assert.deepEqual(f.call('answerer','question.answer',args),answered);
 assert.equal(f.call('answerer','question.answer',{...args,answer:'replace'}).ok,false);assert.equal(f.call('answerer','question.answer',{...args,requestId:'again'}).ok,false);
 assert.equal(f.call('answerer','question.read',{questionId:q.id}).payload.answer,'方案B');assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind='question_answer'").get().n,0,'回答不另开原会话的未跟踪执行轮');
 assert.throws(()=>mcpToolArguments(mcpToolEntries.find(e=>e.tool==='question.answer'),{...args,principal:{kind:'user'}}));
});
test('答案及时解阻业务但不启动第二轮：原模型结束后同绑定就绪，冻结输入包含原答案',async t=>{
 const f=await questionFixture(t),q=f.ask().payload.question;assert.equal(f.wait(q).ok,true);
 assert.equal(f.call('answerer','question.answer',{requestId:'answer',questionId:q.id,expectedRevision:0,answer:'采用B'}).ok,true);
 const first=advanceQuestionWorkflow(f.store,300);assert.equal(first.resolved,1);assert.equal(first.resumed,0);assert.equal(f.store.db.prepare("SELECT state FROM tasks WHERE id='task'").get().state,'waiting');assert.equal(f.calls,1);
 f.finish();assert.equal(await f.run,'succeeded');assert.equal(advanceQuestionWorkflow(f.store,301).resumed,1);assert.equal(advanceQuestionWorkflow(f.store,302).resumed,0);
 const next=f.prepare('continued','task');assert.equal(f.row(next).binding_id,'binding');const frozen=JSON.parse(f.row(next).input_json);assert.equal(frozen.resolvedQuestions[0].answer,'采用B');assert.equal(frozen.resolvedQuestions[0].questionId,q.id);assert.equal(f.calls,1,'准备本身不调用模型');
});
test('暂停期间保存答案，unknown与旧规格/旧绑定不被答案释放；恢复后才重评估',async t=>{
 for(const mode of ['pause','unknown','spec','binding'])await t.test(mode,async inner=>{
  const f=await questionFixture(inner),q=f.ask().payload.question;assert.equal(f.wait(q).ok,true);
  assert.equal(f.call('answerer','question.answer',{requestId:'answer',questionId:q.id,expectedRevision:0,answer:'B'}).ok,true);
  if(mode==='pause')f.store.db.exec('UPDATE projects SET user_paused=1');
  if(mode==='unknown')f.store.db.prepare("UPDATE attempts SET state='unknown' WHERE id=?").run(f.id);
  if(mode==='spec')f.store.db.exec("UPDATE tasks SET spec_revision=spec_revision+1 WHERE id='task'");
  if(mode==='binding')f.store.db.exec("UPDATE role_bindings SET ended_at=301 WHERE id='binding'");
  const result=advanceQuestionWorkflow(f.store,302);assert.equal(result.resumed,0);assert.equal(f.calls,1);
  if(['spec','binding'].includes(mode))assert.equal(f.store.db.prepare('SELECT state FROM waits').get().state,'stale');
  if(mode==='unknown'){assert.equal(f.store.db.prepare('SELECT state FROM waits').get().state,'waiting');assert.equal(f.reservation().state,'reserved');}
  if(mode==='pause'){f.finish();await f.run;assert.equal(advanceQuestionWorkflow(f.store,303).resumed,0);f.store.db.exec('UPDATE projects SET user_paused=0');assert.equal(advanceQuestionWorkflow(f.store,304).resumed,1);}
 });
});
test('问题超时只生成一次异常/停止请求，不伪造原生已停止；答案与超时胜者唯一',async t=>{
 for(const policy of ['raise_issue','cancel_attempt'])await t.test(policy,async inner=>{
  const f=await questionFixture(inner),q=f.ask('ask',{onTimeout:policy}).payload.question;assert.equal(f.wait(q).ok,true);f.setClock(1000);
  assert.equal(f.call('answerer','question.answer',{requestId:'late',questionId:q.id,expectedRevision:0,answer:'late'}).ok,false);
  assert.equal(advanceQuestionWorkflow(f.store,1000).expired,1);assert.equal(advanceQuestionWorkflow(f.store,1001).expired,0);assert.equal(f.store.db.prepare('SELECT state FROM questions').get().state,'expired');assert.equal(f.store.db.prepare('SELECT state FROM attempts WHERE id=?').get(f.id).state,'running');assert.equal(f.reservation().state,'reserved');
  if(policy==='raise_issue')assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM cases').get().n,1);else assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM native_control_requests WHERE state='pending'").get().n,1);
 });
});
test('用户问题只能由认证用户命令回答；审计失败全事务回滚，原问题/来源不可改写',async t=>{
 const f=await questionFixture(t),q=f.ask('user-question',{answerer:{kind:'user'}}).payload.question;
 assert.equal(f.call('answerer','question.answer',{requestId:'fake-user',questionId:q.id,expectedRevision:0,answer:'pretend'}).ok,false);
 const runner=createCommandRunner(f.store,userCommandServices(f.store,()=>300)),command={schemaVersion:2,requestId:'real-user',projectId:'p',type:'question.answer',payload:{questionId:q.id,expectedRevision:0,answer:'用户选B'}};
 f.store.db.exec("CREATE TRIGGER reject_answer_event BEFORE INSERT ON events WHEN NEW.type='question.answered' BEGIN SELECT RAISE(ABORT,'TEST_AUDIT_FAILURE'); END");assert.throws(()=>runner('synthetic-user',command),/TEST_AUDIT_FAILURE/);assert.equal(questionContract(f.store.db,'p',q.id).answer,null);
 f.store.db.exec('DROP TRIGGER reject_answer_event');const saved=runner('synthetic-user',command);assert.equal(saved.status,'completed');assert.deepEqual(runner('synthetic-user',command),saved);assert.equal(questionContract(f.store.db,'p',q.id).answer,'用户选B');
 assert.throws(()=>f.store.db.prepare('UPDATE questions SET on_timeout=? WHERE id=?').run('cancel_attempt',q.id),/QUESTION_IDENTITY_IMMUTABLE/);
});
test('问题读取分页、撤权与跨项目边界；超量提问不形成无限管理循环',async t=>{
 const f=await questionFixture(t);for(let n=0;n<3;n++)assert.equal(f.ask('ask-'+n).ok,true);const extra=f.ask('fourth');assert.equal(extra.ok,false);assert.match(extra.payload.error,/QUESTION_ROUND_LIMIT_EXCEEDED/);
 const page=f.call('answerer','question.list',{projectId:'p',limit:1});assert.equal(page.ok,true);assert.equal(page.payload.items.length,1);assert.ok(page.payload.nextCursor);assert.equal(f.call('answerer','question.list',{projectId:'other'}).ok,false);
 const q=page.payload.items[0];f.call('answerer','question.answer',{requestId:'answer',questionId:q.id,expectedRevision:0,answer:'B'});assert.equal(f.call('answerer','question.list',{projectId:'p',limit:1,cursor:page.payload.nextCursor}).payload.error,'PAGE_CURSOR_STALE');
 f.store.db.prepare('UPDATE agent_credentials SET revoked_at=250 WHERE id=?').run(f.answerer.credentialId);assert.equal(f.call('answerer','question.read',{questionId:q.id}).ok,false);
});

test('问答HTTP真实回环：认证、CSRF、指定用户、并发答复只有一个赢家且幂等回放',async t=>{
 const f=await questionFixture(t),q=f.ask('http',{answerer:{kind:'user'}}).payload.question;
 const gateway=await startLocalGateway({store:f.store,principalId:'synthetic-local-user',now:()=>300,commandRunner:createCommandRunner(f.store,userCommandServices(f.store,()=>300))});
 try{
  const origin=`http://127.0.0.1:${gateway.port}`,challenge=issuePairingChallenge(f.store,300),request=(route,method='GET',body,headers={})=>fetch(origin+route,{method,headers:{Origin:origin,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.equal((await request('/api/v1/questions/'+q.id)).status,401);
  const pair=await request('/api/v1/pairing','POST',{schemaVersion:2,requestId:'pair',challengeId:challenge.challengeId,oneTimeCode:challenge.oneTimeCode},{'Content-Type':'application/json'});assert.equal(pair.status,200);
  const csrf=(await pair.json()).csrfToken,headers={Cookie:pair.headers.get('set-cookie').split(';')[0],'Content-Type':'application/json','x-projectorch-csrf':csrf};
  const listed=await request('/api/v1/projects/p/questions','GET',undefined,headers);assert.equal(listed.status,200);assert.equal((await listed.json()).items[0].id,q.id);
  assert.equal((await request('/api/v1/projects/p/questions?actor=user','GET',undefined,headers)).status,400);
  assert.deepEqual(await(await request('/api/v1/questions/'+q.id,'GET',undefined,headers)).json(),q);
  const command={schemaVersion:2,requestId:'http-answer',projectId:'p',type:'question.answer',payload:{questionId:q.id,expectedRevision:0,answer:'HTTP答复'}};
  assert.equal((await request('/api/v1/commands','POST',command,{...headers,'x-projectorch-csrf':'wrong'})).status,401);
  assert.equal((await request('/api/v1/commands','POST',{...command,actor:{kind:'user'}},headers)).status,400);
  const responses=await Promise.all([request('/api/v1/commands','POST',command,headers),request('/api/v1/commands','POST',{...command,requestId:'competing',payload:{...command.payload,answer:'竞争答复'}},headers)]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,400]);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='question.answered'").get().n,1);
  const winner=responses[0].status===200?command:{...command,requestId:'competing',payload:{...command.payload,answer:'竞争答复'}};
  assert.equal((await request('/api/v1/commands','POST',winner,headers)).status,200);
  assert.equal((await request('/api/v1/questions/'+q.id+'?actor=user','GET',undefined,headers)).status,400);
 }finally{await gateway.close();}
});

test('重启读取已保存答复后只恢复一次；超时副作用与审计事件同事务回滚',async t=>{
 const f=await questionFixture(t),q=f.ask().payload.question;assert.equal(f.wait(q).ok,true);
 f.call('answerer','question.answer',{requestId:'answer',questionId:q.id,expectedRevision:0,answer:'重启后继续'});f.finish();await f.run;
 f.store.close();const restarted=openStore(f.filename);f.stores.push(restarted);
 assert.equal(advanceQuestionWorkflow(restarted,301).resumed,1);restarted.close();
 const twice=openStore(f.filename);f.stores.push(twice);assert.equal(advanceQuestionWorkflow(twice,302).resumed,0);assert.equal(questionContract(twice.db,'p',q.id).answer,'重启后继续');
});

test('超时审计失败时问题、等待、异常均回滚；非当前执行来源不能创建问题',async t=>{
 const f=await questionFixture(t);
 const args={requestId:'wrong-execution',taskId:'task',taskRevision:1,attemptId:f.id,bindingEpoch:1,prompt:'错误来源',answerer:{kind:'user'},deadline:new Date(1000).toISOString(),onTimeout:'raise_issue'};
 assert.equal(f.call('worker','question.ask',args,{callerNativeExecutionId:'wrong-turn'}).ok,false);
 const q=f.ask().payload.question;f.wait(q);
 f.store.db.exec("CREATE TRIGGER reject_expiry_event BEFORE INSERT ON events WHEN NEW.type='question.expired' BEGIN SELECT RAISE(ABORT,'TEST_EXPIRY_AUDIT_FAILURE'); END");
 assert.throws(()=>advanceQuestionWorkflow(f.store,1000),/TEST_EXPIRY_AUDIT_FAILURE/);assert.equal(questionContract(f.store.db,'p',q.id).state,'open');assert.equal(f.store.db.prepare('SELECT state FROM waits').get().state,'waiting');assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM cases').get().n,0);
 f.store.db.exec('DROP TRIGGER reject_expiry_event');assert.equal(advanceQuestionWorkflow(f.store,1001).expired,1);
});

test('小批次轮询不被已解答但原生仍运行的问题占满，后续等待仍能得到处理',async t=>{
 const f=await questionFixture(t),first=f.ask('first',{deadline:new Date(900).toISOString()}).payload.question;f.wait(first);
 f.call('answerer','question.answer',{requestId:'answer-first',questionId:first.id,expectedRevision:0,answer:'一'});assert.equal(advanceQuestionWorkflow(f.store,300,1).resolved,1);
 const second=f.ask('second').payload.question;assert.equal(f.wait(second).ok,true);
 f.call('answerer','question.answer',{requestId:'answer-second',questionId:second.id,expectedRevision:0,answer:'二'});
 assert.equal(advanceQuestionWorkflow(f.store,301,1).resolved,1);assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM waits WHERE state='waiting'").get().n,0);assert.equal(f.calls,1);
});


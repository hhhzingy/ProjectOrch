import test from 'node:test';
import assert from 'node:assert/strict';
import {executionFixture} from './execution-fixture.mjs';

// 真实生产协调器+合成持久历史；不启动官方软件或模型。
function history(f,count=129,answer='决策'){
 f.services.now=()=>5000;
 f.store.transaction(db=>{
  db.exec("UPDATE projects SET policy_json=json_set(policy_json,'$.limits.maxAttempts',32,'$.limits.maxManagementRounds',16) WHERE id='p'");
  for(let a=1;a<=Math.ceil(count/16);a++)db.prepare("INSERT INTO attempts(id,project_id,task_id,task_revision,binding_id,binding_epoch,state,native_execution_id,started_at,ended_at) VALUES(?,'p','task',1,'binding',1,'succeeded',?,200,3000)").run('history-'+a,'turn-'+a);
  for(let n=1;n<=count;n++){
   const ask='ask-'+n,reply='reply-'+n;
   for(const [id,type]of [[ask,'question.ask'],[reply,'question.answer']])db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES(?,'p','synthetic-user',?,?,?,'{}','completed',?)").run(id,id,'0'.repeat(64),type,1000+n);
   db.prepare("INSERT INTO questions(id,project_id,revision,task_id,task_revision,attempt_id,binding_id,binding_epoch,answerer_kind,prompt,answer,deadline,state,ask_command_id,on_timeout,answer_command_id,answered_at) VALUES(?,'p',1,'task',1,?,'binding',1,'user',?,?,10000,'answered',?,'raise_issue',?,?)").run('question-'+n,'history-'+Math.ceil(n/16),'合成问题'+n,JSON.stringify(answer+'-'+n),ask,reply,1000+n);
  }
 });
}

test('129个合法历史问题完整冻结，最新必要答案与最早约束同时保留，多答案不会互相挤掉',t=>{
 const f=executionFixture(t);history(f);
 const id=f.prepare('history-next'),input=JSON.parse(f.row(id).input_json);assert.equal(input.resolvedQuestions.length,129);
 for(const n of [1,127,128,129])assert.equal(input.resolvedQuestions.find(q=>q.questionId==='question-'+n).answer,'决策-'+n);
 assert.equal(f.calls,0);assert.equal(f.row(id).binding_id,'binding');
});

test('旧规格答案不会混入当前决策；当前历史不靠倒序截断',t=>{
 const f=executionFixture(t);history(f,3);
 // 模拟实际新规格：旧问题身份不改写，当前尝试改为新规格后不带旧答案。
 const revision=f.store.db.prepare("SELECT * FROM task_revisions WHERE task_id='task' AND revision=1").get();
 f.store.db.prepare('INSERT INTO task_revisions(task_id,project_id,revision,snapshot_json) VALUES(?,?,2,?)').run('task','p',revision.snapshot_json);
 f.store.db.exec("UPDATE tasks SET spec_revision=2 WHERE id='task';UPDATE role_startup_acks SET task_specs_json='[{\"taskId\":\"task\",\"specRevision\":2},{\"taskId\":\"next\",\"specRevision\":1}]'");
 const id=f.prepare('new-spec');assert.deepEqual(JSON.parse(f.row(id).input_json).resolvedQuestions,[]);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM questions').get().n,3);
});

test('超长答案明确阻塞且无预约/驱动发送；不会默默截断后运行',t=>{
 const f=executionFixture(t);history(f,2,'大'.repeat(12000));
 assert.throws(()=>f.prepare('oversized'),/TASK_EXECUTION_INPUT_TOO_LARGE/);
 assert.equal(f.calls,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM execution_dispatches').get().n,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM workspace_reservations').get().n,0);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM questions').get().n,2);
});

test('已结束旧绑定的问题保持历史，不进入当前绑定输入',t=>{
 const f=executionFixture(t);history(f,1);
 f.store.transaction(db=>{
  db.exec("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('old-session','zcode','host','synthetic','old-native');INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at,ended_at) VALUES('old-binding','p','worker','old-session',2,100,200);INSERT INTO attempts(id,project_id,task_id,task_revision,binding_id,binding_epoch,state,started_at,ended_at) VALUES('old-attempt','p','task',1,'old-binding',2,'succeeded',100,200)");
  db.exec("INSERT INTO questions(id,project_id,revision,task_id,task_revision,attempt_id,binding_id,binding_epoch,answerer_kind,prompt,answer,deadline,state,ask_command_id,on_timeout,answer_command_id,answered_at) VALUES('old-question','p',1,'task',1,'old-attempt','old-binding',2,'user','旧绑定问题','\"旧绑定决策\"',10000,'answered','ask-1','raise_issue','reply-1',300)");
 });
 const id=f.prepare('current-binding'),questions=JSON.parse(f.row(id).input_json).resolvedQuestions;assert.deepEqual(questions.map(q=>q.questionId),['question-1']);
});

test('准备后新增过大答案，在异步实际发送边界拒绝，不能复用旧准入快照',async t=>{
 const f=executionFixture(t);history(f,1,'早期决策');const id=f.prepare('reserved');let sends=0;
 f.setStart((_input,_started,assertCanSend)=>({result:Promise.resolve().then(()=>{
  // 回答字段本身由固定答复路径写入；此处合成发送前历史增长，不改问题身份。
  f.store.db.prepare('UPDATE questions SET answer=? WHERE id=?').run(JSON.stringify('超大'.repeat(40000)),'question-1');
  assertCanSend();sends++;return {session:f.session,executionId:'unreachable',status:'completed',terminalConfirmed:true};
 })}));
 assert.equal(await f.coordinator.run(id),'cancelled');assert.equal(sends,0);assert.equal(f.reservation().state,'released');
});


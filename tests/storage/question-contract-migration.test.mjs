import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openStore,defaultMigrations} from '../../packages/persistence/dist/index.js';
import {createProject} from '../../packages/domain/dist/projects/index.js';
import {createRole} from '../../packages/domain/dist/roles/index.js';
import {createTaskWithin} from '../../packages/domain/dist/tasks/index.js';
import {questionContract} from '../../apps/kernel/dist/tools/question-workflow.js';
import {advanceQuestionWorkflow} from '../../apps/kernel/dist/execution/question-continuation.js';
import {temporaryDirectory} from '../adapters/temporary-directory.mjs';

test('21→22保留旧问题与对象答案，不猜填命令来源/超时策略；旧库备份可查且新版拒绝伪装新合同',t=>{
 const stores=[],dir=temporaryDirectory(t,'projectorch-question-migration-',()=>{for(const s of stores)if(!s.closed)s.close();}),filename=path.join(dir,'state.sqlite');
 const previous=openStore(filename,{migrations:defaultMigrations().slice(0,21)});stores.push(previous);
 createProject(previous,{id:'p',name:'合成旧问题',hostId:'h',canonicalRoot:dir,objective:'仅迁移验证'},100);createRole(previous,{id:'r',projectId:'p',name:'旧角色',charter:'不改写',permissionProfileId:'execution'},101);
 previous.transaction(db=>createTaskWithin(db,{id:'t',projectId:'p',roleId:'r',goal:'合成任务',inputArtifacts:[],outputRequirements:[],acceptance:[],dependencies:[]},102));
 previous.db.exec("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s','zcode','h','synthetic','legacy');INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b','p','r','s',1,100);INSERT INTO attempts(id,project_id,task_id,task_revision,binding_id,binding_epoch,state,started_at) VALUES('a','p','t',1,'b',1,'succeeded',100);INSERT INTO questions(id,project_id,task_id,task_revision,attempt_id,binding_id,binding_epoch,answerer_kind,prompt,answer,deadline,state) VALUES('q','p','t',1,'a','b',1,'user','旧问题','{\"choice\":\"B\"}',200,'answered')");
 const original={...previous.db.prepare('SELECT * FROM questions').get()};previous.close();
 const upgraded=openStore(filename);stores.push(upgraded);assert.ok(upgraded.migrationBackup);
 const row={...upgraded.db.prepare('SELECT * FROM questions').get()};for(const [key,value]of Object.entries(original))assert.deepEqual(row[key],value,key);
 for(const key of ['ask_command_id','on_timeout','answer_command_id','answered_at'])assert.equal(row[key],null,key);
 assert.throws(()=>questionContract(upgraded.db,'p','q'),/QUESTION_LEGACY_REQUIRES_REPAIR/);assert.deepEqual(advanceQuestionWorkflow(upgraded,1000),{resolved:0,resumed:0,expired:0,stale:0});
 assert.equal(upgraded.db.prepare('PRAGMA foreign_key_check').all().length,0);assert.equal(upgraded.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 const backup=new DatabaseSync(upgraded.migrationBackup,{readOnly:true});try{assert.equal(backup.prepare('PRAGMA user_version').get().user_version,21);assert.deepEqual({...backup.prepare('SELECT * FROM questions').get()},original);}finally{backup.close();}
});

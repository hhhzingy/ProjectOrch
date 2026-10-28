import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openStore,defaultMigrations} from '../../packages/persistence/dist/index.js';
import {createProject} from '../../packages/domain/dist/projects/index.js';
import {createRole} from '../../packages/domain/dist/roles/index.js';
import {temporaryDirectory} from '../adapters/temporary-directory.mjs';

test('19→20保留原配置、观察、职责和旧握手，生成独立历史与升级前一致快照',t=>{
 const stores=[],dir=temporaryDirectory(t,'projectorch-model-migration-',()=>{for(const s of stores)if(!s.closed)s.close();}),filename=path.join(dir,'state.sqlite');
 const old=openStore(filename,{migrations:defaultMigrations().slice(0,19)});stores.push(old);createProject(old,{id:'p',name:'legacy',hostId:'h',canonicalRoot:dir,objective:'synthetic migration'},100);createRole(old,{id:'r',projectId:'p',name:'legacy role',charter:'unchanged',permissionProfileId:'profile'},101);
 const requested=JSON.stringify({raw:'legacy strict request',recordedAt:200}),resolved=JSON.stringify({modelId:'legacy-model',reasoningLevel:'high',basis:'legacy source',resolvedAt:200}),effective=JSON.stringify({modelId:'old-observation',providerId:null,observedAt:190,basis:'session-authoritative'});
 old.db.prepare("UPDATE roles SET revision=3,model_requested_json=?,model_resolved_json=?,model_effective_json=? WHERE id='r'").run(requested,resolved,effective);
 old.db.exec("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s','codex','h','synthetic','legacy-native');INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b','p','r','s',1,100);INSERT INTO role_startup_acks(binding_id,project_id,binding_epoch,role_revision,policy_revision,plan_revision,task_specs_json,acknowledged_at) VALUES('b','p',1,2,0,0,'[]',200)");old.close();
 const upgraded=openStore(filename);stores.push(upgraded);assert.ok(upgraded.migrationBackup);const role=upgraded.db.prepare("SELECT revision,model_preference_revision,model_requested_json,model_resolved_json,model_effective_json FROM roles WHERE id='r'").get();assert.equal(role.revision,3);assert.equal(role.model_preference_revision,1);assert.equal(role.model_requested_json,requested);assert.equal(role.model_resolved_json,resolved);assert.equal(role.model_effective_json,effective);
 assert.equal(upgraded.db.prepare('SELECT role_revision FROM role_startup_acks').get().role_revision,2,'旧握手不猜填到新角色版本');const history=upgraded.db.prepare('SELECT * FROM role_model_revisions').get();assert.equal(history.origin,'legacy_snapshot');assert.equal(history.requested_json,requested);assert.equal(history.previous_effective_json,effective);
 const backup=new DatabaseSync(upgraded.migrationBackup,{readOnly:true});try{assert.equal(backup.prepare('PRAGMA user_version').get().user_version,19);assert.equal(backup.prepare("SELECT model_requested_json FROM roles WHERE id='r'").get().model_requested_json,requested);}finally{backup.close();}
 assert.equal(upgraded.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
});

import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {openStore,defaultMigrations} from '../../packages/persistence/dist/index.js';
import {createProject} from '../../packages/domain/dist/projects/index.js';import {createRole} from '../../packages/domain/dist/roles/index.js';
import {registerWorkspace} from '../../packages/domain/dist/workspaces/index.js';import {evaluateDispatch} from '../../packages/domain/dist/dispatch-guard/index.js';
import {temporaryDirectory} from '../adapters/temporary-directory.mjs';

test('26→27保留旧unknown原文，不补造owned；坏迁移回滚，旧程序拒新库',t=>{
 const stores=[],root=temporaryDirectory(t,'projectorch-native-write-upgrade-',()=>{for(const s of stores)if(!s.closed)s.close();}),filename=path.join(root,'state.sqlite'),legacy=defaultMigrations().filter(m=>m.version<=26),current=defaultMigrations();
 const old=openStore(filename,{migrations:legacy});stores.push(old);createProject(old,{id:'p',name:'legacy',hostId:'h',canonicalRoot:root,objective:'合成迁移'},100);createRole(old,{id:'worker',projectId:'p',name:'worker',charter:'synthetic',permissionProfileId:'execution'},110);
 const payload=JSON.stringify({toRoleId:'worker',body:'SYNTHETIC_ONLY'}),steps=JSON.stringify([{step:'factory-call',state:'sent',detail:null,at:120}]);
 old.db.prepare("INSERT INTO durable_operations(id,operation_key,kind,project_id,payload_json,state,steps_json,created_at,updated_at) VALUES('old-op','old-key','message.send','p',?,'unknown',?,120,130)").run(payload,steps);
 old.db.exec("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('old-cmd','p','synthetic','old-request','hash','message.send','{}','completed',120);INSERT INTO messages(id,project_id,command_id,to_role_id,kind,body,delivery_json,state,created_at) VALUES('old-message','p','old-cmd','worker','information','SYNTHETIC_ONLY','{}','uncertain',120)");old.close();
 fs.writeFileSync(path.join(root,'protected-source.txt'),'SYNTHETIC_PROTECTED');
 const failed=[...legacy,{...current.find(m=>m.version===27),sql:current.find(m=>m.version===27).sql+'\nTHIS_IS_A_SYNTHETIC_BAD_MIGRATION;'}];assert.throws(()=>openStore(filename,{migrations:failed}));
 const rollback=openStore(filename,{migrations:legacy});stores.push(rollback);assert.equal(rollback.db.prepare('PRAGMA user_version').get().user_version,26);assert.equal(rollback.db.prepare("SELECT state FROM durable_operations WHERE id='old-op'").get().state,'unknown');assert.equal(rollback.db.prepare("SELECT name FROM sqlite_master WHERE name='native_write_effects'").get(),undefined);rollback.close();
 const upgraded=openStore(filename);stores.push(upgraded);assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,27);assert.equal(upgraded.db.prepare('SELECT COUNT(*) n FROM native_write_effects').get().n,0);assert.equal(upgraded.db.prepare('SELECT COUNT(*) n FROM native_write_effect_observations').get().n,0);
 assert.deepEqual({...upgraded.db.prepare("SELECT payload_json,steps_json,state FROM durable_operations WHERE id='old-op'").get()},{payload_json:payload,steps_json:steps,state:'unknown'});assert.equal(upgraded.db.prepare("SELECT state FROM messages WHERE id='old-message'").get().state,'uncertain');
 const workspace=path.join(root,'workspace');fs.mkdirSync(workspace);registerWorkspace(upgraded,{id:'ws',projectId:'p',canonicalPath:workspace,enforcement:'enforced'},150);assert.ok(evaluateDispatch(upgraded,{projectId:'p',roleId:'worker',bindingEpoch:1,taskId:'not-created',taskRevision:1,workspaceId:'ws'}).denials.some(d=>d.code==='WORKSPACE_CONFLICT'));
 upgraded.close();assert.throws(()=>openStore(filename,{migrations:legacy}),/NEWER|UNSUPPORTED|SCHEMA/);assert.equal(fs.readFileSync(path.join(root,'protected-source.txt'),'utf8'),'SYNTHETIC_PROTECTED');
});

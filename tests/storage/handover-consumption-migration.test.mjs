// 真实SQLite迁移与约束；合成业务记录，不是原生接替验收。
import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {openStore,defaultMigrations} from '../../packages/persistence/dist/index.js';
import {createProject} from '../../packages/domain/dist/projects/index.js';import {createRole} from '../../packages/domain/dist/roles/index.js';
import {temporaryDirectory} from '../adapters/temporary-directory.mjs';

function fixture(t){const stores=[],dir=temporaryDirectory(t,'projectorch-handover-migration-',()=>{for(const s of stores)if(!s.closed)s.close();}),filename=path.join(dir,'state.sqlite'),legacy=defaultMigrations().slice(0,23),store=openStore(filename,{migrations:legacy});stores.push(store);
 createProject(store,{id:'p',name:'旧交接记录',hostId:'h',canonicalRoot:dir,objective:'迁移不得制造消费来源'},100);createRole(store,{id:'r',projectId:'p',name:'执行者',charter:'保留',permissionProfileId:'execution'},101);
 store.db.exec("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s','zcode','h','synthetic','old');INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b','p','r','s',1,100);INSERT INTO handovers(id,project_id,role_id,revision,from_binding_epoch,plan_revision,package_json,verifier_role_id,state) VALUES('h','p','r',3,1,0,'{}','r','consumed')");
 const original={...store.db.prepare('SELECT * FROM handovers').get()};store.close();return{stores,filename,legacy,original};}

test('23→24保留旧交接与备份，不猜填消费来源；旧程序拒新库',t=>{const f=fixture(t),s=openStore(f.filename,{migrations:defaultMigrations().slice(0,24)});f.stores.push(s);
 assert.equal(s.db.prepare('PRAGMA user_version').get().user_version,24);assert.deepEqual({...s.db.prepare('SELECT * FROM handovers').get()},f.original);assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM handover_consumptions').get().n,0);
 assert.equal(s.db.prepare('PRAGMA foreign_key_check').all().length,0);assert.equal(s.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 const backup=new DatabaseSync(s.migrationBackup,{readOnly:true});try{assert.equal(backup.prepare('PRAGMA user_version').get().user_version,23);assert.deepEqual({...backup.prepare('SELECT * FROM handovers').get()},f.original);}finally{backup.close();}
 s.close();assert.throws(()=>openStore(f.filename,{migrations:f.legacy}),/DATABASE_NEWER_THAN_APPLICATION/);
});

test('24迁移中途失败整体回滚，旧交接与23版仍可用',t=>{const f=fixture(t),migration=defaultMigrations()[23];assert.throws(()=>openStore(f.filename,{migrations:[...f.legacy,{...migration,sql:migration.sql+'\nSELECT * FROM deliberately_missing_table;'}]}),/no such table/);
 const s=openStore(f.filename,{migrations:f.legacy});f.stores.push(s);assert.equal(s.db.prepare('PRAGMA user_version').get().user_version,23);assert.deepEqual({...s.db.prepare('SELECT * FROM handovers').get()},f.original);assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='handover_consumptions'").get().n,0);
});

test('数据库拒绝伪造消费来源，包括只更换内部session主键但原生身份相同',t=>{const f=fixture(t),s=openStore(f.filename);f.stores.push(s);
 s.db.exec("UPDATE role_bindings SET ended_at=200 WHERE id='b';INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id,native_workspace_id) VALUES('same-native','zcode','h','synthetic','old','other-cwd');INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('next','p','r','same-native',2,200);INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('c','p','synthetic','request','hash','role.provision','{}','completed',200)");
 const insert=()=>s.db.prepare("INSERT INTO handover_consumptions VALUES('h','p','r','b',1,'next',2,'c',200)").run();assert.throws(insert,/HANDOVER_CONSUMPTION_SOURCE_MISMATCH/);
 s.db.exec("UPDATE sessions SET native_conversation_id='new' WHERE id='same-native'");insert();assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM handover_consumptions').get().n,1);
 assert.throws(()=>s.db.exec('UPDATE handover_consumptions SET consumed_at=201'),/IMMUTABLE/);assert.throws(()=>s.db.exec('DELETE FROM handover_consumptions'),/IMMUTABLE|PRESERVED/);assert.throws(insert,/UNIQUE/);
});

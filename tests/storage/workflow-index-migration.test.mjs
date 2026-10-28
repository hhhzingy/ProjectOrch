import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {openStore,defaultMigrations} from '../../packages/persistence/dist/index.js';
import {temporaryDirectory} from '../adapters/temporary-directory.mjs';

test('20→21仅新增查询索引，升级备份/空库完整性与候选查找索引可核对',t=>{
 const stores=[],directory=temporaryDirectory(t,'projectorch-workflow-index-',()=>{for(const s of stores)if(!s.closed)s.close();}),filename=path.join(directory,'state.sqlite');
 const previous=openStore(filename,{migrations:defaultMigrations().slice(0,20)});stores.push(previous);previous.close();const current=openStore(filename,{migrations:defaultMigrations().slice(0,21)});stores.push(current);assert.ok(current.migrationBackup);
 assert.equal(current.db.prepare('PRAGMA user_version').get().user_version,21);assert.equal(current.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 const explain=current.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM outbox WHERE state='pending' AND json_extract(payload_json,'$.event')='workflow.evaluate' AND json_extract(payload_json,'$.projectId')=? AND json_extract(payload_json,'$.taskId')=? AND json_extract(payload_json,'$.taskRevision')=? AND json_extract(payload_json,'$.specRevision')=?").all('p','task',1,1);assert.match(JSON.stringify(explain),/workflow_pending_target/);
});

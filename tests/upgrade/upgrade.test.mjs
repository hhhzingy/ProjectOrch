/** T050/A068+A069：备份迁移与回滚集成测试。
 * A068：WAL活跃+任务消息→一致性备份→隔离恢复→状态完整+待发动作恢复先核对（不自动重放）。
 * A069：迁移注入失败→原子回滚旧库可用；旧程序开新库拒绝（DATABASE_NEWER_THAN_APPLICATION）；从备份回滚有记录。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { defaultMigrations, openStore } from '../../packages/persistence/dist/index.js';
import { backupStore } from '../../packages/persistence/dist/backup.js';
import { upgradePreflight, rollbackFromBackup, pendingActionsAfterRestore } from '../../apps/kernel/dist/upgrade/index.js';
import { createProject } from '../../packages/domain/dist/projects/index.js';
import { createTask, markTaskReady } from '../../packages/domain/dist/tasks/index.js';
import { sendMessage } from '../../packages/domain/dist/messages/index.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';

test('A068 备份与恢复：WAL活跃一致快照→隔离恢复→待发动作恢复先核对', t => {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-a068-', () => { for (const s of stores) if (!s.closed) s.close(); });
  const mainPath = path.join(dir, 'state.sqlite');
  const seed = store => {
    createProject(store, { id: 'p1', name: '备份项目', hostId: 'h', canonicalRoot: dir, objective: 'A068' }, 100);
    store.transaction(db => {
      db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s1','zcode','h','pp','conv-1')").run();
      db.prepare("INSERT INTO roles(id,project_id,name,charter,permission_profile,desired_state,binding_state,revision) VALUES('worker','p1','执行者','按指令','team','enabled','ready',1)").run();
      db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b1','p1','worker','s1',1,100)").run();
    });
    createTask(store, { id: 't1', projectId: 'p1', roleId: 'worker', goal: 'A068核对任务', acceptance: [{ ruleId: 'user-review', description: '人工核验', mode: 'user' }], outputRequirements: [{ name: 'report', kind: 'report', description: '核对报告' }] }, 110);
    markTaskReady(store, 'p1', 't1', 120);
    store.transaction(db => db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('c1','p1','user-1','r1',?,'message.send',?,'completed',130)").run('h1', JSON.stringify({ toRoleId: 'worker', body: '恢复后先核对外部执行', kind: 'task_input' })));
    sendMessage(store, { id: 'm1', projectId: 'p1', commandId: 'c1', toRoleId: 'worker', kind: 'task_input', body: '恢复后先核对外部执行' }, 130);
  };
  const storeA = openStore(mainPath); stores.push(storeA);
  seed(storeA);
  const backupPath = path.join(dir, 'isolated', 'backup.sqlite');
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  const backup = backupStore(storeA, backupPath, 1000);
  assert.equal(backup.userVersion, defaultMigrations().length);
  createProject(storeA, { id: 'p2', name: '备份后项目', hostId: 'h', canonicalRoot: dir + '-later', objective: '应随恢复消失' }, 200);
  storeA.close();
  const record = rollbackFromBackup(backupPath, mainPath, 2000);
  assert.equal(record.restoredVersion, defaultMigrations().length);
  assert.ok(fs.existsSync(mainPath + '.rollback-history.jsonl'), '恢复有记录');
  const lines = fs.readFileSync(mainPath + '.rollback-history.jsonl', 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).backupPath, backupPath);
  const storeB = openStore(mainPath); stores.push(storeB);
  assert.equal(storeB.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE id='p1'").get().n, 1);
  assert.equal(storeB.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE id='p2'").get().n, 0, '备份点后写入随恢复消失');
  assert.equal(storeB.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id='t1'").get().n, 1);
  assert.equal(storeB.db.prepare("SELECT COUNT(*) AS n FROM role_bindings WHERE id='b1'").get().n, 1);
  const pending = pendingActionsAfterRestore(storeB);
  assert.ok(pending.heldMessages.some(m => m.id === 'm1'), '未结消息进入核对清单');
  assert.equal(storeB.db.prepare("SELECT state FROM messages WHERE id='m1'").get().state, 'stored', '恢复不改变消息状态，不自动重放');
});

test('A069 迁移失败原子回滚：注入坏迁移→旧库保持可用', t => {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-a069a-', () => { for (const s of stores) if (!s.closed) s.close(); });
  const mainPath = path.join(dir, 'state.sqlite');
  const storeA = openStore(mainPath); stores.push(storeA);
  createProject(storeA, { id: 'p1', name: '旧版数据', hostId: 'h', canonicalRoot: dir, objective: 'A069' }, 100);
  storeA.close();
  const broken = [...defaultMigrations(), { version: defaultMigrations().length + 1, name: 'broken_candidate', sql: 'CREATE TABLE definitely_missing AS SELECT * FROM no_such_table;' }];
  assert.throws(() => openStore(mainPath, { migrations: broken }), /no_such_table|SQLITE_ERROR/, '迁移注入失败抛出');
  const storeB = openStore(mainPath); stores.push(storeB);
  assert.equal(storeB.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE id='p1'").get().n, 1, '迁移失败不丢已提交业务状态');
  assert.equal(Number(storeB.db.prepare("PRAGMA user_version").get().user_version), defaultMigrations().length, '版本停在失败前');
});

test('A069 旧程序拒新库：DATABASE_NEWER_THAN_APPLICATION', t => {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-a069b-', () => { for (const s of stores) if (!s.closed) s.close(); });
  const mainPath = path.join(dir, 'state.sqlite');
  const storeA = openStore(mainPath); stores.push(storeA);
  createProject(storeA, { id: 'p1', name: '新版库', hostId: 'h', canonicalRoot: dir, objective: 'A069' }, 100);
  storeA.close();
  const newer = [...defaultMigrations(), { version: defaultMigrations().length + 1, name: 'future_column', sql: 'ALTER TABLE projects ADD COLUMN future_marker INTEGER NOT NULL DEFAULT 0;' }];
  const storeNew = openStore(mainPath, { migrations: newer }); stores.push(storeNew);
  storeNew.close();
  assert.throws(() => openStore(mainPath), /DATABASE_NEWER_THAN_APPLICATION/, '旧程序拒不兼容库');
});

test('A069 preflight：版本报告与不兼容阻塞', t => {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-a069c-', () => { for (const s of stores) if (!s.closed) s.close(); });
  const mainPath = path.join(dir, 'state.sqlite');
  const fresh = upgradePreflight(path.join(dir, 'missing.sqlite'));
  assert.equal(fresh.databaseExists, false);
  assert.equal(fresh.ready, true);
  const storeA = openStore(mainPath); stores.push(storeA);
  storeA.close();
  const report = upgradePreflight(mainPath);
  assert.equal(report.databaseExists, true);
  assert.equal(report.currentVersion, defaultMigrations().length);
  assert.equal(report.pendingMigrations.length, 0);
  assert.equal(report.ready, true);
});

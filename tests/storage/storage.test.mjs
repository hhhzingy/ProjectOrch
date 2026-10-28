import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { assertSafeSqliteVersion, defaultMigrations, localDatabasePath, openStore } from '../../packages/persistence/dist/index.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projectorch-storage-'));
  const filename = path.join(dir, 'state.sqlite');
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    const resolved = fs.realpathSync(dir);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('projectorch-storage-'));
    fs.rmSync(resolved, { recursive: true });
  });
  return { dir, filename, open(options) { const s = openStore(filename, options); stores.push(s); return s; } };
}

function seed(store) {
  store.transaction(db => {
    const project = db.prepare('INSERT INTO projects(id,name,host_id,canonical_root,objective,created_at) VALUES(?,?,?,?,?,0)');
    project.run('p1', 'test-one', 'test-host', 'synthetic/one', 'test');
    project.run('p2', 'test-two', 'test-host', 'synthetic/two', 'test');
    const role = db.prepare("INSERT INTO roles(id,project_id,name,charter,permission_profile,desired_state,binding_state) VALUES(?,?,?,'test','scoped','enabled','ready')");
    role.run('r1', 'p1', 'test'); role.run('r2', 'p2', 'test');
    db.exec("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s1','synthetic','test-host','test-profile','test-session')");
    db.exec("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b1','p1','r1','s1',1,0)");
    db.exec("INSERT INTO tasks(id,project_id,role_id,goal,state,plan_revision,acceptance_json) VALUES('t1','p1','r1','test','ready',0,'[]')");
    db.exec("INSERT INTO task_revisions(task_id,project_id,revision,snapshot_json) VALUES('t1','p1',0,'{}')");
    db.exec("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('c1','p1','test-principal','req1','hash','test','{}','stored',0)");
  });
}

test('A016 实际嵌入版本和磁盘 WAL/FULL/外键配置满足修复基线，重开保留迁移账本', t => {
  const f = fixture(t); const s = f.open();
  assert.doesNotThrow(() => assertSafeSqliteVersion(s.sqliteVersion));
  t.diagnostic(`Node=${process.version}; SQLite=${s.sqliteVersion}; platform=${process.platform}-${process.arch}`);
  assert.equal(s.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(s.db.prepare('PRAGMA synchronous').get().synchronous, 2);
  assert.equal(s.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(s.db.prepare('PRAGMA user_version').get().user_version, defaultMigrations().length);
  seed(s); s.close();
  const reopened = f.open();
  assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, defaultMigrations().length);
  assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 2);
  assert.equal(reopened.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('不安全 SQLite、相对路径及网络路径拒绝', () => {
  for (const v of ['3.51.2', '3.50.7', '3.44.6', '4.0.0', 'bad']) assert.throws(() => assertSafeSqliteVersion(v), /SQLITE_VERSION_UNSAFE/);
  for (const v of ['3.51.3', '3.53.4']) assert.doesNotThrow(() => assertSafeSqliteVersion(v));
  for (const p of ['state.sqlite', '\\\\server\\share\\state.sqlite', '//server/share/state.sqlite']) assert.throws(() => localDatabasePath(p), /LOCAL_DISK_REQUIRED/);
});

test('A016 跨项目父角色、任务、双活跃绑定和 unknown 尝试拒绝', t => {
  const s = fixture(t).open(); seed(s);
  assert.throws(() => s.db.exec("UPDATE roles SET parent_id='r2' WHERE id='r1'"), /FOREIGN KEY/);
  assert.throws(() => s.db.exec("UPDATE tasks SET role_id='r2' WHERE id='t1'"), /FOREIGN KEY/);
  assert.throws(() => s.db.exec("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b2','p1','r1','s1',2,0)"), /UNIQUE/);
  const attempt = s.db.prepare("INSERT INTO attempts(id,project_id,task_id,task_revision,binding_id,binding_epoch,state,started_at) VALUES(?,'p1','t1',0,'b1',?,'unknown',0)");
  assert.throws(() => attempt.run('wrong', 2), /FOREIGN KEY/);
  attempt.run('a1', 1);
  assert.throws(() => attempt.run('a2', 1), /UNIQUE/);
  assert.equal(s.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('项目创建前幂等、一次性配对字段及唯一 bootstrap 持久化', t => {
  const s = fixture(t).open();
  s.db.exec("INSERT INTO pairing_challenges(id,code_hash,expires_at) VALUES('challenge','synthetic-digest',1)");
  assert.throws(() => s.db.exec("INSERT INTO pairing_challenges(id,code_hash,expires_at) VALUES('duplicate','synthetic-digest',1)"), /UNIQUE/);
  s.db.exec("INSERT INTO global_requests(principal_id,request_id,request_hash,state,receipt_json) VALUES('user','create','digest','stored','{}')");
  assert.equal(s.db.prepare('SELECT project_id FROM global_requests').get().project_id, null);
  seed(s);
  s.db.exec("INSERT INTO project_bootstrap(project_id,role_id,principal_id,request_id,state) VALUES('p1','r1','user','create','provisioning')");
  assert.throws(() => s.db.exec("INSERT INTO project_bootstrap(project_id,role_id,principal_id,request_id,state) VALUES('p1','r1','user','create','ready')"), /UNIQUE/);
  assert.throws(() => s.db.exec("INSERT INTO global_requests(principal_id,request_id,request_hash,state,receipt_json) VALUES('user','create','different','stored','{}')"), /UNIQUE/);
});

test('来源审计拒绝跨项目事件、缺少认证主体和错误命令关联', t => {
  const s = fixture(t).open(); seed(s);
  assert.throws(() => s.db.exec("INSERT INTO source_observations(id,project_id,source_kind,payload_json,observed_at) VALUES('bad','p1','authenticated_user','{}',0)"), /CHECK/);
  assert.throws(() => s.db.exec("INSERT INTO source_observations(id,project_id,source_kind,command_id,payload_json,observed_at) VALUES('bad','p2','role_forwarded','c1','{}',0)"), /FOREIGN KEY/);
  s.db.exec("INSERT INTO source_observations(id,project_id,source_kind,payload_json,observed_at) VALUES('native','p1','native_unverified','{}',0)");
  assert.throws(() => s.db.exec("UPDATE source_observations SET project_id='p2' WHERE id='native'"), /IMMUTABLE_SOURCE_OBSERVATION/);
  assert.throws(() => s.db.exec("DELETE FROM source_observations WHERE id='native'"), /IMMUTABLE_SOURCE_OBSERVATION/);
  assert.throws(() => s.db.exec("INSERT INTO events(id,project_id,type,entity_id,entity_revision,body_json,occurred_at,source_observation_id) VALUES('bad','p2','test','p2',0,'{}',0,'native')"), /CROSS_PROJECT_SOURCE/);
});

test('同步事务回滚、嵌套拒绝和连接生命周期', t => {
  const s = fixture(t).open(); seed(s);
  assert.throws(() => s.transaction(db => { db.exec("UPDATE projects SET revision=2 WHERE id='p1'"); throw new Error('injected'); }), /injected/);
  assert.equal(s.db.prepare("SELECT revision FROM projects WHERE id='p1'").get().revision, 0);
  s.transaction(() => {
    assert.throws(() => s.transaction(() => 0), /NESTED_TRANSACTION_FORBIDDEN/);
    assert.throws(() => s.close(), /CLOSE_DURING_TRANSACTION/);
  });
  s.close(); s.close();
  assert.throws(() => s.transaction(() => 0), /STORE_CLOSED/);
});

test('异步事务在执行前拒绝；意外 Promise 使连接关闭，防止迟到写入', async t => {
  const f = fixture(t); const s = f.open(); let entered = false;
  assert.throws(() => s.transaction(async () => { entered = true; }), /ASYNC_TRANSACTION_FORBIDDEN/);
  assert.equal(entered, false);
  assert.throws(() => s.transaction(() => Promise.resolve().then(() => s.db.exec('CREATE TABLE late(value)'))), /ASYNC_TRANSACTION_FORBIDDEN/);
  await new Promise(resolve => setImmediate(resolve));
  const next = f.open();
  assert.equal(next.db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='late'").get().n, 0);
});

test('迁移升级前一致性备份保留旧数据；失败迁移整体回滚', t => {
  const f = fixture(t); const migrations = defaultMigrations();
  const old = f.open({ migrations: migrations.slice(0, 1) }); seed(old); old.close();
  const current = f.open();
  assert.ok(current.migrationBackup);
  const backup = new DatabaseSync(current.migrationBackup, { readOnly: true });
  try {
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 2);
    assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { backup.close(); }
  current.close();
  assert.throws(() => f.open({ migrations: [...migrations, { version: migrations.length + 1, name: 'failure', sql: 'CREATE TABLE not_committed(value); INVALID SQL;' }] }), /syntax error/);
  const stable = f.open();
  assert.equal(stable.db.prepare('PRAGMA user_version').get().user_version, defaultMigrations().length);
  assert.equal(stable.db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='not_committed'").get().n, 0);
  assert.equal(stable.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 2);
});

test('被改写的迁移、未来数据库和未归属用户数据库拒绝，保留数据', t => {
  const f = fixture(t); const s = f.open(); seed(s); s.close();
  const migrations = defaultMigrations();
  assert.throws(() => f.open({ migrations: migrations.map((m, i) => i ? m : { ...m, sql: `${m.sql}\n-- changed` }) }), /MIGRATION_CHECKSUM_MISMATCH/);
  let db = new DatabaseSync(f.filename); db.exec('PRAGMA user_version=999'); db.close();
  assert.throws(() => f.open(), /DATABASE_NEWER_THAN_APPLICATION/);
  db = new DatabaseSync(f.filename); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 2); db.close();
  const other = path.join(f.dir, 'user.sqlite');
  db = new DatabaseSync(other); db.exec("CREATE TABLE user_asset(value); INSERT INTO user_asset VALUES('keep')"); db.close();
  assert.throws(() => openStore(other), /UNRECOGNIZED_DATABASE/);
  db = new DatabaseSync(other); assert.equal(db.prepare('SELECT value FROM user_asset').get().value, 'keep'); db.close();
});

test('双连接竞争只有一个写入者；忙锁失败不改变已提交状态', t => {
  const f = fixture(t); const a = f.open(); seed(a); const b = f.open({ busyTimeoutMs: 25 });
  a.transaction(db => {
    db.exec("UPDATE projects SET revision=1 WHERE id='p1'");
    assert.throws(() => b.transaction(second => second.exec("UPDATE projects SET revision=9 WHERE id='p1'")), /locked/);
    assert.equal(b.db.prepare("SELECT revision FROM projects WHERE id='p1'").get().revision, 0);
  });
  assert.equal(b.db.prepare("SELECT revision FROM projects WHERE id='p1'").get().revision, 1);
});

test('事务guard在写锁内执行、不可替换，拒绝后业务回调不运行且原数据保留', t => {
  const f = fixture(t); const s = f.open(); seed(s); let allow = true, called = 0;
  s.installTransactionGuard(db => { assert.equal(db.isTransaction, true); if (!allow) throw new Error('OWNER_LOST'); });
  assert.throws(() => s.installTransactionGuard(() => {}), /INVALID_TRANSACTION_GUARD/);
  s.transaction(db => db.exec("UPDATE projects SET revision=1 WHERE id='p1'"));
  allow = false;
  assert.throws(() => s.transaction(db => { called++; db.exec("UPDATE projects SET revision=2 WHERE id='p1'"); }), /OWNER_LOST/);
  assert.equal(called, 0); assert.equal(s.db.isTransaction, false);
  assert.equal(s.db.prepare("SELECT revision FROM projects WHERE id='p1'").get().revision, 1);
});

test('异步事务guard拒绝，误返Promise则关闭连接且未执行业务写入', t => {
  const f = fixture(t); const s = f.open(); seed(s);
  assert.throws(() => s.installTransactionGuard(async () => {}), /INVALID_TRANSACTION_GUARD/);
  s.installTransactionGuard(() => Promise.reject(new Error('misconfigured guard')));
  let called = 0;
  assert.throws(() => s.transaction(() => { called++; }), /ASYNC_TRANSACTION_GUARD_FORBIDDEN/);
  assert.equal(called, 0); assert.throws(() => s.transaction(() => {}), /STORE_CLOSED/);
  const next = f.open(); assert.equal(next.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 2);
});

test('只有 VIEW、非保留 sqlite 前缀表或外部 application_id 的用户库也必须停止且原样保留', t => {
  const f = fixture(t);
  const cases = [
    ['view-only', 'CREATE VIEW user_view AS SELECT 42 AS value', 'SELECT value FROM user_view', 42],
    ['prefix-table', "CREATE TABLE sqliteAsset(value); INSERT INTO sqliteAsset VALUES('keep')", 'SELECT value FROM sqliteAsset', 'keep'],
    ['foreign-marker', 'PRAGMA application_id=12345', 'PRAGMA application_id', 12345],
  ];
  for (const [name, sql, query, expected] of cases) {
    const filename = path.join(f.dir, `${name}.sqlite`);
    let db = new DatabaseSync(filename); db.exec(sql); db.close();
    const before = fs.readFileSync(filename);
    assert.throws(() => openStore(filename), /UNRECOGNIZED_DATABASE/);
    assert.deepEqual(fs.readFileSync(filename), before, '拒绝时不修改用户数据库字节');
    db = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.equal(Object.values(db.prepare(query).get())[0], expected);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='schema_migrations'").get().n, 0);
    } finally { db.close(); }
    assert.equal(fs.existsSync(`${filename}.backups`), false);
  }
});

for (const boundary of ['before', 'after']) {
  test(`A017 独立进程在提交${boundary === 'before' ? '前' : '后'}强制终止，状态/事件/Outbox 全无或全有`, t => {
    const f = fixture(t); const s = f.open(); seed(s); s.close();
    const worker = spawnSync(process.execPath, [fileURLToPath(new URL('./crash-worker.mjs', import.meta.url)), f.filename, boundary], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    assert.equal(worker.error, undefined);
    assert.equal(worker.stdout.trim(), `CRASH_POINT:${boundary}`);
    assert.ok(worker.signal || worker.status !== 0, '子进程必须实际异常终止');
    t.diagnostic(`crash-boundary=${boundary}; exit=${worker.status}; signal=${worker.signal}; marker=${worker.stdout.trim()}`);
    assert.doesNotMatch(worker.stderr, /Error:|SyntaxError/);
    const recovered = f.open(); const expected = boundary === 'after' ? 1 : 0;
    assert.equal(recovered.db.prepare("SELECT revision FROM projects WHERE id='p1'").get().revision, expected);
    assert.equal(recovered.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, expected);
    assert.equal(recovered.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, expected);
    assert.equal(recovered.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  });
}

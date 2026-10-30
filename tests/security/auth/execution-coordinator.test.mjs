import test from 'node:test';
import { executionFixture as fixture } from './execution-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore, defaultMigrations } from '../../../packages/persistence/dist/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { ExecutionCoordinator, NativeDispatchNotSent } from '../../../apps/kernel/dist/execution/coordinator.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

// 只测试协调器，不启动官方软件、模型或真实工具宿主。能力证明及会话均是明确合成的组件输入。

const tick = () => new Promise(resolve => setImmediate(resolve));

test('failed执行终态持久保存安全诊断，通用故障不伪造额度分类',async t=>{
 for(const code of ['CODEX_USAGE_LIMIT_EXCEEDED','PRIVATE_SECRET']){
  const f=fixture(t),id=f.prepare(),pending=f.coordinator.run(id);await tick();
  f.finish({status:'failed',terminalConfirmed:true,diagnostics:{code,message:'PRIVATE_SECRET',stack:'PRIVATE_SECRET'}});
  assert.equal(await pending,'failed');assert.equal(f.reservation().state,'released');
  const row=f.store.db.prepare("SELECT body_json FROM events WHERE type='execution.finished'").get();
  assert.deepEqual(JSON.parse(row.body_json).diagnostics,{code:code==='CODEX_USAGE_LIMIT_EXCEEDED'?code:'NATIVE_EXECUTION_UNCERTAIN'});
  assert.doesNotMatch(row.body_json,/PRIVATE_SECRET/);assert.equal(f.store.db.prepare('SELECT state FROM attempts').get().state,'failed');
  f.coordinator.close();
 }
});

test('期限unknown保存白名单故障计量，不保存任意正文且不释放/重发',async t=>{
 const f=fixture(t),id=f.prepare(),run=f.coordinator.run(id);await tick();
 f.finish({status:'unknown',terminalConfirmed:false,diagnostics:{code:'CLI_TIMEOUT',elapsedMs:900000,frames:12,stdoutBytes:1024,lastType:'tool',stderr:'PRIVATE_SECRET',message:'PRIVATE_SECRET'}});
 assert.equal(await run,'unknown');assert.equal(f.reservation().state,'unknown');
 const row=f.store.db.prepare("SELECT body_json FROM events WHERE type='execution.unknown'").get(),body=JSON.parse(row.body_json);
 assert.deepEqual(body.diagnostics,{code:'CLI_TIMEOUT',elapsedMs:900000,frames:12,stdoutBytes:1024,lastType:'tool'});assert.equal(row.body_json.includes('PRIVATE_SECRET'),false);
 assert.throws(()=>f.prepare('no retry'),/UNKNOWN_EXECUTION|CONFLICT|CONCURRENCY_EXCEEDED/);assert.equal(f.calls,1);f.coordinator.close();
});

test('执行预约幂等、同实例并发run仅发送一次，精确原生终态才释放；不自动业务验收', async t => {
  const f = fixture(t); const id = f.prepare();
  assert.equal(f.prepare(), id);
  assert.deepEqual(JSON.parse(f.row(id).input_json).artifactContext,{pathRefBase:'projectRoot',workspaceRelativeToProjectRoot:'workspace'});
  assert.throws(() => f.prepare('request', 'next'), /IDEMPOTENCY_CONFLICT/);
  assert.throws(() => f.prepare('other'), /UNKNOWN_EXECUTION|CONFLICT|CONCURRENCY_EXCEEDED/);
  const one = f.coordinator.run(id), two = f.coordinator.run(id); await tick();
  assert.equal(f.calls, 1); assert.equal(f.row(id).phase, 'running');
  assert.throws(() => f.coordinator.close(), /IN_FLIGHT/);
  f.finish(); assert.deepEqual(await Promise.all([one, two]), ['succeeded', 'succeeded']);
  assert.equal(f.reservation().state, 'released');
  assert.equal(f.store.db.prepare('SELECT state FROM attempts WHERE id=?').get(id).state, 'succeeded');
  assert.equal(f.store.db.prepare("SELECT state FROM tasks WHERE id='task'").get().state, 'draft');
  assert.equal(await f.coordinator.run(id), 'succeeded'); assert.equal(f.calls, 1);
  f.coordinator.close();
});

test('预约后暂停/策略/规格/握手/当前程序快照/门槛变化在外发前拒绝', async t => {
  for (const scenario of ['paused', 'policy', 'spec', 'ack', 'capability', 'identity', 'gate', 'driver', 'session', 'root']) {
    const f = fixture(t); const id = f.prepare();
    if (scenario === 'paused') f.store.db.exec("UPDATE projects SET user_paused=1 WHERE id='p'");
    if (scenario === 'policy') f.store.db.exec("UPDATE projects SET policy_json=json_set(policy_json,'$.limits.wallTimeMs',12345) WHERE id='p'");
    if (scenario === 'spec') f.store.db.exec("UPDATE tasks SET revision=revision+1,goal='changed' WHERE id='task'");
    if (scenario === 'ack') f.store.db.exec("DELETE FROM role_startup_acks");
    if (scenario === 'capability') f.prove({ textInput: 'verified', resume: 'verified', historyRead: 'verified', roleTools: 'unsupported' });
    if (scenario === 'identity') f.changeIdentity();
    if (scenario === 'gate') f.setGate(false);
    if (scenario === 'driver') f.driver.ownerKey = 'new-owner';
    if (scenario === 'session') f.driver.session = { ...f.session, nativeConversationId: 'other' };
    if (scenario === 'root') f.driver.workspaceRoot = f.dir;
    assert.equal(await f.coordinator.run(id), 'cancelled', scenario);
    assert.equal(f.calls, 0, scenario); assert.equal(f.reservation().state, 'released', scenario);
  }
});

test('失去/释放/unknown/变更栅栏或终止尝试的预约一律不能外发，不能释放别的占位', async t => {
  for (const scenario of ['missing', 'released', 'unknown', 'fence', 'attempt']) {
    const f = fixture(t); const id = f.prepare();
    if (scenario === 'missing') f.store.db.exec('DELETE FROM workspace_reservations');
    if (['released', 'unknown'].includes(scenario)) f.store.db.prepare('UPDATE workspace_reservations SET state=?').run(scenario);
    if (scenario === 'fence') f.store.db.exec('UPDATE workspace_reservations SET fence=fence+1');
    if (scenario === 'attempt') f.store.db.exec("UPDATE attempts SET state='succeeded',ended_at=250");
    assert.equal(await f.coordinator.run(id), 'unknown', scenario); assert.equal(f.calls, 0, scenario);
    if (scenario === 'released') assert.equal(f.reservation().state, 'released');
    if (scenario === 'fence') { assert.equal(f.reservation().fence, 2); assert.equal(f.reservation().state, 'reserved'); }
    if (scenario === 'attempt') assert.equal(f.store.db.prepare('SELECT state FROM attempts').get().state, 'succeeded');
  }
});

test('发送后抛错保留unknown且不重发；明确未发送与无观察故障才能安全释放', async t => {
  for (const kind of ['unknown', 'not_sent', 'invalid_handle']) {
    const f = fixture(t); const id = f.prepare();
    f.setStart(() => { if (kind === 'invalid_handle') return {}; throw kind === 'not_sent' ? new NativeDispatchNotSent('confirmed not sent') : new Error('after possible side effect'); });
    const expected = kind === 'not_sent' ? 'cancelled' : 'unknown';
    assert.equal(await f.coordinator.run(id), expected);
    assert.equal(await f.coordinator.run(id), expected); assert.equal(f.calls, 1);
    assert.equal(f.reservation().state, kind === 'not_sent' ? 'released' : 'unknown');
  }
});

test('同步非法回调锁定unknown，随后有效回调/成功结果也不能洗成成功', async t => {
  for (const notSent of [false, true]) {
    const f = fixture(t); const id = f.prepare();
    f.setStart((_input, started) => {
      started(f.session, 'bad-sync-turn');
      queueMicrotask(() => started(f.session, 'native-turn'));
      if (notSent) throw new NativeDispatchNotSent('cannot override observed protocol fault');
      return { result: Promise.resolve({ session: f.session, executionId: 'native-turn', status: 'completed', terminalConfirmed: true }) };
    });
    assert.equal(await f.coordinator.run(id), 'unknown'); assert.equal(f.row(id).native_execution_id, null);
    assert.equal(f.reservation().state, 'unknown');
  }
});

test('重复/错会话的开始观察立即收敛unknown，无需等一个永远不返回的模型', async t => {
  for (const wrong of [false, true]) {
    const f = fixture(t); const id = f.prepare(); const run = f.coordinator.run(id); await tick();
    f.observe(wrong ? { ...f.session, nativeConversationId: 'other' } : f.session, 'second-turn');
    assert.equal(await run, 'unknown');
    f.finish(); await tick();
    assert.equal(f.row(id).phase, 'unknown'); assert.equal(f.reservation().state, 'unknown');
  }
});

test('错会话/错执行ID/无开始/未确认/未知/拒绝的终态不能解锁', async t => {
  for (const scenario of ['session', 'id', 'no_start', 'unconfirmed', 'unknown', 'reject']) {
    const f = fixture(t); const id = f.prepare();
    if (scenario === 'no_start') f.setStart(() => ({ result: Promise.resolve({ session: f.session, executionId: 'native-turn', status: 'completed', terminalConfirmed: true }) }));
    const run = f.coordinator.run(id); await tick();
    if (scenario === 'reject') f.rejectResult(new Error('native disconnected'));
    else f.finish(scenario === 'session' ? { session: { ...f.session, nativeConversationId: 'other' } } : scenario === 'id' ? { executionId: 'other' } : scenario === 'unconfirmed' ? { terminalConfirmed: false } : scenario === 'unknown' ? { status: 'unknown' } : {});
    assert.equal(await run, 'unknown', scenario); assert.equal(f.reservation().state, 'unknown', scenario);
  }
});

test('终态时栅栏改变仍不能释放新预约或改写成功', async t => {
  const f = fixture(t); const id = f.prepare(); const run = f.coordinator.run(id); await tick();
  f.store.db.exec('UPDATE workspace_reservations SET fence=fence+1'); f.finish();
  assert.equal(await run, 'unknown'); assert.equal(f.reservation().state, 'reserved'); assert.equal(f.reservation().fence, 2);
});

test('新owner恢复发送边界为unknown，迟到旧终态明确owner_lost，不覆盖新fence或重发', async t => {
  const f = fixture(t); const id = f.prepare(); const run = f.coordinator.run(id); await tick();
  const next = new ExecutionCoordinator(f.store, f.services);
  assert.equal(next.recover(), 1); assert.equal(next.recover(), 0); assert.equal(f.row(id).fence, 2);
  f.finish(); assert.equal(await run, 'owner_lost');
  assert.equal(f.row(id).phase, 'unknown'); assert.equal(f.reservation().state, 'unknown');
  assert.equal(await next.run(id), 'unknown'); assert.equal(f.calls, 1);
});

test('内核所有权丢失期间不写终态，重新取得锁的新协调器负责unknown恢复', async t => {
  const f = fixture(t); const id = f.prepare(); const run = f.coordinator.run(id); await tick();
  f.setOwner(false); f.finish(); assert.equal(await run, 'owner_lost');
  assert.equal(f.row(id).phase, 'running'); assert.equal(f.reservation().state, 'reserved');
  f.setOwner(true); const next = new ExecutionCoordinator(f.store, f.services); assert.equal(next.recover(), 1);
  assert.equal(f.row(id).phase, 'unknown');
});

test('依赖、并发次数、凭据撤销、工作目录范围和能力缺失在预约前拒绝，无遗留尝试', t => {
  for (const scenario of ['dependency', 'attempts', 'credential', 'scope', 'capability']) {
    const f = fixture(t);
    if (scenario === 'dependency') f.store.db.exec("INSERT INTO task_dependencies(task_id,project_id,prerequisite_id,required_revision,condition) VALUES('task','p','next',1,'accepted')");
    if (scenario === 'attempts') f.store.db.exec("UPDATE projects SET policy_json=json_set(policy_json,'$.limits.maxAttempts',1) WHERE id='p'; INSERT INTO attempts(id,project_id,task_id,task_revision,binding_id,binding_epoch,state,started_at,ended_at) VALUES('past','p','task',1,'binding',1,'failed',150,200)");
    if (scenario === 'credential') f.store.db.exec('UPDATE agent_credentials SET revoked_at=250');
    if (scenario === 'scope') f.store.db.exec("UPDATE workspaces SET write_paths_json='[\"outside/*\"]'");
    if (scenario === 'capability') f.prove({ textInput: 'verified' });
    assert.throws(() => f.prepare(), scenario === 'attempts' ? /DISPATCH_ATTEMPTS_EXCEEDED/ : undefined, scenario);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, scenario === 'attempts' ? 1 : 0); assert.equal(f.calls, 0);
  }
});

test('010旧库升级保留原项目，并为新执行账本建立约束', t => {
  const stores = []; const dir = temporaryDirectory(t, 'projectorch-execution-migrate-', () => { for (const store of stores) if (!store.closed) store.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const old = openStore(filename, { migrations: defaultMigrations().slice(0, 10) }); stores.push(old);
  createProject(old, { id: 'preserved', name: 'old', hostId: 'host', canonicalRoot: dir, objective: '保留用户数据' }, 100); old.close();
  const next = openStore(filename); stores.push(next);
  assert.equal(next.db.prepare("SELECT objective FROM projects WHERE id='preserved'").get().objective, '保留用户数据');
  assert.equal(next.db.prepare('PRAGMA user_version').get().user_version, defaultMigrations().length);
  assert.equal(next.db.prepare('SELECT COUNT(*) AS n FROM execution_dispatches').get().n, 0);
  assert.equal(next.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('实际子进程外发副作用后被强制终止，回滚启动事务仍留下sending边界，恢复不重发', async t => {
  const f = fixture(t); f.store.close();
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./execution-crash-worker.mjs', import.meta.url)), f.filename], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(child.error, undefined); assert.equal(child.stdout.trim(), 'CRASH_POINT:after-side-effect');
  assert.ok(child.signal || child.status !== 0); assert.doesNotMatch(child.stderr, /Error:|SyntaxError/);
  const store = openStore(f.filename); f.stores.push(store);
  const row = store.db.prepare("SELECT * FROM execution_dispatches WHERE request_key='crash'").get();
  assert.equal(row.phase, 'sending');
  assert.equal(fs.readFileSync(path.join(f.dir, 'workspace', 'synthetic-side-effect.txt'), 'utf8'), 'one external effect');
  const next = new ExecutionCoordinator(store, f.services); assert.equal(next.recover(), 1);
  assert.equal(await next.run(row.id), 'unknown'); assert.equal(f.calls, 0);
  assert.equal(store.db.prepare('SELECT state FROM workspace_reservations').get().state, 'unknown');
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  t.diagnostic(`real-process-crash; exit=${child.status}; signal=${child.signal}; marker=${child.stdout.trim()}`);
});

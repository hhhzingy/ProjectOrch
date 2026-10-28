import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { openStore, defaultMigrations } from '../../../packages/persistence/dist/index.js';
import { reserveMessageCommand, commitCommandReceipt } from '../../../packages/persistence/dist/commands/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { createRole } from '../../../packages/domain/dist/roles/index.js';
import { createTask } from '../../../packages/domain/dist/tasks/index.js';
import { sendMessage, sendMessageWithin, markDelivered } from '../../../packages/domain/dist/messages/index.js';
import { issueAgentCredential, authenticateAgentCredential, revokeBindingCredentials } from '../../../apps/kernel/dist/auth/agent-credential.js';
import { createToolDispatcher } from '../../../apps/kernel/dist/tools/gateway-tools.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';
import { installSyntheticPolicy } from './synthetic-policy.mjs';

const profileInput = { id: 'worker', revision: 1, actions: ['identity', 'project.read', 'role.read', 'message.read_own', 'message.send', 'message.ack_own', 'artifact.register_own', 'artifact.read'], readPaths: ['tasks/*', 'roles/*', 'messages/*', 'results/*'], writePaths: ['tasks/*', 'messages/*', 'results/*'], roleIds: [], delegableActions: [], maxDelegationDepth: 0 };

function fixture(t, initialMigrations) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-gateway-tools-', () => { for (const s of stores) s.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const open = (migrations) => { const s = openStore(filename, migrations ? { migrations } : {}); stores.push(s); return s; };
  const store = open(initialMigrations);
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: dir, objective: '目标X' }, 100);
  createRole(store, { id: 'r-worker', projectId: 'p1', name: 'worker', charter: 'c', permissionProfileId: 'worker' }, 101);
  createRole(store, { id: 'r-peer', projectId: 'p1', name: 'peer', charter: 'c', permissionProfileId: 'worker' }, 102);
  createTask(store, { id: 't-1', projectId: 'p1', roleId: 'r-worker', goal: 'g' }, 103);
  store.db.exec("UPDATE tasks SET spec_revision=1 WHERE id='t-1'");
  store.transaction(db => db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s1','synthetic','host','profile','native-1')").run());
  store.transaction(db => db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b1','p1','r-worker','s1',1,100)").run());
  store.db.exec("UPDATE roles SET binding_state='ready' WHERE id='r-worker'");
  installSyntheticPolicy(store, 'p1', [profileInput]);
  const credential = issueAgentCredential(store, 'b1', 1, { isolation: 'verified_session', session: { harnessId: 'synthetic', hostId: 'host', profileId: 'profile', nativeConversationId: 'native-1' } }, 110, 60000).credential;
  const principal = authenticateAgentCredential(store, credential, 200);
  const dispatcher = createToolDispatcher(store, { profileInput, now: () => 300, callerNativeConversationId: 'native-1' });
  return { store, open, principal, dispatcher, filename, dir };
}
function assertRoleCommandSource(store, command, principal) {
  const source = store.db.prepare('SELECT source_principal_id FROM agent_role_sources WHERE project_id=? AND role_id=?').get(principal.projectId, principal.roleId);
  assert.equal(command.source_principal_id, source.source_principal_id);
  const scope = store.db.prepare('SELECT project_id,role_id,credential_id FROM agent_command_scopes WHERE command_id=?').get(command.id);
  assert.deepEqual({ ...scope }, { project_id: principal.projectId, role_id: principal.roleId, credential_id: principal.credentialId });
}
const call = (dispatcher, principal, tool, args = {}) => dispatcher(principal, tool, args);

function gitFixture(t, rootRepository = false) {
  const f = fixture(t), repo = path.join(f.dir, 'repo'); fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Synthetic'); git('config', 'user.email', 'synthetic@projectorch.invalid');
  fs.writeFileSync(path.join(repo, 'report.txt'), 'synthetic committed report'); git('add', '.'); git('commit', '-m', 'synthetic report');
  f.store.db.prepare("UPDATE projects SET canonical_root=? WHERE id='p1'").run(rootRepository ? repo : f.dir);
  const profile = { ...profileInput, actions: [...profileInput.actions, 'task.read'], readPaths: ['tasks/*', 'repo', 'repositories/root'], writePaths: ['repo'] };
  installSyntheticPolicy(f.store, 'p1', [profile]);
  const dispatcher = createToolDispatcher(f.store, { now: () => 300, callerNativeConversationId: 'native-1' });
  const input = { requestId: 'git-artifact', taskId: 't-1', taskRevision: 1, kind: 'git_commit', repositoryPath: rootRepository ? '.' : 'repo', commitId: git('rev-parse', 'HEAD') };
  return { ...f, repo, git, profile, dispatcher, input };
}

test('Agent Git登记核验真实仓库并持久命令/来源，读取重核授权，重放不生成第二份', t => {
  const f = gitFixture(t);
  const registered = call(f.dispatcher, f.principal, 'artifact.register', f.input);
  assert.equal(registered.ok, true); assert.equal(registered.payload.version, f.input.commitId);
  const read = call(f.dispatcher, f.principal, 'artifact.read', { artifactId: registered.payload.artifactId });
  assert.equal(read.ok, true); assert.equal(read.payload.commit.commitSha, f.input.commitId); assert.equal(read.payload.repositoryPath, 'repo');
  assert.equal(call(f.dispatcher, f.principal, 'artifact.register', f.input).payload.commandId, registered.payload.commandId);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM artifact_git_sources').get().n, 1);
  const denied = call(f.dispatcher, f.principal, 'artifact.register', { ...f.input, requestId: 'missing', commitId: 'f'.repeat(40) });
  assert.equal(denied.ok, false);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM commands').get().n, 1);
  installSyntheticPolicy(f.store, 'p1', [{ ...f.profile, readPaths: ['tasks/*'] }]);
  const moved = path.join(f.dir, 'moved-repo');
  assert.equal(path.dirname(path.resolve(f.repo)), f.dir); assert.equal(path.dirname(path.resolve(moved)), f.dir);
  fs.renameSync(f.repo, moved);
  assert.equal(call(f.dispatcher, f.principal, 'artifact.read', { artifactId: registered.payload.artifactId }).payload.error, 'ARTIFACT_NOT_FOUND', '范围拒绝发生在访问已消失仓库之前');
});

test('项目根Git使用独立明确授权；点路径仍不能绕过普通路径语法', t => {
  const f = gitFixture(t, true);
  assert.equal(call(f.dispatcher, f.principal, 'artifact.register', f.input).ok, false);
  installSyntheticPolicy(f.store, 'p1', [{ ...f.profile, writePaths: ['repositories/root'] }]);
  const registered = call(f.dispatcher, f.principal, 'artifact.register', f.input);
  assert.equal(registered.ok, true);
  assert.equal(call(f.dispatcher, f.principal, 'artifact.read', { artifactId: registered.payload.artifactId }).payload.repositoryPath, '.');
});

test('角色职责读取与分页覆盖超过128个角色，按当前路径过滤并拒绝跨项目和旧游标', t => {
  const { store, principal, dispatcher } = fixture(t);
  for (let i = 0; i < 130; i++) createRole(store, { id: `role-${String(i).padStart(3, '0')}`, projectId: 'p1', name: `角色${i}`, charter: `职责${i}`, permissionProfileId: 'worker' }, 220);
  const seen = []; let cursor;
  do {
    const page = call(dispatcher, principal, 'role.list', { projectId: 'p1', limit: 50, ...(cursor ? { cursor } : {}) });
    assert.equal(page.ok, true);
    seen.push(...page.payload.items.map(item => item.id)); cursor = page.payload.nextCursor;
  } while (cursor);
  assert.equal(seen.length, 132); assert.equal(new Set(seen).size, 132);
  const detail = call(dispatcher, principal, 'role.read', { roleId: 'role-000' });
  assert.equal(detail.payload.charter, '职责0'); assert.equal(detail.payload.revision, 1);
  assert.equal(Object.hasOwn(detail.payload, 'credential'), false);
  assert.equal(call(dispatcher, principal, 'role.list', { projectId: 'foreign' }).payload.error, 'FORBIDDEN');
  assert.equal(call(dispatcher, principal, 'role.read', { roleId: 'missing' }).payload.error, 'FORBIDDEN');
  const first = call(dispatcher, principal, 'role.list', { projectId: 'p1', limit: 1 });
  store.db.exec("UPDATE roles SET scope_paths_json='[\"roles/role-000\"]' WHERE id='r-worker'");
  assert.equal(call(dispatcher, principal, 'role.list', { projectId: 'p1', cursor: first.payload.nextCursor }).payload.error, 'PAGE_CURSOR_STALE');
  assert.deepEqual(call(dispatcher, principal, 'role.list').payload.items.map(item => item.id), ['role-000']);
  assert.equal(call(dispatcher, principal, 'role.read', { roleId: 'r-peer' }).payload.error, 'FORBIDDEN');
});

function seedInbox(store) {
  store.db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('inbox-seed','p1','synthetic-user','inbox-seed',?,'project.pause','{}','completed',100)").run('0'.repeat(64));
  for (const id of ['same-a', 'same-b', 'same-c']) sendMessage(store, { id, projectId: 'p1', commandId: 'inbox-seed', toRoleId: 'r-worker', kind: 'question', body: `正文${id}` }, 250);
  sendMessage(store, { id: 'peer-only', projectId: 'p1', commandId: 'inbox-seed', toRoleId: 'r-peer', kind: 'question', body: '他人消息' }, 250);
}

test('收件箱固定本人，同毫秒逐页不漏消息；拒绝代读、畸形及跨工具游标', t => {
  const { store, principal, dispatcher } = fixture(t); seedInbox(store);
  const seen = []; let cursor;
  do {
    const page = call(dispatcher, principal, 'inbox.read', { roleId: 'r-worker', limit: 1, ...(cursor ? { cursor } : {}) });
    assert.equal(page.ok, true); seen.push(...page.payload.items.map(item => item.id)); cursor = page.payload.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, ['same-a', 'same-b', 'same-c']);
  assert.equal(call(dispatcher, principal, 'inbox.read', { roleId: 'r-peer' }).payload.error, 'FORBIDDEN');
  assert.equal(call(dispatcher, principal, 'inbox.read', { cursor: 250 }).ok, false);
  assert.equal(call(dispatcher, principal, 'inbox.read', { cursor: '!not-json' }).payload.error, 'INVALID_PAGE_CURSOR');
  assert.equal(call(dispatcher, principal, 'inbox.read', { states: ['stored'] }).ok, false, '不静默忽略固定合同之外的筛选');
  const roles = call(dispatcher, principal, 'role.list', { limit: 1 });
  assert.equal(call(dispatcher, principal, 'inbox.read', { cursor: roles.payload.nextCursor }).payload.error, 'PAGE_CURSOR_STALE');
  const page = call(dispatcher, principal, 'inbox.read', { limit: 1 });
  markDelivered(store, 'p1', 'same-a', {}, 260);
  assert.equal(call(dispatcher, principal, 'inbox.read', { cursor: page.payload.nextCursor }).payload.error, 'PAGE_CURSOR_STALE');
});

test('收件箱范围和授权变化使旧游标失效；读事务中再次验证可信连接', t => {
  const { store, principal, dispatcher } = fixture(t); seedInbox(store);
  const page = call(dispatcher, principal, 'inbox.read', { limit: 1 });
  store.db.exec("UPDATE roles SET scope_paths_json='[\"messages/same-b\"]' WHERE id='r-worker'");
  assert.equal(call(dispatcher, principal, 'inbox.read', { cursor: page.payload.nextCursor }).payload.error, 'PAGE_CURSOR_STALE');
  assert.deepEqual(call(dispatcher, principal, 'inbox.read').payload.items.map(item => item.id), ['same-b']);
  let checks = 0;
  const guarded = createToolDispatcher(store, { now: () => 300, callerNativeConversationId: 'native-1', assertTrustedConnection: () => { if (++checks === 2) throw new Error('SYNTHETIC_READ_SOURCE_CHANGED'); } });
  assert.equal(call(guarded, principal, 'inbox.read').ok, false); assert.equal(checks, 2);
  revokeBindingCredentials(store, 'b1', 280);
  assert.equal(call(dispatcher, principal, 'inbox.read').payload.error, 'AGENT_UNAUTHENTICATED');
});

const stableMessage = { requestId: 'rotation-request', toRoleId: 'r-peer', kind: 'question', body: '只保存一次', delivery: { mode: 'inbox', priority: 'normal' } };
function freshPrincipal(store, bindingId = 'b1', epoch = 1, session = { harnessId: 'synthetic', hostId: 'host', profileId: 'profile', nativeConversationId: 'native-1' }) {
  const issued = issueAgentCredential(store, bindingId, epoch, { isolation: 'verified_session', session }, 250, 60000);
  return authenticateAgentCredential(store, issued.credential, 300);
}

test('持久角色跨凭据轮换和重启重放同一消息；撤销主体及异内容不能重放', t => {
  const { store, open, principal, dispatcher } = fixture(t);
  const sent = call(dispatcher, principal, 'message.send', stableMessage);
  assert.equal(sent.ok, true);
  const firstCommand = store.db.prepare('SELECT * FROM commands WHERE id=?').get(sent.payload.commandId);
  revokeBindingCredentials(store, 'b1', 240);
  const replacement = freshPrincipal(store);
  assert.equal(call(dispatcher, principal, 'message.send', stableMessage).ok, false);
  store.close();
  const reopened = open();
  const recovered = createToolDispatcher(reopened, { now: () => 301, callerNativeConversationId: 'native-1' });
  const replay = call(recovered, replacement, 'message.send', stableMessage);
  assert.equal(replay.ok, true);
  assert.equal(replay.payload.commandId, sent.payload.commandId);
  assert.equal(replay.payload.entityIds[0].id, sent.payload.messageId);
  assert.equal(call(recovered, replacement, 'message.send', { ...stableMessage, body: '改写意图' }).payload.error, 'IDEMPOTENCY_CONFLICT');
  assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
  assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='message.stored'").get().n, 1);
  assert.deepEqual(reopened.db.prepare('SELECT * FROM commands WHERE id=?').get(firstCommand.id), firstCommand);
  assertRoleCommandSource(reopened, firstCommand, principal);
  installSyntheticPolicy(reopened, 'p1', [{ ...profileInput, actions: ['identity'] }]);
  assert.equal(call(recovered, replacement, 'message.send', stableMessage).payload.error, 'FORBIDDEN');
});

test('同角色换绑仍重放旧消息，不接受旧绑定身份；不同角色同requestId独立', t => {
  const { store, principal, dispatcher } = fixture(t);
  const sent = call(dispatcher, principal, 'message.send', stableMessage);
  store.db.exec("UPDATE role_bindings SET ended_at=240 WHERE id='b1'; INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s-new','synthetic','host','profile','native-new'); INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b-new','p1','r-worker','s-new',2,240)");
  const session = { ...principal.session, nativeConversationId: 'native-new' };
  const replacement = freshPrincipal(store, 'b-new', 2, session);
  const current = createToolDispatcher(store, { now: () => 300, callerNativeConversationId: 'native-new' });
  assert.equal(call(current, replacement, 'message.send', stableMessage).payload.commandId, sent.payload.commandId);
  assert.equal(call(dispatcher, principal, 'message.send', stableMessage).ok, false);
  store.db.exec("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s-peer','synthetic','host','profile','native-peer'); INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b-peer','p1','r-peer','s-peer',1,240); UPDATE roles SET binding_state='ready' WHERE id='r-peer'");
  const peer = freshPrincipal(store, 'b-peer', 1, { ...session, nativeConversationId: 'native-peer' });
  const peerDispatcher = createToolDispatcher(store, { now: () => 300, callerNativeConversationId: 'native-peer' });
  const peerSent = call(peerDispatcher, peer, 'message.send', { ...stableMessage, toRoleId: 'r-worker' });
  assert.equal(peerSent.ok, true);
  assert.notEqual(peerSent.payload.commandId, sent.payload.commandId);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 2);
});

function seedLegacyMessage(store, principal, commandId, messageId) {
  return store.transaction(db => {
    const input = { ...stableMessage, schemaVersion: 2, projectId: principal.projectId };
    const reservation = reserveMessageCommand(db, principal.credentialId, commandId, input, 260);
    assert.equal(reservation.replay, false);
    sendMessageWithin(db, { id: messageId, projectId: principal.projectId, commandId, toRoleId: input.toRoleId, kind: input.kind, body: input.body }, 260);
    return commitCommandReceipt(db, principal.credentialId, commandId, { requestId: input.requestId, projectId: principal.projectId, commandId, status: 'completed', receiptUrl: `/api/v1/commands/${commandId}/receipt`, entityIds: [{ localRef: messageId, entityType: 'message', id: messageId, revision: 1, version: null }], error: null, lastEventSequence: Number(db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM events WHERE project_id=?').get(principal.projectId).n) });
  });
}

test('迁移012→013保留旧凭据命令与回执，跨凭据重放旧效果并保留升级备份', t => {
  const { store, open, filename, principal } = fixture(t, defaultMigrations().slice(0, 12));
  const saved = seedLegacyMessage(store, principal, 'legacy-command', 'legacy-message');
  const before = store.db.prepare("SELECT * FROM commands WHERE id='legacy-command'").get();
  store.close();
  const upgraded = open();
  const replacement = freshPrincipal(upgraded);
  const dispatcher = createToolDispatcher(upgraded, { now: () => 300, callerNativeConversationId: 'native-1' });
  const replay = call(dispatcher, replacement, 'message.send', stableMessage);
  assert.equal(replay.ok, true);
  assert.equal(replay.payload.commandId, saved.commandId);
  assert.deepEqual(upgraded.db.prepare("SELECT * FROM commands WHERE id='legacy-command'").get(), before);
  assert.equal(upgraded.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
  assert.equal(upgraded.db.prepare('SELECT credential_id FROM agent_command_scopes').get().credential_id, principal.credentialId);
  assert.ok(fs.readdirSync(`${filename}.backups`).length > 0);
  assert.equal(upgraded.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(upgraded.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('迁移保留历史跨凭据重复效果并拒绝歧义重放，不挑选或生成第三份', t => {
  const { store, open, principal } = fixture(t, defaultMigrations().slice(0, 12));
  const second = freshPrincipal(store);
  seedLegacyMessage(store, principal, 'legacy-first', 'message-first');
  seedLegacyMessage(store, second, 'legacy-second', 'message-second');
  const commands = store.db.prepare('SELECT * FROM commands ORDER BY id').all();
  store.close();
  const upgraded = open();
  const replacement = freshPrincipal(upgraded);
  const dispatcher = createToolDispatcher(upgraded, { now: () => 300, callerNativeConversationId: 'native-1' });
  assert.equal(call(dispatcher, replacement, 'message.send', stableMessage).payload.error, 'AGENT_COMMAND_HISTORY_AMBIGUOUS');
  assert.deepEqual(upgraded.db.prepare('SELECT * FROM commands ORDER BY id').all(), commands);
  assert.equal(upgraded.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 2);
  assert.equal(upgraded.db.prepare('SELECT COUNT(*) AS n FROM agent_command_scopes').get().n, 2);
  assert.throws(() => seedLegacyMessage(upgraded, replacement, 'legacy-third', 'message-third'), /AGENT_COMMAND_HISTORY_AMBIGUOUS/);
  assert.equal(upgraded.db.prepare('SELECT COUNT(*) AS n FROM commands').get().n, 2);
});

test('两个真实进程使用不同凭据同时重放，只有一个命令消息和事件', { timeout: 15000 }, async t => {
  const children = [];
  t.after(async () => { await Promise.all(children.map(async child => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } })); });
  const { store, filename, principal } = fixture(t);
  const credentials = [0, 1].map(() => issueAgentCredential(store, 'b1', 1, { isolation: 'verified_session', session: principal.session }, 250, 60000).credential);
  const workers = credentials.map(credential => {
    const child = fork(new URL('./agent-idempotency-worker.mjs', import.meta.url), [filename], { execPath: process.execPath, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    children.push(child);
    const exited = once(child, 'exit');
    const ready = once(child, 'message');
    return { child, exited, ready, credential };
  });
  for (const worker of workers) assert.equal((await worker.ready)[0].type, 'ready');
  const replies = workers.map(worker => once(worker.child, 'message'));
  for (const worker of workers) worker.child.send({ credential: worker.credential, input: stableMessage });
  const results = (await Promise.all(replies)).map(([message]) => message);
  for (const result of results) assert.equal(result.ok, true);
  assert.equal(results[0].payload.commandId, results[1].payload.commandId);
  for (const worker of workers) assert.equal((await worker.exited)[0], 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM commands').get().n, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='message.stored'").get().n, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM agent_command_scopes').get().n, 1);
});

test('角色来源和凭据审计映射不可篡改，伪造来源命令不能挂接', t => {
  const { store, principal, dispatcher } = fixture(t);
  const sent = call(dispatcher, principal, 'message.send', stableMessage);
  assert.equal(sent.ok, true);
  assert.throws(() => store.db.prepare("UPDATE agent_role_sources SET source_principal_id='forged'").run(), /AGENT_SOURCE_IMMUTABLE/);
  assert.throws(() => store.db.prepare('DELETE FROM agent_role_sources').run(), /AGENT_SOURCE_RETAINED/);
  assert.throws(() => store.db.prepare('UPDATE agent_command_scopes SET credential_id=?').run(principal.credentialId), /AGENT_SCOPE_IMMUTABLE/);
  assert.throws(() => store.db.prepare('DELETE FROM agent_command_scopes').run(), /AGENT_SCOPE_RETAINED/);
  store.db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('user-command','p1','user','other-request',?,'project.pause','{}','stored',260)").run('0'.repeat(64));
  assert.throws(() => store.db.prepare("INSERT INTO agent_command_scopes(command_id,project_id,role_id,request_id,credential_id) VALUES('user-command','p1','r-worker','other-request',?)").run(principal.credentialId), /AGENT_COMMAND_SOURCE_MISMATCH/);
});

test('角色来源、命令、审计映射、消息和事件在业务失败时全部回滚', t => {
  const { store, principal, dispatcher } = fixture(t);
  store.db.exec("CREATE TRIGGER fail_message_event BEFORE INSERT ON events WHEN NEW.type='message.stored' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_MESSAGE_FAILURE'); END");
  assert.equal(call(dispatcher, principal, 'message.send', stableMessage).ok, false);
  for (const table of ['agent_role_sources', 'agent_command_scopes', 'commands', 'messages']) assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='message.stored'").get().n, 0);
  store.db.exec('DROP TRIGGER fail_message_event');
  assert.equal(call(dispatcher, principal, 'message.send', stableMessage).ok, true);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
});

test('identity取自连接绑定，不含秘密；正文role覆盖无效', t => {
  const { dispatcher, principal } = fixture(t);
  const result = call(dispatcher, principal, 'identity');
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, { kind: 'bound_agent', projectId: 'p1', roleId: 'r-worker', bindingEpoch: 1, credentialId: principal.credentialId, session: principal.session, note: result.payload.note });
  assert.equal(JSON.stringify(result.payload).includes(principal.credential), false, '不回显凭据原文');
  // 正文试图冒充他人身份：identity无入参入口，伪造args不影响
  const spoofed = call(dispatcher, principal, 'identity', { roleId: 'r-peer' });
  assert.equal(spoofed.payload.roleId, 'r-worker');
});

test('inbox.read仅本人消息；message.send→ack全链；非接收者ack拒绝', t => {
  const { store, dispatcher, principal } = fixture(t);
  store.transaction(db => db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('seed-cmd','p1','u','rq-seed',?,'project.pause','{}','completed',100)").run('0'.repeat(64)));
  sendMessage(store, { id: 'mine', projectId: 'p1', commandId: 'seed-cmd', toRoleId: 'r-worker', kind: 'notice', body: '给你的' }, 210);
  const peerMessage = sendMessage(store, { id: 'peers', projectId: 'p1', commandId: 'seed-cmd', toRoleId: 'r-peer', kind: 'notice', body: '给别人的' }, 211);
  void peerMessage;
  const inbox = call(dispatcher, principal, 'inbox.read');
  assert.equal(inbox.ok, true);
  assert.deepEqual(inbox.payload.items.map(m => m.id), ['mine'], '收件箱只含本人消息');
  // 发送给peer
  const sent = call(dispatcher, principal, 'message.send', { requestId: 'send-peer', toRoleId: 'r-peer', kind: 'question', body: '请确认', delivery: { mode: 'inbox', priority: 'normal' } });
  assert.equal(sent.ok, true);
  assert.equal(sent.payload.state, 'stored');
  // 确认peer的消息→不是接收者被拒
  const ackDenied = call(dispatcher, principal, 'message.ack', { messageId: 'peers' });
  assert.equal(ackDenied.ok, false);
  assert.match(ackDenied.payload.error, /MESSAGE_NOT_RECIPIENT|TRANSITION/);
  const ackMine = call(dispatcher, principal, 'message.ack', { messageId: 'mine' });
  assert.equal(ackMine.ok, false, 'stored未投递不可确认');
});

test('未授权动作和未知工具拒绝；项目隔离', t => {
  const { store, dispatcher, principal } = fixture(t);
  assert.equal(call(dispatcher, principal, 'management.apply_changes', {}).payload.error, 'FORBIDDEN', '档案无change.apply：先授权拒绝（不泄露能力面）');
  assert.equal(call(dispatcher, principal, 'task.claim', { taskId: 'x', expectedRevision: 0, expectedSpecRevision: 0 }).payload.error, 'FORBIDDEN', '基础档案无task.claim动作：先授权拒绝；授权通过后的显式不支持见T023专项测试');
  assert.equal(call(dispatcher, principal, 'nonexistent.tool', {}).payload.error, 'TOOL_UNKNOWN');
  // 项目隔离：principal属于p1，快照只回p1
  const snapshot = call(dispatcher, principal, 'project.snapshot');
  assert.equal(snapshot.payload.projectId, 'p1');
  assert.equal(call(dispatcher,principal,'project.snapshot',{projectId:'p-other'}).ok,false,'显式跨项目仍拒绝');
  assert.equal(call(dispatcher,principal,'project.snapshot',{sql:'SELECT *'}).ok,false,'不能借默认项目注入其他查询字段');
  void store;
});

test('artifact.register合同载荷经管线登记与角色清单；档案越权动作拒绝', t => {
  const { store, dispatcher, principal } = fixture(t);
  const root=store.db.prepare("SELECT canonical_root FROM projects WHERE id='p1'").get().canonical_root;fs.mkdirSync(path.join(root,'results'),{recursive:true});const content=Buffer.from('real file');fs.writeFileSync(path.join(root,'results/r.txt'),content);
  const registered = call(dispatcher, principal, 'artifact.register', { taskId: 't-1', kind: 'file', path: 'results/r.txt', sha256: createHash('sha256').update(content).digest('hex'), byteSize: content.length, taskRevision: 1 });
  assert.equal(registered.ok, true);
  assert.equal(registered.payload.pathRef, 'results/r.txt');
  assert.ok(store.db.prepare("SELECT 1 FROM commands WHERE type='artifact.register' AND state='completed'").get(), '登记进入命令管线');
  assert.ok(store.db.prepare("SELECT 1 FROM events WHERE type='artifact.registered'").get(), '登记事件已追加');
  const listed = call(dispatcher, principal, 'role.list');
  assert.equal(listed.ok, true);
  assert.equal(listed.payload.items.length, 2);
  // 档案不含native.input（且为用户保留动作）：构造越权调用被策略层拒绝
  const denied = dispatcher(principal, 'identity', {});
  assert.equal(denied.ok, true);
});


test('T023闭环：原生调用来源==绑定会话才放行（跨会话/跨线程凭据共享在派发点拒绝）', t => {
  const { store, dispatcher, principal } = fixture(t);
  // 已验证来源一致才放行；Browser使用独立用户入口
  assert.equal(call(dispatcher, principal, 'identity').ok, true);
  // 一致来源放行
  const okDispatcher = createToolDispatcher(store, { profileInput, now: () => 300, callerNativeConversationId: 'native-1' });
  assert.equal(call(okDispatcher, principal, 'identity').ok, true);
  // 不一致来源（同进程跨线程native-2）→CALLER_SESSION_MISMATCH
  const mismatch = createToolDispatcher(store, { profileInput, now: () => 300, callerNativeConversationId: 'native-2' });
  const denied = call(mismatch, principal, 'identity');
  assert.equal(denied.ok, false);
  assert.equal(denied.payload.error, 'FORBIDDEN');
  assert.equal(denied.payload.reason, 'CALLER_SESSION_MISMATCH');
  // 跨项目调用仍被隔离
  assert.equal(call(dispatcher, principal, 'project.snapshot').payload.projectId, 'p1');
  void store;
});

test('缺失原生来源及结构复制的主体均拒绝，不执行写操作', t => {
  const { store, dispatcher, principal } = fixture(t);
  for (const source of [undefined, '', 'native-other']) {
    const missing = createToolDispatcher(store, { profileInput, now: () => 300, callerNativeConversationId: source });
    const result = call(missing, principal, 'identity');
    assert.equal(result.ok, false);
    assert.equal(result.payload.reason, 'CALLER_SESSION_MISMATCH');
  }
  for (const forged of [{ ...principal }, JSON.parse(JSON.stringify(principal)), { ...principal, roleId: 'r-peer' }]) {
    const result = call(dispatcher, forged, 'message.send', { toRoleId: 'r-peer', kind: 'notice', body: '不应保存' });
    assert.equal(result.payload.error, 'AGENT_UNAUTHENTICATED');
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
});

test('缓存主体到期、撤销、换绑或原生目标漂移后，每次工具调用重新拒绝', t => {
  for (const scenario of ['expiry', 'revocation', 'binding', 'session', 'credential']) {
    const { store, principal } = fixture(t);
    let now = 300;
    const dispatcher = createToolDispatcher(store, { profileInput, now: () => now, callerNativeConversationId: 'native-1' });
    assert.equal(call(dispatcher, principal, 'identity').ok, true);
    if (scenario === 'expiry') now = 60110;
    if (scenario === 'revocation') revokeBindingCredentials(store, 'b1', 301);
    if (scenario === 'binding') store.db.exec("UPDATE role_bindings SET ended_at=301 WHERE id='b1'");
    if (scenario === 'session') store.db.exec("UPDATE sessions SET native_conversation_id='native-other' WHERE id='s1'");
    if (scenario === 'credential') store.db.prepare('DELETE FROM agent_credentials WHERE id=?').run(principal.credentialId);
    assert.equal(call(dispatcher, principal, 'identity').payload.error, 'AGENT_UNAUTHENTICATED', scenario);
    assert.equal(call(dispatcher, principal, 'message.send', { toRoleId: 'r-peer', kind: 'notice', body: '不应保存' }).ok, false, scenario);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0, scenario);
  }
});

test('写事务内再次核验：授权后凭据到期，命令和事件全部不落库', t => {
  const { store, principal } = fixture(t);
  installSyntheticPolicy(store, 'p1', [fullProfile]);
  let ticks = 0;
  const dispatcher = createToolDispatcher(store, { profileInput: fullProfile, now: () => ++ticks <= 2 ? 300 : 60110, callerNativeConversationId: 'native-1' });
  const before = store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
  const result = call(dispatcher, principal, 'issue.raise', { taskId: 't-1', category: 'technical', summary: '不得写入', evidenceArtifactIds: [] });
  assert.equal(result.ok, false);
  assert.equal(result.payload.error, 'AGENT_UNAUTHENTICATED');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM commands').get().n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, before);
});

test('消息拥有独立可信来源和回执，重启后同请求不重复保存，同键异内容拒绝', t => {
  const { store, open, principal, dispatcher } = fixture(t);
  const input = { requestId: 'message-stable', toRoleId: 'r-peer', kind: 'question', body: '请核对', taskId: 't-1', delivery: { mode: 'when_available', priority: 'urgent' } };
  const sent = call(dispatcher, principal, 'message.send', input);
  assert.equal(sent.ok, true);
  assert.equal(sent.payload.requestId, input.requestId);
  const command = store.db.prepare('SELECT * FROM commands WHERE id=?').get(sent.payload.commandId);
  assert.equal(command.type, 'message.send');
  assertRoleCommandSource(store, command, principal);
  const message = store.db.prepare('SELECT * FROM messages WHERE id=?').get(sent.payload.messageId);
  assert.equal(message.command_id, command.id);
  assert.equal(message.task_id, 't-1');
  const route = JSON.parse(message.delivery_json);
  assert.deepEqual(route.delivery, input.delivery);
  assert.equal(route.fromRoleId, principal.roleId);
  assert.equal(route.bindingEpoch, principal.bindingEpoch);
  const event = store.db.prepare("SELECT * FROM events WHERE type='message.stored'").get();
  assert.equal(event.causation_id, command.id);
  store.close();
  const reopened = open();
  const recovered = createToolDispatcher(reopened, { profileInput, now: () => 301, callerNativeConversationId: 'native-1' });
  const replay = call(recovered, principal, 'message.send', input);
  assert.equal(replay.ok, true);
  assert.equal(replay.payload.commandId, sent.payload.commandId);
  assert.equal(replay.payload.entityIds[0].id, sent.payload.messageId);
  assert.equal(call(recovered, principal, 'message.send', { ...input, body: '不同意图' }).payload.error, 'IDEMPOTENCY_CONFLICT');
  assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
  assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='message.stored'").get().n, 1);
});

test('消息拒绝借用命令/伪造来源，缺失请求键或无效引用不留下部分状态', t => {
  const { store, dispatcher, principal } = fixture(t);
  const input = { requestId: 'message-invalid', toRoleId: 'r-peer', kind: 'information', body: '资料', delivery: { mode: 'inbox', priority: 'normal' } };
  const eventCount = store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
  for (const altered of [
    { ...input, commandId: 'another-command' },
    { ...input, fromRoleId: 'r-peer' },
    { ...input, requestId: '' },
    { ...input, toRoleId: 'missing-role' },
    { ...input, replyToMessageId: 'missing-reply' },
    { ...input, artifacts: [{ artifactId: 'missing-artifact', version: 'v1' }] },
  ]) {
    assert.equal(call(dispatcher, principal, 'message.send', altered).ok, false);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM commands').get().n, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, eventCount);
  }
  // 入参不能将消息移到其他项目。
  const accepted = call(dispatcher, principal, 'message.send', { ...input, projectId: 'other-project' });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.payload.projectId, principal.projectId);
});

test('成果登记在事务内核验授权路径、任务归属与规格，拒绝时无命令和成果残留', t => {
  const { store, dispatcher, principal } = fixture(t);
  const input = { taskId: 't-1', kind: 'file', path: 'results/r.txt', sha256: 'a'.repeat(64), byteSize: 10, taskRevision: 1 };
  for (const target of ['private/key.txt', '../results/r.txt', 'E:/outside/r.txt', 'results/../r.txt']) {
    const result = call(dispatcher, principal, 'artifact.register', { ...input, path: target });
    assert.equal(result.ok, false);
    assert.match(result.payload.error, /PATH_OUT_OF_SCOPE/);
  }
  store.db.exec("UPDATE tasks SET role_id='r-peer' WHERE id='t-1'");
  assert.equal(call(dispatcher, principal, 'artifact.register', input).payload.error, 'ARTIFACT_TASK_NOT_OWNED');
  store.db.exec("UPDATE tasks SET role_id='r-worker',spec_revision=2 WHERE id='t-1'");
  assert.equal(call(dispatcher, principal, 'artifact.register', input).payload.error, 'ARTIFACT_TASK_REVISION_STALE');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM commands').get().n, 0);
});

test('结果提交使用本人绑定尝试与独立幂等命令，不能提交同项目其他角色的尝试', t => {
  const base = fixture(t);
  const { store, principal } = base;
  const dispatcher = withFullProfile(base);
  store.db.exec("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s2','synthetic','host','profile','native-2'); INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b2','p1','r-peer','s2',1,100)");
  store.db.exec("INSERT INTO attempts(id,project_id,task_id,task_revision,binding_id,binding_epoch,state,started_at,ended_at) VALUES('a-own','p1','t-1',1,'b1',1,'failed',200,250),('a-peer','p1','t-1',1,'b2',1,'failed',200,250)");
  const input = { requestId: 'result-own', taskId: 't-1', taskRevision: 1, attemptId: 'a-own', bindingEpoch: 1, outcome: 'failed', summary: '缺依赖', outputs: [], checks: [], remainingIssues: ['需要用户输入'] };
  assert.equal(call(dispatcher, principal, 'task.submit_result', { ...input, attemptId: 'a-peer' }).payload.error, 'RESULT_ATTEMPT_NOT_OWNED');
  assert.equal(call(dispatcher, principal, 'task.submit_result', { ...input, bindingEpoch: 2 }).payload.error, 'RESULT_BINDING_STALE');
  const accepted = call(dispatcher, principal, 'task.submit_result', input);
  assert.equal(accepted.ok, true);
  const command = store.db.prepare("SELECT * FROM commands WHERE type='task.submit_result'").get();
  assertRoleCommandSource(store, command, principal);
  assert.deepEqual(JSON.parse(command.payload_json).remainingIssues, input.remainingIssues);
  assert.equal(call(dispatcher, principal, 'task.submit_result', input).payload.commandId, accepted.payload.commandId);
  const replacement = freshPrincipal(store);
  assert.equal(call(dispatcher, replacement, 'task.submit_result', input).payload.commandId, accepted.payload.commandId, '新凭据仍重放原结果命令');
  assertRoleCommandSource(store, command, principal);
  assert.equal(call(dispatcher, principal, 'task.submit_result', { ...input, summary: '改变内容' }).payload.error, 'IDEMPOTENCY_CONFLICT');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM results').get().n, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='result.submitted'").get().n, 1);
});


const fullProfile = { id: 'worker', revision: 1, actions: ['identity', 'project.read', 'role.read', 'message.read_own', 'message.send', 'message.ack_own', 'artifact.register_own', 'artifact.read', 'task.submit_own', 'case.raise', 'case.read', 'task.claim', 'task.report_own', 'task.accept_assigned', 'change.apply'], readPaths: ['tasks/*', 'messages/*', 'cases/*'], writePaths: ['tasks/*', 'messages/*', 'cases/*'], roleIds: [], delegableActions: [], maxDelegationDepth: 0 };
const withFullProfile = base => { installSyntheticPolicy(base.store, 'p1', [fullProfile]); return createToolDispatcher(base.store, { profileInput: fullProfile, now: () => 300, callerNativeConversationId: 'native-1' }); };

test('T023命令管线：message.ack经统一管线（命令行+回执+事件+绑定代次校验）；正文role覆盖无效', t => {
  const base = fixture(t);
  const dispatcher = withFullProfile(base);
  base.store.transaction(db => db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('seed-cmd','p1','u','rq0',?,'project.pause','{}','completed',100)").run('0'.repeat(64)));
  sendMessage(base.store, { id: 'm-pipe', projectId: 'p1', commandId: 'seed-cmd', toRoleId: 'r-worker', kind: 'notice', body: '管线确认' }, 210);
  markDelivered(base.store, 'p1', 'm-pipe', { channel: 'synthetic' }, 250);
  const acked = call(dispatcher, base.principal, 'message.ack', { messageId: 'm-pipe', roleId: 'r-peer', requestId: 'ack-1' });
  assert.equal(acked.ok, true, '管线确认成功');
  assert.equal(acked.payload.status, 'completed', '结构化回执');
  assert.equal(acked.payload.state, 'acknowledged');
  const cmd = base.store.db.prepare("SELECT id,source_principal_id,state FROM commands WHERE type='message.ack'").get();
  assert.ok(cmd, '命令进入统一命令管线');
  assertRoleCommandSource(base.store, cmd, base.principal);
  assert.equal(cmd.state, 'completed');
  assert.ok(base.store.db.prepare("SELECT 1 FROM events WHERE type='message.acknowledged' AND entity_id='m-pipe'").get(), '事件已追加');
  // 同requestId重试→幂等回放同一回执
  const replay = call(dispatcher, base.principal, 'message.ack', { messageId: 'm-pipe', requestId: 'ack-1' });
  assert.equal(replay.ok, true);
  assert.equal(replay.payload.commandId, acked.payload.commandId, '幂等回放');
});

test('T023命令管线：issue.raise经管线（owner=主体角色，正文指定无效）；issue.read只读本项目', t => {
  const base = fixture(t);
  const dispatcher = withFullProfile(base);
  const raised = call(dispatcher, base.principal, 'issue.raise', { taskId: 't-1', category: 'technical', summary: '阻塞：缺少依赖产物', evidenceArtifactIds: [], ownerRoleId: 'r-peer' });
  assert.equal(raised.ok, true);
  assert.equal(raised.payload.merged, false);
  const row = base.store.db.prepare("SELECT owner_role_id FROM cases WHERE fingerprint IS NOT NULL").get();
  assert.equal(row.owner_role_id, 'r-worker', 'owner归属来自主体而非正文');
  assert.ok(base.store.db.prepare("SELECT 1 FROM commands WHERE type='issue.raise' AND state='completed'").get(), '管线完成');
  assert.ok(base.store.db.prepare("SELECT 1 FROM events WHERE type='issue.raised'").get(), '事件已追加');
  const merged = call(dispatcher, base.principal, 'issue.raise', { taskId: 't-1', category: 'technical', summary: '阻塞：缺少依赖产物', evidenceArtifactIds: [] });
  assert.equal(merged.ok, true);
  assert.equal(merged.payload.merged, true, '同指纹合并');
  const list = call(dispatcher, base.principal, 'issue.read', {});
  assert.equal(list.ok, true);
  assert.equal(list.payload.openIssues.length, 1);
  const one = call(dispatcher, base.principal, 'issue.read', { caseId: list.payload.openIssues[0].id });
  assert.equal(one.ok, true);
  assert.equal(one.payload.state, 'open');
  const missing = call(dispatcher, base.principal, 'issue.read', { caseId: 'missing' });
  assert.equal(missing.ok, false);
});

test('T023：task.submit_result域校验拒绝无尝试提交；越权先于能力拒绝', t => {
  const base = fixture(t);
  const dispatcher = withFullProfile(base);
  const bad = call(dispatcher, base.principal, 'task.submit_result', { requestId: 'bad-result', taskId: 't-x', taskRevision: 1, attemptId: 'a-x', bindingEpoch: 1, outcome: 'failed', summary: '无尝试', outputs: [], checks: [], remainingIssues: [] });
  assert.equal(bad.ok, false);
  assert.match(bad.payload.error, /RESULT_TASK_NOT_FOUND|RESULT_ATTEMPT_NOT_FOUND/);
  const claim = call(dispatcher, base.principal, 'task.claim', { requestId: 'missing-task-claim', taskId: 't-x', expectedRevision: 1, expectedSpecRevision: 1 });
  assert.equal(claim.payload.error, 'TASK_NOT_FOUND', '已接线工具仍须检查目标存在，不能造替代任务或执行');
  const narrow = { ...fullProfile, actions: fullProfile.actions.filter(a => a !== 'task.claim') };
  const base2 = fixture(t);
  const nd = createToolDispatcher(base2.store, { profileInput: narrow, now: () => 300, callerNativeConversationId: 'native-1' });
  const denied = call(nd, base2.principal, 'task.claim', { taskId: 't-x' });
  assert.equal(denied.payload.error, 'FORBIDDEN', '档案不含动作→先拒绝，不泄露能力面');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { SessionToolHost } from '../../../apps/kernel/dist/tools/session-tool-host.js';
import { NativeSessionLease } from '../../../apps/kernel/dist/native/session-lease.js';
import { NativeCompatibilityRegistry } from '../../../apps/kernel/dist/native/compatibility.js';
import { installSyntheticPolicy } from './synthetic-policy.mjs';
import { completeStartupAck } from '../../../packages/domain/dist/bootstrap/index.js';
import { createToolDispatcher } from '../../../apps/kernel/dist/tools/gateway-tools.js';
import { assertAgentPrincipalCurrent } from '../../../apps/kernel/dist/auth/agent-credential.js';
import { registerArtifact } from '../../../packages/domain/dist/artifacts/index.js';
import { sendMessage } from '../../../packages/domain/dist/messages/index.js';
import { executionFixture } from './execution-fixture.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  const hosts = []; let lease;
  t.after(() => { for (const host of hosts) host.close(); lease?.releaseAfterExit(true); });
  const f = executionFixture(t); let clock = 300, owner = true, isolation = true, execution = null;
  const profile = { id: 'execution', revision: 1, actions: ['identity', 'task.read', 'role.read', 'policy.read', 'role.startup_ack', 'task.claim', 'task.report_own', 'task.submit_own', 'task.accept_assigned', 'message.read_own', 'message.send', 'message.ack_own', 'artifact.read', 'artifact.register_own', 'case.raise'], readPaths: ['tasks/*', 'roles/*', 'messages/*', 'results/*'], writePaths: ['tasks/*', 'results/*'], roleIds: [], delegableActions: [], maxDelegationDepth: 0 };
  installSyntheticPolicy(f.store, 'p', [profile]);
  completeStartupAck(f.store, { projectId: 'p', roleId: 'worker', bindingEpoch: 1, protocolVersion: 2, policyRevision: 1, planRevision: 0, roleRevision: 2, taskSpecRevisions: [{ taskId: 'task', specRevision: 1 }, { taskId: 'next', specRevision: 1 }] }, 160);
  const executable = path.join(f.dir, 'synthetic-native.txt'); fs.writeFileSync(executable, 'synthetic-only executable identity');
  const leaseDirectory = path.join(f.dir, 'leases'); fs.mkdirSync(leaseDirectory); lease = NativeSessionLease.acquire(leaseDirectory, f.session);
  const registry = new NativeCompatibilityRegistry();
  const identity = { harnessId: 'zcode', version: 'synthetic-host-only', executableSha256: createHash('sha256').update(fs.readFileSync(executable)).digest('hex'), bundleSha256: null, adapterProtocol: 'synthetic-mcp-pipes-v1', route: 'official_extension' };
  const prove = capabilities => registry.recordTrustedProbe({ identity, probeId: 'synthetic-only', evidenceSha256: 'c'.repeat(64), capabilities }); prove({ roleTools: 'verified' });
  const options = { bindingId: 'binding', bindingEpoch: 1, session: f.session, nativeOwner: lease, executable, identity, registry, now: () => clock, isKernelOwner: () => owner, currentExecutionId: () => execution, assertIsolation: () => { if (!isolation) throw new Error('SYNTHETIC_PRIVATE_GUARD_ERROR'); } };
  const host = (overrides = {}) => { const result = SessionToolHost.create(f.store, { ...options, ...overrides }); hosts.push(result); return result; };
  const start = async () => { const id = f.prepare(); const run = f.coordinator.run(id); await tick(); execution = 'native-turn'; return { id, run }; };
  return Object.assign(f, { host, options, executable, prove, lease, start, setOwner: v => { owner = v; }, setIsolation: v => { isolation = v; }, setExecution: v => { execution = v; }, setTime: v => { clock = v; } });
}
function client(connection, protocol = '2025-06-18') {
  let id = 0;
  const send = (method, params) => connection.receive({ jsonrpc: '2.0', id: ++id, method, ...(params === undefined ? {} : { params }) });
  const init = send('initialize', { protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } });
  connection.receive({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const call = (tool, args = {}) => { const reply = send('tools/call', { name: `projectorch_${tool.replaceAll('.', '_')}`, arguments: args }); return { reply, data: reply.result ? JSON.parse(reply.result.content[0].text) : null }; };
  return { send, call, init };
}

test('原生MCP宿主返回固定成果错误码，底层私密错误仍隐藏',async t=>{
 const f=fixture(t),host=f.host(),{run}=await f.start(),c=client(host.connect());
 try{
  assert.equal(c.call('task.claim',{requestId:'claim-file-check',taskId:'task',expectedRevision:1,expectedSpecRevision:1}).reply.result.isError,false);
  const bytes=Buffer.from('actual report'),hash=createHash('sha256').update(bytes).digest('hex');fs.mkdirSync(path.join(f.dir,'results'),{recursive:true});fs.writeFileSync(path.join(f.dir,'results/report.md'),bytes);
  const args={taskId:'task',taskRevision:1,kind:'report',path:'results/report.md',sha256:hash,byteSize:bytes.length};
  for(const [name,change,error]of [
   ['missing',{path:'results/missing.md'},'ARTIFACT_FILE_MISSING_USE_PROJECT_RELATIVE_PATH'],
   ['hash',{sha256:'f'.repeat(64)},'ARTIFACT_FILE_HASH_OR_SIZE_MISMATCH'],
   ['size',{byteSize:99},'ARTIFACT_FILE_HASH_OR_SIZE_MISMATCH']
  ]){const reply=c.call('artifact.register',{...args,...change,requestId:'host-'+name});assert.equal(reply.reply.result.isError,true);assert.equal(reply.data.error,error);assert.doesNotMatch(JSON.stringify(reply),/results\/|private-path/);}
  f.store.db.exec("CREATE TRIGGER private_failure BEFORE INSERT ON artifacts BEGIN SELECT RAISE(ABORT,'private-path/SECRET'); END");
  const denied=c.call('artifact.register',{...args,requestId:'private-failure'});assert.equal(denied.data.error,'TOOL_REJECTED');assert.doesNotMatch(JSON.stringify(denied),/private-path|SECRET/);
  f.store.db.exec('DROP TRIGGER private_failure');
 }finally{host.close();f.finish();assert.equal(await run,'succeeded');}
});

test('空闲宿主只列授权读取/握手，来源固定；调用参数不能覆盖角色或会话', t => {
  const f = fixture(t); const host = f.host(), connection = host.connect(), c = client(connection);
  const names = c.send('tools/list').result.tools.map(x => x.name);
  assert.ok(names.includes('projectorch_task_read')); assert.ok(names.includes('projectorch_role_startup_ack')); assert.equal(names.includes('projectorch_task_claim'), false);
  assert.equal(c.call('identity', { roleId: 'other', callerNativeConversationId: 'other' }).data.error, 'VALIDATION_ERROR');
  const identity = c.call('identity').data; assert.equal(identity.roleId, 'worker'); assert.equal(identity.session.nativeConversationId, f.session.nativeConversationId);
  assert.equal(c.call('task.claim', { requestId: 'x', taskId: 'task', expectedRevision: 1, expectedSpecRevision: 1 }).data.error, 'FORBIDDEN');
  assert.throws(() => host.connect(), /OCCUPIED/); assert.throws(() => f.host(), /OWNER_OCCUPIED/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM commands').get().n, 0);
});

test('程序字节/能力/隔离/owner/会话或异步证明不成立时，创建失败不颁发凭据', t => {
  const f = fixture(t); const before = f.store.db.prepare('SELECT COUNT(*) AS n FROM agent_credentials').get().n;
  for (const scenario of ['capability', 'isolation', 'owner', 'session', 'async']) {
    if (scenario === 'capability') f.prove({ roleTools: 'unsupported' });
    if (scenario === 'isolation') f.setIsolation(false);
    if (scenario === 'owner') f.setOwner(false);
    assert.throws(() => f.host(scenario === 'session' ? { session: { ...f.session, nativeConversationId: 'other' } } : scenario === 'async' ? { assertIsolation: () => Promise.reject(new Error('private')) } : {}));
    f.prove({ roleTools: 'verified' }); f.setIsolation(true); f.setOwner(true);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM agent_credentials').get().n, before, scenario);
  }
  fs.appendFileSync(f.executable, 'changed'); assert.throws(() => f.host(), /NATIVE_UNVERIFIED/); assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM agent_credentials').get().n, before);
});

test('启动审计失败颁发整册回滚；关闭只撤销自己凭据，不释放原生租约', t => {
  const f = fixture(t); const before = f.store.db.prepare('SELECT COUNT(*) AS n FROM agent_credentials').get().n;
  f.store.db.exec("CREATE TRIGGER synthetic_host_audit_failure BEFORE INSERT ON events WHEN NEW.type='tool_host.opened' BEGIN SELECT RAISE(ABORT,'synthetic_host_audit_failure'); END");
  assert.throws(() => f.host(), /synthetic_host_audit_failure/); assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM agent_credentials').get().n, before);
  f.store.db.exec('DROP TRIGGER synthetic_host_audit_failure');
  const host = f.host(); const connection = host.connect(); host.close();
  assert.equal(connection.closed, true); assertAgentPrincipalCurrent(f.store, f.principal, 300);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM agent_credentials WHERE revoked_at IS NOT NULL').get().n, 1);
  f.lease.assertCurrent(f.session); assert.throws(() => host.connect(), /CLOSED/);
});

test('凭据撤销/到期、原生更新、能力撤回、隔离和内核归属变化均关闭旧连接', t => {
  for (const scenario of ['revoke', 'expire', 'file', 'proof', 'isolation', 'owner']) {
    const f = fixture(t); const host = f.host({ ttlMs: 10 }); const connection = host.connect(); const c = client(connection);
    if (scenario === 'revoke') f.store.db.exec('UPDATE agent_credentials SET revoked_at=300');
    if (scenario === 'expire') f.setTime(310);
    if (scenario === 'file') fs.appendFileSync(f.executable, 'updated');
    if (scenario === 'proof') f.prove({ roleTools: 'unsupported' });
    if (scenario === 'isolation') f.setIsolation(false);
    if (scenario === 'owner') f.setOwner(false);
    const reply = c.send('tools/list'); assert.equal(reply.error.code, -32000, scenario); assert.equal(connection.closed, true);
    assert.doesNotMatch(JSON.stringify(reply), /SYNTHETIC_PRIVATE/);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM commands').get().n, 0);
  }
});

test('换原生执行后旧MCP连接失效；新连接精确承接running尝试，重连业务请求不重复', async t => {
  const f = fixture(t); const host = f.host(), old = host.connect(), oldClient = client(old);
  const { id, run } = await f.start(); assert.equal(oldClient.send('tools/list').error.code, -32000); assert.equal(old.closed, true);
  const current = host.connect(); const c = client(current);
  const args = { requestId: 'claim-host', taskId: 'task', expectedRevision: 1, expectedSpecRevision: 1 };
  const first = c.call('task.claim', args); assert.equal(first.reply.result.isError, false); assert.equal(first.data.attemptId, id);
  assert.equal(c.call('task.claim', args).data.commandId, first.data.commandId);
  current.close(); const reconnected = client(host.connect());
  assert.equal(reconnected.call('task.claim', args).data.commandId, first.data.commandId, '同执行重连不更换幂等来源');
  const originalCredential = f.store.db.prepare('SELECT credential_id FROM agent_command_scopes WHERE command_id=?').get(first.data.commandId).credential_id;
  host.close();
  const replacementHost = f.host();
  const replacement = client(replacementHost.connect());
  assert.equal(replacement.call('task.claim', args).data.commandId, first.data.commandId, '新宿主颁发不同凭据仍重放原命令');
  assert.equal(f.store.db.prepare('SELECT revoked_at FROM agent_credentials WHERE id=?').get(originalCredential).revoked_at, 300);
  assert.notEqual(f.store.db.prepare('SELECT credential_id FROM agent_command_scopes WHERE command_id=?').get(first.data.commandId).credential_id, replacement.call('identity').data.credentialId);
  replacementHost.close(); f.finish(); assert.equal(await run, 'succeeded');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM commands').get().n, 1);
});

test('写事务内再次检查受信来源，检查失败没有命令或业务副作用', t => {
  const f = fixture(t); let checks = 0;
  const dispatch = createToolDispatcher(f.store, { now: () => 300, callerNativeConversationId: f.session.nativeConversationId, assertTrustedConnection: () => { if (++checks === 2) throw new Error('SYNTHETIC_CONNECTION_CHANGED'); } });
  const outcome = dispatch(f.principal, 'task.report', { requestId: 'guard', taskId: 'task', attemptId: 'none', bindingEpoch: 1, report: 'should not persist', wait: null });
  assert.equal(outcome.ok, false); assert.equal(checks, 2);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM commands').get().n, 0); assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM task_reports').get().n, 0);
});

test('MCP握手、旧协议、初始化前调用、重复ID与大帧失败均不造成业务写入', async t => {
  const f = fixture(t); const host = f.host(); const first = host.connect();
  assert.equal(first.receive({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).error.code, -32000);
  first.close(); const second = host.connect(); const c = client(second, '2024-11-05'); assert.equal(c.init.result.protocolVersion, '2024-11-05');
  assert.equal(second.receive({ jsonrpc: '2.0', id: 1, method: 'ping' }).error.code, -32600); assert.equal(second.closed, true);
  const large = host.connect(); const input = new PassThrough(), output = new PassThrough(); output.resume(); large.attach(input, output);
  input.write('x'.repeat(1024 * 1024 + 1)); await tick(); assert.equal(large.closed, true);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM commands').get().n, 0);
});

test('任务读取分页按授权过滤，游标不可跨策略复用；策略读和跨项目读取受限', t => {
  const f = fixture(t); const c = client(f.host().connect());
  const page = c.call('task.list', { projectId: 'p', limit: 1 }).data; assert.equal(page.items.length, 1); assert.ok(page.nextCursor);
  assert.equal(c.call('task.read', { taskId: 'task' }).data.specRevision, 1);
  assert.equal(c.call('policy.read', { projectId: 'other' }).data.error, 'FORBIDDEN'); assert.equal(c.call('task.list', { projectId: 'other' }).data.error, 'FORBIDDEN');
  f.store.db.exec("UPDATE roles SET scope_paths_json='[\"tasks/task\"]' WHERE id='worker'");
  assert.equal(c.call('task.list', { projectId: 'p', cursor: page.nextCursor }).data.error, 'PAGE_CURSOR_STALE');
  assert.deepEqual(c.call('task.list', { projectId: 'p' }).data.items.map(v => v.id), ['task']);
  assert.equal(c.call('task.read', { taskId: 'next' }).data.error, 'FORBIDDEN');
});

test('MCP目录接通角色职责和本人收件箱读取，不能通过roleId代读或注入来源', t => {
  const f = fixture(t); const c = client(f.host().connect());
  const names = c.send('tools/list').result.tools.map(item => item.name);
  for (const name of ['projectorch_role_read', 'projectorch_role_list', 'projectorch_inbox_read']) assert.ok(names.includes(name));
  const role = c.call('role.read', { roleId: 'worker' });
  assert.equal(role.reply.result.isError, false); assert.equal(role.data.id, 'worker'); assert.equal(typeof role.data.charter, 'string');
  assert.ok(c.call('role.list', { projectId: 'p' }).data.items.some(item => item.id === 'worker'));
  assert.equal(c.call('role.list', { projectId: 'foreign' }).data.error, 'FORBIDDEN');
  f.store.db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('inbox-seed','p','synthetic-user','inbox-seed',?,'test','{}','completed',200)").run('a'.repeat(64));
  sendMessage(f.store, { id: 'mcp-message', projectId: 'p', commandId: 'inbox-seed', toRoleId: 'worker', kind: 'question', body: '专用合成消息' }, 250);
  assert.equal(c.call('inbox.read', { roleId: 'worker' }).data.items[0].body, '专用合成消息');
  assert.equal(c.call('inbox.read', { roleId: 'other' }).data.error, 'FORBIDDEN');
  assert.equal(c.call('inbox.read', { roleId: 'worker', callerNativeConversationId: 'other' }).data.error, 'VALIDATION_ERROR');
  assert.equal(c.call('inbox.read', { roleId: 'worker', cursor: 250 }).data.error, 'VALIDATION_ERROR');
});

test('成果元数据按真实项目根核对，不把原生workspace身份误作文件系统路径', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.dir, 'results'));
  const bytes = Buffer.from('synthetic evidence'); fs.writeFileSync(path.join(f.dir, 'results', 'evidence.txt'), bytes);
  const hash = createHash('sha256').update(bytes).digest('hex');
  registerArtifact(f.store, { id: 'evidence', projectId: 'p', taskId: 'task', taskRevision: 1, version: hash, pathRef: 'results/evidence.txt', sha256: hash, byteSize: bytes.length }, 200);
  const c = client(f.host().connect()); const reply = c.call('artifact.read', { artifactId: 'evidence' });
  assert.equal(reply.reply.result.isError, false); assert.equal(reply.data.sha256, hash); assert.equal(reply.data.pathRef, 'results/evidence.txt');
  registerArtifact(f.store, { id: 'private', projectId: 'p', taskId: 'task', taskRevision: 1, version: hash, pathRef: 'private/evidence.txt', sha256: hash, byteSize: bytes.length }, 200);
  assert.deepEqual(c.call('artifact.read', { artifactId: 'private' }).data, c.call('artifact.read', { artifactId: 'missing' }).data, '越权成果与不存在成果同样拒绝，不先触碰文件路径');
  registerArtifact(f.store, { id: 'git-reference', projectId: 'p', taskId: 'task', taskRevision: 1, version: 'a'.repeat(40), pathRef: `git:${'a'.repeat(40)}` }, 200);
  assert.equal(c.call('artifact.read', { artifactId: 'git-reference' }).data.error, 'CAPABILITY_UNSUPPORTED');
});

test('MCP成果内容按固定版本和当前范围读取，正文不能传路径或伪装主体', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.dir, 'results'));
  const bytes = Buffer.from('合成成果内容🙂'), hash = createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(f.dir, 'results', 'content.txt'), bytes);
  registerArtifact(f.store, { id: 'content', projectId: 'p', taskId: 'task', taskRevision: 1, version: hash, pathRef: 'results/content.txt', sha256: hash, byteSize: bytes.length }, 200);
  registerArtifact(f.store, { id: 'private-content', projectId: 'p', taskId: 'task', taskRevision: 1, version: hash, pathRef: 'private/content.txt', sha256: hash, byteSize: bytes.length }, 200);
  const c = client(f.host().connect()), args = { artifactId: 'content', version: hash, offset: 0 };
  assert.ok(c.send('tools/list').result.tools.some(item => item.name === 'projectorch_artifact_content'));
  const first = c.call('artifact.content', args);
  assert.equal(first.reply.result.isError, false); assert.equal(first.data.content, bytes.toString('utf8')); assert.equal(first.data.encoding, 'utf8'); assert.equal(first.data.sha256, hash);
  assert.equal(c.call('artifact.content', { ...args, roleId: 'other', path: 'private/key' }).data.error, 'VALIDATION_ERROR');
  assert.equal(c.call('artifact.content', { ...args, version: 'other' }).data.error, 'ARTIFACT_VERSION_CONFLICT');
  assert.equal(c.call('artifact.content', { ...args, artifactId: 'private-content' }).data.error, 'ARTIFACT_NOT_FOUND');
  assert.equal(c.call('artifact.content', { ...args, artifactId: 'missing' }).data.error, 'ARTIFACT_NOT_FOUND');
  fs.writeFileSync(path.join(f.dir, 'results', 'content.txt'), 'changed');
  assert.equal(c.call('artifact.content', args).data.error, 'ARTIFACT_CONTENT_CHANGED');
});

test('真实独立MCP客户端进程经匿名管道读取身份/任务并认领，客户端没有原始凭据', async t => {
  let child;
  t.after(async () => { if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('close', resolve)); } });
  const f = fixture(t); const { id, run } = await f.start(); const host = f.host();
  const env = {}; for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'COMSPEC']) if (process.env[name]) env[name] = process.env[name];
  child = spawn(process.execPath, [fileURLToPath(new URL('./tool-host-client-worker.mjs', import.meta.url))], { cwd: f.dir, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { stderr += text; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  host.connect().attach(child.stdout, child.stdin);
  assert.deepEqual(await closed, { code: 0, signal: null }); assert.deepEqual(JSON.parse(stderr), { identityBound: true, taskRead: true, taskClaimed: true, credentialProvidedToClient: false });
  assert.equal(f.store.db.prepare("SELECT state FROM tasks WHERE id='task'").get().state, 'active');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE id=?').get(id).n, 1);
  f.finish(); assert.equal(await run, 'succeeded');
});

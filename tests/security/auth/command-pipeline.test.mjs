import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { issuePairingChallenge } from '../../../apps/kernel/dist/auth/pairing.js';
import { createCommandRunner } from '../../../apps/kernel/dist/commands/index.js';
import { lifecycleCommandServices, commandErrorStatus } from '../../../apps/kernel/dist/commands/lifecycle-services.js';
import { startLocalGateway } from '../../../apps/kernel/dist/http/local-gateway.js';
import { createProject, readProject } from '../../../packages/domain/dist/projects/index.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

function rawRequest(port, method, target, headers, body = null) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method, path: target, headers }, response => {
      const chunks = [];
      response.on('data', c => chunks.push(c));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8'), setCookie: response.headers['set-cookie'] ?? [] }));
    });
    request.on('error', reject);
    if (body !== null) request.write(body);
    request.end();
  });
}

async function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-command-pipeline-', () => { for (const s of stores) s.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const open = () => { const s = openStore(filename); stores.push(s); return s; };
  const store = open();
  createProject(store, { id: 'p1', name: 'synthetic', hostId: 'host', canonicalRoot: 'E:/synthetic/cmd', objective: '目标' }, 100);
  const runner = createCommandRunner(store, lifecycleCommandServices());
  const gateway = await startLocalGateway({ store, principalId: 'synthetic-local-user', commandRunner: runner, commandErrorStatus });
  t.after(() => { void gateway.close(); });
  const authority = `127.0.0.1:${gateway.port}`;
  const origin = `http://${authority}`;
  const challenge = issuePairingChallenge(store);
  const paired = await rawRequest(gateway.port, 'POST', '/api/v1/pairing', { Host: authority, Origin: origin, 'Content-Type': 'application/json' }, JSON.stringify({ schemaVersion: 2, requestId: 'pair', challengeId: challenge.challengeId, oneTimeCode: challenge.oneTimeCode }));
  const cookie = /projectorch_session=([^;]+)/.exec(paired.setCookie.find(c => c.startsWith('projectorch_session=')) ?? '')[1];
  const csrf = JSON.parse(paired.body).csrfToken;
  return { store, open, gateway, authority, origin, cookie, csrf };
}

const pauseBody = requestId => JSON.stringify({ schemaVersion: 2, requestId, projectId: 'p1', type: 'project.pause', payload: { reason: 'synthetic reason', currentWorkPolicy: 'finish' } });
const resumeBody = (requestId, expectedRevision) => JSON.stringify({ schemaVersion: 2, requestId, projectId: 'p1', type: 'project.resume', payload: { expectedRevision, reason: 'synthetic resume' } });
const post = (f, body, extra = {}) => rawRequest(f.gateway.port, 'POST', '/api/v1/commands', { Host: f.authority, Origin: f.origin, Cookie: `projectorch_session=${f.cookie}`, 'x-projectorch-csrf': f.csrf, 'Content-Type': 'application/json', ...extra }, body);

test('命令全链路：授权→幂等预留→域变更→事件→Outbox→回执；重放同回执', async t => {
  const f = await fixture(t);
  const paused = await post(f, pauseBody('req-1'));
  assert.equal(paused.status, 200);
  const receipt = JSON.parse(paused.body);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.requestId, 'req-1');
  assert.equal(receipt.entityIds[0].entityType, 'project');
  assert.equal(receipt.entityIds[0].revision, 2, 'create=1，pause=2');
  assert.equal(receipt.lastEventSequence, 1);
  assert.equal(readProject(f.store, 'p1').userPaused, true);
  assert.equal(f.store.db.prepare("SELECT state FROM commands WHERE request_id='req-1'").get().state, 'completed');
  assert.equal(f.store.db.prepare("SELECT type FROM events WHERE project_id='p1'").get().type, 'project.paused');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 1);
  const replay = await post(f, pauseBody('req-1'));
  assert.equal(replay.status, 200);
  assert.deepEqual(JSON.parse(replay.body), receipt, '幂等重放返回同一回执');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1, '重放不追加事件');
  const conflict = await post(f, JSON.stringify({ schemaVersion: 2, requestId: 'req-1', projectId: 'p1', type: 'project.pause', payload: { reason: 'different', currentWorkPolicy: 'request_stop' } }));
  assert.equal(conflict.status, 409);
});

test('恢复命令的乐观并发与状态机拒绝', async t => {
  const f = await fixture(t);
  assert.equal((await post(f, pauseBody('p-1'))).status, 200);
  const stale = await post(f, resumeBody('r-stale', 1));
  assert.equal(stale.status, 409);
  assert.match(stale.body, /REVISION_CONFLICT/);
  const again = await post(f, pauseBody('p-2'));
  assert.equal(again.status, 409, '重复暂停按状态机拒绝');
  assert.match(again.body, /ALREADY_PAUSED/);
  const resumed = await post(f, resumeBody('r-1', 2));
  assert.equal(resumed.status, 200);
  assert.equal(JSON.parse(resumed.body).entityIds[0].revision, 3);
  assert.equal(readProject(f.store, 'p1').userPaused, false);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 2);
});

test('传输防护与合同校验：未认证/缺CSRF/坏合同拒绝；重启后命令与事件持久', async t => {
  const f = await fixture(t);
  assert.equal((await post(f, pauseBody('x-1'), { Cookie: '' })).status, 401);
  assert.equal((await post(f, pauseBody('x-2'), { 'x-projectorch-csrf': '' })).status, 401);
  assert.equal((await post(f, JSON.stringify({ schemaVersion: 2, requestId: 'bad', projectId: 'p1', type: 'project.pause', payload: { reason: 'x' } }))).status, 400, '缺currentWorkPolicy违反合同');
  assert.equal((await post(f, JSON.stringify({ schemaVersion: 2, requestId: 'unknown', projectId: 'p1', type: 'message.send', payload: {} }))).status, 400, '未支持命令类型按合同/能力拒绝');
  const paused = await post(f, pauseBody('persist-1'));
  assert.equal(paused.status, 200);
  f.store.close();
  const reopened = f.open();
  assert.equal(reopened.db.prepare("SELECT state FROM commands WHERE request_id='persist-1'").get().state, 'completed');
  assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
  assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 1);
});

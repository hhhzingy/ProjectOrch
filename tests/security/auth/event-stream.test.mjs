import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { issuePairingChallenge } from '../../../apps/kernel/dist/auth/pairing.js';
import { createCommandRunner } from '../../../apps/kernel/dist/commands/index.js';
import { lifecycleCommandServices, commandErrorStatus } from '../../../apps/kernel/dist/commands/lifecycle-services.js';
import { startLocalGateway } from '../../../apps/kernel/dist/http/local-gateway.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

function pairAndAuth(f) {
  const challenge = issuePairingChallenge(f.store);
  return rawRequest(f.gateway.port, 'POST', '/api/v1/pairing', { Host: f.authority, Origin: f.origin, 'Content-Type': 'application/json' }, JSON.stringify({ schemaVersion: 2, requestId: 'pair', challengeId: challenge.challengeId, oneTimeCode: challenge.oneTimeCode })).then(paired => {
    const cookie = /projectorch_session=([^;]+)/.exec(paired.setCookie.find(c => c.startsWith('projectorch_session=')) ?? '')[1];
    return { cookie, csrf: JSON.parse(paired.body).csrfToken };
  });
}
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
/** 订阅SSE并等待出现匹配帧，或超时返回已有内容。 */
function awaitEvent(port, target, headers, pattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method: 'GET', path: target, headers }, response => {
      let body = '';
      response.on('data', c => {
        body += c;
        if (pattern.test(body)) { request.destroy(); resolve({ status: response.statusCode, body }); }
      });
      setTimeout(() => { request.destroy(); resolve({ status: response.statusCode, body, timeout: true }); }, timeoutMs).unref();
    });
    request.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
    request.end();
  });
}

async function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-event-stream-', () => { for (const s of stores) s.close(); });
  const store = openStore(path.join(dir, 'state.sqlite'));
  stores.push(store);
  createProject(store, { id: 'p1', name: 'synthetic', hostId: 'host', canonicalRoot: 'E:/synthetic/sse', objective: '目标' }, 100);
  const runner = createCommandRunner(store, lifecycleCommandServices());
  const gateway = await startLocalGateway({ store, principalId: 'synthetic-local-user', commandRunner: runner, commandErrorStatus });
  t.after(() => { void gateway.close(); });
  const authority = `127.0.0.1:${gateway.port}`;
  return { store, gateway, authority, origin: `http://${authority}` };
}
const pauseBody = requestId => JSON.stringify({ schemaVersion: 2, requestId, projectId: 'p1', type: 'project.pause', payload: { reason: 'sse test', currentWorkPolicy: 'finish' } });

test('SSE订阅：先回放历史事件，再实时收到新命令事件', async t => {
  const f = await fixture(t);
  const { cookie, csrf } = await pairAndAuth(f);
  const first = await rawRequest(f.gateway.port, 'POST', '/api/v1/commands', { Host: f.authority, Origin: f.origin, Cookie: `projectorch_session=${cookie}`, 'x-projectorch-csrf': csrf, 'Content-Type': 'application/json' }, pauseBody('sse-1'));
  assert.equal(first.status, 200);
  const replayed = await awaitEvent(f.gateway.port, '/api/v1/events?from=0', { Host: f.authority, Origin: f.origin, Cookie: `projectorch_session=${cookie}` }, /event: project\.paused/, 2000);
  assert.equal(replayed.status, 200);
  assert.match(replayed.body, /id: 1\nevent: project\.paused/);
  assert.match(replayed.body, /"causationId":"[0-9a-f-]{36}"/);
  assert.match(replayed.body, /"currentWorkPolicy":"finish"/);
  const second = await rawRequest(f.gateway.port, 'POST', '/api/v1/commands', { Host: f.authority, Origin: f.origin, Cookie: `projectorch_session=${cookie}`, 'x-projectorch-csrf': csrf, 'Content-Type': 'application/json' }, JSON.stringify({ schemaVersion: 2, requestId: 'sse-2', projectId: 'p1', type: 'project.resume', payload: { expectedRevision: 2, reason: 'resume' } }));
  assert.equal(second.status, 200);
  const pushed = await awaitEvent(f.gateway.port, '/api/v1/events', { Host: f.authority, Origin: f.origin, Cookie: `projectorch_session=${cookie}`, 'Last-Event-ID': '1' }, /id: 2\nevent: project\.resumed/, 3000);
  assert.match(pushed.body, /id: 2\nevent: project\.resumed/, 'Last-Event-ID游标续订只推送增量');
});

test('订阅范围与游标校验', async t => {
  const f = await fixture(t);
  const { cookie } = await pairAndAuth(f);
  assert.equal((await rawRequest(f.gateway.port, 'GET', '/api/v1/events?projectId=p-missing', { Host: f.authority, Origin: f.origin, Cookie: `projectorch_session=${cookie}` })).status, 404);
  assert.equal((await rawRequest(f.gateway.port, 'GET', '/api/v1/events?from=abc', { Host: f.authority, Origin: f.origin, Cookie: `projectorch_session=${cookie}` })).status, 403, '非法游标按网关拒绝');
});

test('ZR-05：会话撤销后已建立的SSE停止接收新事件；另一合法会话不受影响', async t => {
  const f = await fixture(t);
  // 两个独立会话
  const sessions = [];
  for (const requestId of ['sse-a', 'sse-b']) {
    const challenge = issuePairingChallenge(f.store);
    const paired = await rawRequest(f.gateway.port, 'POST', '/api/v1/pairing', { Host: f.authority, Origin: f.origin, 'Content-Type': 'application/json' }, JSON.stringify({ schemaVersion: 2, requestId, challengeId: challenge.challengeId, oneTimeCode: challenge.oneTimeCode }));
    sessions.push({ cookie: /projectorch_session=([^;]+)/.exec(paired.setCookie.find(c => c.startsWith('projectorch_session=')) ?? '')[1], csrf: JSON.parse(paired.body).csrfToken });
  }
  const [a, b] = sessions;
  // 先产生事件1
  await rawRequest(f.gateway.port, 'POST', '/api/v1/commands', { Host: f.authority, Origin: f.origin, Cookie: `projectorch_session=${a.cookie}`, 'x-projectorch-csrf': a.csrf, 'Content-Type': 'application/json' }, pauseBody('zr05-1'));
  // A 打开流（回放事件1）
  const collectedA = collectBody(f.gateway.port, '/api/v1/events', { Host: f.authority, Origin: f.origin, Cookie: `projectorch_session=${a.cookie}` }, 1600);
  await new Promise(r => setTimeout(r, 300));
  // 撤销A
  const revoked = await rawRequest(f.gateway.port, 'DELETE', '/api/v1/session', { Host: f.authority, Origin: f.origin, Cookie: `projectorch_session=${a.cookie}`, 'x-projectorch-csrf': a.csrf });
  assert.equal(revoked.status, 200);
  await new Promise(r => setTimeout(r, 200));
  // B 触发新事件
  const resumed = await rawRequest(f.gateway.port, 'POST', '/api/v1/commands', { Host: f.authority, Origin: f.origin, Cookie: `projectorch_session=${b.cookie}`, 'x-projectorch-csrf': b.csrf, 'Content-Type': 'application/json' }, JSON.stringify({ schemaVersion: 2, requestId: 'zr05-2', projectId: 'p1', type: 'project.resume', payload: { expectedRevision: 2, reason: 'zr05' } }));
  assert.equal(resumed.status, 200);
  const bodyA = await collectedA;
  assert.match(bodyA, /id: 1\nevent: project\.paused/, '撤销前已回放的事件仍在');
  assert.doesNotMatch(bodyA, /id: 2\nevent: project\.resumed/, '撤销后流不得收到新事件');
  // B 的新流正常收到两个事件（合法会话不被误断）
  const freshB = await awaitEvent(f.gateway.port, '/api/v1/events?from=0', { Host: f.authority, Origin: f.origin, Cookie: `projectorch_session=${b.cookie}` }, /id: 2\nevent: project\.resumed/, 3000);
  assert.match(freshB.body, /id: 1\nevent: project\.paused/);
});

/** 收集流正文固定时长后断开（不等待匹配）。 */
function collectBody(port, target, headers, durationMs) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method: 'GET', path: target, headers }, response => {
      let body = '';
      response.on('data', c => { body += c; });
      setTimeout(() => { request.destroy(); resolve(body); }, durationMs).unref();
    });
    request.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
    request.end();
  });
}

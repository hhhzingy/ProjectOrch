import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { issuePairingChallenge } from '../../../apps/kernel/dist/auth/pairing.js';
import { startLocalGateway } from '../../../apps/kernel/dist/http/local-gateway.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';
import { hostname } from 'node:os';

const pairingBody = challenge => JSON.stringify({ schemaVersion: 2, requestId: 'synthetic-gateway-pair', challengeId: challenge.challengeId, oneTimeCode: challenge.oneTimeCode });

test('浏览器同源无Origin读通过；跨站/同站/缺元数据与无Origin写仍拒绝；CSRF重领只限认证同源JSON', async t => {
  const { store, gateway, authority, origin } = await fixture(t);
  const paired = await rawRequest(gateway.port, 'POST', '/api/v1/pairing', { Host: authority, Origin: origin, 'Content-Type': 'application/json' }, pairingBody(issuePairingChallenge(store)));
  const cookie = paired.setCookie[0].split(';')[0]; const oldToken = JSON.parse(paired.body).csrfToken;
  const browser = { Host: authority, Cookie: cookie, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' };
  assert.equal((await rawRequest(gateway.port, 'GET', '/api/v1/session', browser)).status, 200);
  for (const altered of [
    { ...browser, 'Sec-Fetch-Site': 'cross-site' }, { ...browser, 'Sec-Fetch-Site': 'same-site' },
    { Host: authority, Cookie: cookie }, { ...browser, Origin: 'https://other.invalid' }, { ...browser, 'Sec-Fetch-Mode': 'navigate' },
  ]) assert.equal((await rawRequest(gateway.port, 'GET', '/api/v1/session', altered)).status, 403);
  assert.equal((await rawRequest(gateway.port, 'DELETE', '/api/v1/session', { ...browser, 'x-projectorch-csrf': oldToken })).status, 403);
  assert.equal((await rawRequest(gateway.port, 'POST', '/api/v1/session/csrf', { ...browser, 'Content-Type': 'application/json' }, '{}')).status, 403);
  const renewed = await rawRequest(gateway.port, 'POST', '/api/v1/session/csrf', { Host: authority, Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, '{}');
  assert.equal(renewed.status, 200); const token = JSON.parse(renewed.body).csrfToken;
  assert.notEqual(token, oldToken);
  assert.equal((await rawRequest(gateway.port, 'DELETE', '/api/v1/session', { Host: authority, Origin: origin, Cookie: cookie, 'x-projectorch-csrf': oldToken })).status, 401);
  assert.equal((await rawRequest(gateway.port, 'DELETE', '/api/v1/session', { Host: authority, Origin: origin, Cookie: cookie, 'x-projectorch-csrf': token })).status, 200);
});

test('用户项目创建：幂等回执/策略/事件同事务；错主机、缺CSRF、根目录冲突与失败回滚', async t => {
  const { store, gateway, authority, origin } = await fixture(t);
  const paired = await rawRequest(gateway.port, 'POST', '/api/v1/pairing', { Host: authority, Origin: origin, 'Content-Type': 'application/json' }, pairingBody(issuePairingChallenge(store)));
  const headers = { Host: authority, Origin: origin, Cookie: paired.setCookie[0].split(';')[0], 'Content-Type': 'application/json', 'x-projectorch-csrf': JSON.parse(paired.body).csrfToken };
  const policy = { id: 'manual', revision: 0, profiles: [{ id: 'reader', revision: 0, actions: ['project.read'], readPaths: [], writePaths: [], roleIds: [], delegableActions: [], maxDelegationDepth: 0 }], limits: { totalConcurrency: 1, roleConcurrency: 1, maxAttempts: 2, maxCorrectionTurns: 0, maxManagementRounds: 1, maxDynamicRoles: 0, wallTimeMs: 1000, costCeiling: null, costEnforcement: 'unavailable' }, nativeMode: 'disabled', writeIsolation: 'exclusive_workspace' };
  const input = { schemaVersion: 2, requestId: 'new-project', hostId: hostname(), name: '合成项目', rootPath: 'E:/synthetic/new-gateway-project', objective: '只测试元数据', initialPolicy: policy };
  const post = (body, h = headers) => rawRequest(gateway.port, 'POST', '/api/v1/projects', h, JSON.stringify(body));
  assert.equal((await post(input, { ...headers, 'x-projectorch-csrf': 'wrong' })).status, 401);
  assert.equal((await post({ ...input, hostId: 'other-host' })).status, 400);
  store.db.exec("CREATE TRIGGER synthetic_project_create_failure BEFORE INSERT ON global_requests BEGIN SELECT RAISE(ABORT,'SYNTHETIC_CREATE_FAILURE'); END");
  assert.equal((await post(input)).status, 400);
  for (const table of ['projects', 'commands', 'events', 'policy_revisions', 'global_requests']) assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  store.db.exec('DROP TRIGGER synthetic_project_create_failure');
  const created = await post(input); assert.equal(created.status, 200);
  const receipt = JSON.parse(created.body);
  assert.equal(receipt.entityIds[0].entityType, 'project');
  assert.deepEqual(JSON.parse((await post(input)).body), receipt);
  assert.equal((await post({ ...input, objective: '不同请求内容' })).status, 409);
  assert.equal((await post({ ...input, requestId: 'duplicate-root' })).status, 409);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 1);
  const row = store.db.prepare('SELECT policy_json FROM projects WHERE id=?').get(receipt.projectId);
  assert.equal(JSON.parse(row.policy_json).nativeMode, 'disabled');
  const { api } = await import('../../../apps/web/dist/api.js');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, init = {}) => originalFetch(origin + url, { ...init, headers: { ...init.headers, Origin: origin, Cookie: headers.Cookie } });
  try {
    await api.refreshCsrf();
    // 模拟另一标签页刷新，旧内存令牌随即失效。
    assert.equal((await rawRequest(gateway.port, 'POST', '/api/v1/session/csrf', headers, '{}')).status, 200);
    const second = await api.createProject({ ...input, requestId: 'second-tab-retry', rootPath: 'E:/synthetic/second-tab-root' });
    assert.ok(second.projectId);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 2, '重领后同一幂等请求只创建一次');
  } finally { globalThis.fetch = originalFetch; }
});

function rawRequest(port, method, target, headers, body = null) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method, path: target, headers }, response => {
      const chunks = [];
      response.on('data', c => chunks.push(c));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8'), setCookie: response.headers['set-cookie'] ?? [] }));
    });
    request.on('error', reject);
    if (body !== null) request.write(body);
    request.end();
  });
}

/** 收集SSE流一段时间后主动断开；用于长连接断言。 */
function collectStream(port, target, headers, durationMs) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method: 'GET', path: target, headers }, response => {
      const chunks = [];
      response.on('data', c => chunks.push(c));
      const timer = setTimeout(() => { clearTimeout(timer); request.destroy(); resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }); }, durationMs);
    });
    request.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
    request.end();
  });
}

async function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-gateway-', () => { for (const s of stores) s.close(); });
  const store = openStore(path.join(dir, 'state.sqlite'));
  stores.push(store);
  const gateway = await startLocalGateway({ store, principalId: 'synthetic-local-user' });
  t.after(() => { void gateway.close(); });
  const authority = `127.0.0.1:${gateway.port}`;
  const origin = `http://${authority}`;
  return { store, gateway, authority, origin };
}

test('完整配对流程：正确来源建立会话，读写与事件按模式防护', async t => {
  const { store, gateway, authority, origin } = await fixture(t);
  const challenge = issuePairingChallenge(store);
  const paired = await rawRequest(gateway.port, 'POST', '/api/v1/pairing', { Host: authority, Origin: origin, 'Content-Type': 'application/json' }, pairingBody(challenge));
  assert.equal(paired.status, 200);
  assert.ok(paired.setCookie.some(c => c.startsWith('projectorch_session=') && c.includes('HttpOnly') && c.includes('SameSite=Strict')));
  const cookie = /projectorch_session=([^;]+)/.exec(paired.setCookie.find(c => c.startsWith('projectorch_session=')) ?? '')[1];
  const csrf = JSON.parse(paired.body).csrfToken;
  const read = await rawRequest(gateway.port, 'GET', '/api/v1/session', { Host: authority, Origin: origin, Cookie: `projectorch_session=${cookie}` });
  assert.equal(read.status, 200);
  assert.equal(JSON.parse(read.body).principalId, 'synthetic-local-user');
  const noCsrf = await rawRequest(gateway.port, 'DELETE', '/api/v1/session', { Host: authority, Origin: origin, Cookie: `projectorch_session=${cookie}` });
  assert.equal(noCsrf.status, 401);
  const revoked = await rawRequest(gateway.port, 'DELETE', '/api/v1/session', { Host: authority, Origin: origin, Cookie: `projectorch_session=${cookie}`, 'x-projectorch-csrf': csrf });
  assert.equal(revoked.status, 200);
  assert.equal((await rawRequest(gateway.port, 'GET', '/api/v1/session', { Host: authority, Origin: origin, Cookie: `projectorch_session=${cookie}` })).status, 401);
});

test('SSE路由：事件模式凭据与来源核验', async t => {
  const { store, gateway, authority, origin } = await fixture(t);
  const challenge = issuePairingChallenge(store);
  const paired = await rawRequest(gateway.port, 'POST', '/api/v1/pairing', { Host: authority, Origin: origin, 'Content-Type': 'application/json' }, pairingBody(challenge));
  const cookie = /projectorch_session=([^;]+)/.exec(paired.setCookie.find(c => c.startsWith('projectorch_session=')) ?? '')[1];
  const events = await collectStream(gateway.port, '/api/v1/events', { Host: authority, Origin: origin, Cookie: `projectorch_session=${cookie}` }, 400);
  assert.equal(events.status, 200);
  assert.match(events.headers['content-type'], /text\/event-stream/);
  assert.match(events.body, /^retry: 3000\n\n/, '流保持打开并给出重连提示');
  assert.equal((await rawRequest(gateway.port, 'GET', '/api/v1/events', { Host: authority, Origin: origin })).status, 401);
  assert.equal((await rawRequest(gateway.port, 'GET', '/api/v1/events', { Host: authority, Origin: 'http://127.0.0.1:1', Cookie: `projectorch_session=${cookie}` })).status, 403);
});

test('未认证、非法来源、伪造Host与重复凭据头拒绝', async t => {
  const { store, gateway, authority, origin } = await fixture(t);
  const challenge = issuePairingChallenge(store);
  const paired = await rawRequest(gateway.port, 'POST', '/api/v1/pairing', { Host: authority, Origin: origin, 'Content-Type': 'application/json' }, pairingBody(challenge));
  const cookie = /projectorch_session=([^;]+)/.exec(paired.setCookie.find(c => c.startsWith('projectorch_session=')) ?? '')[1];
  assert.equal((await rawRequest(gateway.port, 'GET', '/api/v1/session', { Host: authority, Origin: origin })).status, 401);
  assert.equal((await rawRequest(gateway.port, 'GET', '/api/v1/session', { Host: authority, Origin: 'http://evil.example', Cookie: `projectorch_session=${cookie}` })).status, 403);
  assert.equal((await rawRequest(gateway.port, 'GET', '/api/v1/session', { Host: 'evil.example:8080', Origin: origin, Cookie: `projectorch_session=${cookie}` })).status, 403);
  const duplicated = await rawRequest(gateway.port, 'GET', '/api/v1/session', ['Host', authority, 'Origin', origin, 'Cookie', `projectorch_session=${cookie}`, 'Cookie', `projectorch_session=${cookie}`]);
  assert.equal(duplicated.status, 400);
  assert.equal((await rawRequest(gateway.port, 'GET', '/api/v1/unknown', { Host: authority, Origin: origin, Cookie: `projectorch_session=${cookie}` })).status, 404);
});

test('配对失败路径：错码、第三方Origin、伪造Host与超限正文', async t => {
  const { store, gateway, authority, origin } = await fixture(t);
  const challenge = issuePairingChallenge(store);
  const wrong = await rawRequest(gateway.port, 'POST', '/api/v1/pairing', { Host: authority, Origin: origin, 'Content-Type': 'application/json' }, JSON.stringify({ schemaVersion: 2, requestId: 'synthetic-gateway-pair', challengeId: challenge.challengeId, oneTimeCode: 'wrong' }));
  assert.equal(wrong.status, 403);
  assert.equal((await rawRequest(gateway.port, 'POST', '/api/v1/pairing', { Host: authority, Origin: 'http://evil.example', 'Content-Type': 'application/json' }, pairingBody(challenge))).status, 403);
  assert.equal((await rawRequest(gateway.port, 'POST', '/api/v1/pairing', { Host: 'evil.example', Origin: origin, 'Content-Type': 'application/json' }, pairingBody(challenge))).status, 403);
  const retry = await rawRequest(gateway.port, 'POST', '/api/v1/pairing', { Host: authority, Origin: origin, 'Content-Type': 'application/json' }, pairingBody(challenge));
  assert.equal(retry.status, 200, '错码只消耗失败次数，正确码仍可消费同一挑战');
  const oversized = 'x'.repeat(9000);
  assert.equal((await rawRequest(gateway.port, 'POST', '/api/v1/pairing', { Host: authority, Origin: origin, 'Content-Type': 'application/json' }, oversized)).status, 413);
});

/** T120/T121（PR2-W4）：监督总览+角色配置轻操作端点。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { createRole, setRoleModelPreference } from '../../../packages/domain/dist/roles/index.js';
import { bootstrapRole } from '../../../packages/domain/dist/bootstrap/index.js';
import { issuePairingChallenge } from '../../../apps/kernel/dist/auth/pairing.js';
import { startKernel } from '../../../apps/kernel/dist/lifecycle/kernel-runtime.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

function request(port, method, target, headers, body = null) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path: target, headers }, response => {
      const chunks = [];
      response.on('data', c => chunks.push(c));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8'), setCookie: response.headers['set-cookie'] ?? [] }));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

test('T120：overview总览——角色/harness/模型请求与解析/当前任务/等待原因/下一动作/runState', async t => {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-t120-', () => { for (const s of stores.splice(0)) { try { s.close(); } catch { /* 已关 */ } } });
  const filename = path.join(dir, 'state.sqlite');
  const seed = openStore(filename); stores.push(seed);
  createProject(seed, { id: 'p1', name: '监督演示', hostId: 'h', canonicalRoot: dir, objective: 'o' }, 100);
  bootstrapRole(seed, { projectId: 'p1', localRef: 'r-exec', name: '执行者', charter: 'c', permissionProfileId: 'x', permissionProfileRevision: 1, expectedPolicyRevision: 0, principalId: 'user-1', requestId: 'b0' }, 110);
  setRoleModelPreference(seed, 'p1', 'r-exec', { raw: 'zcode 5.3flash 最高推理', recordedAt: 1000 }, { modelId: 'GLM-5.3-Flash', reasoningLevel: 'max', basis: '用户指定', resolvedAt: 2000 });
  seed.close();
  const runtime = await startKernel({ filename, principalId: 'user-1' });
  stores.push(runtime.store);
  const authority = `127.0.0.1:${runtime.gateway.port}`;
  const challenge = issuePairingChallenge(runtime.store);
  const paired = await request(runtime.gateway.port, 'POST', '/api/v1/pairing', { Host: authority, Origin: `http://${authority}`, 'Content-Type': 'application/json' }, JSON.stringify({ schemaVersion: 2, requestId: 'p', challengeId: challenge.challengeId, oneTimeCode: challenge.oneTimeCode }));
  const cookie = `projectorch_session=${/projectorch_session=([^;]+)/.exec(paired.setCookie.find(c => c.startsWith('projectorch_session=')) ?? '')[1]}`;
  // 未认证401
  const anon = await request(runtime.gateway.port, 'GET', '/api/v1/overview', { Host: authority });
  assert.ok([401, 403].includes(anon.status), '未认证拒绝');
  // 总览
  const overview = await request(runtime.gateway.port, 'GET', '/api/v1/overview', { Host: authority, Origin: `http://${authority}`, Cookie: cookie });
  assert.equal(overview.status, 200);
  const body = JSON.parse(overview.body);
  assert.ok(Array.isArray(body.projects));
  const p = body.projects.find(x => x.projectId === 'p1');
  assert.ok(p, '项目在列');
  assert.equal(p.runState, 'idle', '无在途→idle');
  const role = p.roles.find(r => r.roleId === 'r-exec');
  assert.ok(role, '角色在列');
  assert.equal(role.modelRequested.raw, 'zcode 5.3flash 最高推理', '请求模型原文');
  assert.equal(role.modelResolved.modelId, 'GLM-5.3-Flash', '解析模型');
  assert.equal(role.currentTask, null, '无当前任务');
  assert.ok(typeof role.nextAction === 'string', '下一动作可见');
  // T121：模型偏好端点
  const pref = await request(runtime.gateway.port, 'GET', '/api/v1/projects/p1/roles/r-exec/model-preference', { Host: authority, Origin: `http://${authority}`, Cookie: cookie });
  assert.equal(pref.status, 200);
  const prefBody = JSON.parse(pref.body);
  assert.equal(prefBody.requested.raw, 'zcode 5.3flash 最高推理');
  assert.equal(prefBody.resolved.reasoningLevel, 'max');
  // 缺失角色404
  const missing = await request(runtime.gateway.port, 'GET', '/api/v1/projects/p1/roles/none/model-preference', { Host: authority, Origin: `http://${authority}`, Cookie: cookie });
  assert.equal(missing.status, 404);
  // 只读无副作用：overview不产生事件
  const events = runtime.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE project_id='p1' AND type LIKE 'overview%'").get().n;
  assert.equal(events, 0, '只读');
  await runtime.stop();
});

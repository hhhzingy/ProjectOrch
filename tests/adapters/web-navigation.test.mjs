/** A060：项目角色导航与控制（e2e）。真实网关+静态服务+前端编译产物；
 * 前端逻辑经最小DOM垫片驱动（纯函数状态断言）；切换/恢复/分桶不串态/停用历史可查/期望观测分列。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { openStore } from '../../packages/persistence/dist/index.js';
import { createProject } from '../../packages/domain/dist/projects/index.js';
import { createRole } from '../../packages/domain/dist/roles/index.js';
import { issuePairingChallenge } from '../../apps/kernel/dist/auth/pairing.js';
import { startKernel } from '../../apps/kernel/dist/lifecycle/kernel-runtime.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';

const WEB_DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'apps', 'web', 'dist');

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

/** 最小DOM垫片：仅覆盖console.ts使用的表面。 */
function makeElement(tag) {
  return { tagName: tag.toUpperCase(), children: [], className: '', textContent: '', type: '', ownerDocument: null,
    addEventListener() {}, append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; }, appendChild(node) { this.children.push(node); return node; } };
}
function makeStorage() {
  const map = new Map();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value); } };
}

test('A060：三栏导航e2e——切换/恢复/不串态/停用历史可查/期望观测分列', async t => {
  let runtime;
  t.after(async () => { await runtime?.stop(); });
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-a060-', () => { for (const close of stores.splice(0)) { try { close(); } catch { /* 已关闭 */ } } });
  const filename = path.join(dir, 'state.sqlite');
  const seed = openStore(filename);
  stores.push(seed);
  createProject(seed, { id: 'p-alpha', name: 'Alpha', hostId: 'h', canonicalRoot: 'E:/synthetic/a060/alpha', objective: 'A目标' }, 100);
  createProject(seed, { id: 'p-beta', name: 'Beta', hostId: 'h', canonicalRoot: 'E:/synthetic/a060/beta', objective: 'B目标' }, 101);
  createRole(seed, { id: 'r-live', projectId: 'p-alpha', name: '在岗角色', charter: 'c', permissionProfileId: 'worker' }, 110);
  createRole(seed, { id: 'r-gone', projectId: 'p-alpha', name: '停用角色', charter: 'c', permissionProfileId: 'worker' }, 111);
  seed.db.prepare("UPDATE roles SET desired_state='disabled' WHERE id='r-gone'").run();
  seed.transaction(db => db.prepare("INSERT INTO role_revisions(role_id,project_id,revision,snapshot_json) VALUES('r-gone','p-alpha',2,?)").run(JSON.stringify({ desiredState: 'disabled', bindingState: 'unbound' })));
  createRole(seed, { id: 'r-beta', projectId: 'p-beta', name: 'Beta角色', charter: 'c', permissionProfileId: 'worker' }, 112);
  seed.close();

  assert.ok(fs.existsSync(path.join(WEB_DIST, 'main.js')), '前端编译产物存在');
  runtime = await startKernel({ filename, principalId: 'user-1', webDistDir: WEB_DIST });
  stores.push(runtime.store);
  const authority = `127.0.0.1:${runtime.gateway.port}`;
  const headers = { Host: authority, Origin: `http://${authority}` };
  // 静态服务：三栏布局可达
  const index = await request(runtime.gateway.port, 'GET', '/', { Host: authority });
  assert.equal(index.status, 200);
  assert.match(index.body, /id="project-list"/);
  assert.match(index.body, /id="role-detail"/);
  // 未认证读拒绝（会话鉴权）
  const anon = await request(runtime.gateway.port, 'GET', '/api/v1/projects', { Host: authority });
  assert.ok([401, 403].includes(anon.status), '未认证读拒绝（来源或会话）');
  // 配对
  const challenge = issuePairingChallenge(runtime.store);
  const paired = await request(runtime.gateway.port, 'POST', '/api/v1/pairing', { ...headers, 'Content-Type': 'application/json' }, JSON.stringify({ schemaVersion: 2, requestId: 'pair', challengeId: challenge.challengeId, oneTimeCode: challenge.oneTimeCode }));
  assert.equal(paired.status, 200);
  const cookie = `projectorch_session=${/projectorch_session=([^;]+)/.exec(paired.setCookie.find(c => c.startsWith('projectorch_session=')) ?? '')[1]}`;
  const authed = { ...headers, Cookie: cookie };

  // 项目清单：多项目并列
  const projectsResponse = await request(runtime.gateway.port, 'GET', '/api/v1/projects', authed);
  assert.equal(projectsResponse.status, 200);
  const projects = JSON.parse(projectsResponse.body).projects;
  assert.deepEqual(projects.map(p => p.projectId).sort(), ['p-alpha', 'p-beta'], '多项目并列');
  // 项目角色：期望/观测分列返回、停用角色保留在列
  const alphaRoles = JSON.parse((await request(runtime.gateway.port, 'GET', '/api/v1/projects/p-alpha/roles', authed)).body).roles;
  assert.deepEqual(alphaRoles.map(r => r.roleId).sort(), ['r-gone', 'r-live'], '停用角色保留在列');
  const gone = alphaRoles.find(r => r.roleId === 'r-gone');
  assert.equal(gone.desiredState, 'disabled');
  assert.equal(gone.bindingState, 'unbound', '期望与观测分开返回');
  const historyResponse = await request(runtime.gateway.port, 'GET', '/api/v1/projects/p-alpha/roles/r-gone/history', authed);
  const historyRows = JSON.parse(historyResponse.body).history;
  assert.ok(historyRows.length >= 1, '停用历史可查');
  assert.match(JSON.stringify(historyRows), /disabled/);

  // ── 前端编译产物经DOM垫片驱动（fetch注入网关基址+Cookie）──
  const consoleModule = await import('../../apps/web/dist/layout/console.js');
  const projectsModule = await import('../../apps/web/dist/projects/projects.js');
  const rolesModule = await import('../../apps/web/dist/roles/roles.js');
  const makeEl = tag => { const el = makeElement(tag); el.ownerDocument = { createElement: makeEl }; return el; };
  const storage = makeStorage();
  const dom = { storage, projectList: makeEl('div'), roleList: makeEl('div'), roleDetail: makeEl('div'), connectionStatus: makeEl('span'), scopeHeading: makeEl('h2') };
  const env = { storage, document: { createElement: makeEl }, location: { href: `http://${authority}/` } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const url = typeof input === 'string' && input.startsWith('/') ? `http://127.0.0.1:${runtime.gateway.port}${input}` : input;
    return originalFetch(url, { ...init, headers: { ...(init?.headers ?? {}), Origin: `http://127.0.0.1:${runtime.gateway.port}`, Cookie: cookie } });
  });
  try {
    await consoleModule.mountConsole(dom, env);
    assert.match(dom.connectionStatus.textContent, /已连接/, '连接状态文本（非仅颜色）');
    assert.match(dom.scopeHeading.textContent, /Alpha/, '作用域标题随项目切换');
    // 切换到p-beta：换桶不串态
    const state1 = projectsModule.withProjects(projectsModule.initialState(storage), projects, storage);
    assert.equal(state1.selection.projectId, 'p-alpha', '初始选择回退首项目');
    const state2 = projectsModule.selectProject(state1, 'p-beta', storage);
    assert.equal(state2.selection.roleId, null, '切换项目清空角色选择');
    const state3 = projectsModule.withRoles(state2, 'p-beta', [{ roleId: 'r-beta', name: 'Beta角色', desiredState: 'enabled', bindingState: 'ready' }]);
    assert.equal(state3.rolesByProject['p-beta'].length, 1);
    assert.equal(state3.rolesByProject['p-alpha'], undefined, '未加载的项目桶无数据（不串态）');
    // 角色选择+刷新恢复
    projectsModule.selectRole(state3, 'r-beta', storage);
    const restored = projectsModule.initialState(storage);
    assert.deepEqual(restored.selection, { projectId: 'p-beta', roleId: 'r-beta' }, '刷新恢复选择');
    // 期望/观测分列（文本+符号，非仅颜色）
    const rows = rolesModule.roleDisplayRows([{ roleId: 'r-gone', name: '停用角色', desiredState: 'disabled', bindingState: 'unbound' }]);
    assert.match(rows[0].desiredText, /停用/);
    assert.match(rows[0].observedText, /未绑定/);
    assert.ok(rows[0].glyph.length >= 1);
    const historyView = rolesModule.historyDisplayRows(historyRows);
    assert.match(historyView[0].text, /期望=/);
    assert.match(historyView[0].text, /观测=/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

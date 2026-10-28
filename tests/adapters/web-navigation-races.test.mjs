import test from 'node:test';
import assert from 'node:assert/strict';
import { mountConsole } from '../../apps/web/dist/layout/console.js';

test('重新挂载控制台后，旧控制器迟到的项目列表不能覆盖新页面', async () => {
  const storage = { getItem: () => null, setItem: () => {} };
  const document = { createElement: tag => ({ tagName: tag, textContent: '', children: [], ownerDocument: document, addEventListener() {}, append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; } }) };
  const el = () => document.createElement('div');
  const dom = { storage, projectList: el(), roleList: el(), roleDetail: el(), connectionStatus: el(), scopeHeading: el() };
  let resolveOld; let oldRequested;
  const requested = new Promise(resolve => { oldRequested = resolve; });
  const oldProjects = new Promise(resolve => { resolveOld = resolve; });
  let lists = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    let data;
    if (url === '/api/v1/session') data = { principalId: 'test' };
    else if (url === '/api/v1/projects') { if (++lists === 1) { oldRequested(); data = await oldProjects; } else data = { projects: [{ projectId: 'new', name: '新版项目', userPaused: false }] }; }
    else if (url === '/api/v1/projects/new/roles') data = { roles: [] };
    else throw new Error('UNEXPECTED_ROUTE');
    return { ok: true, status: 200, json: async () => data };
  };
  try {
    const old = mountConsole(dom, { storage, document, location: {} });
    await requested;
    await mountConsole(dom, { storage, document, location: {} });
    resolveOld({ projects: [{ projectId: 'old', name: '过期项目', userPaused: false }] }); await old;
    assert.match(dom.projectList.children[0].textContent, /新版项目/);
    assert.match(dom.scopeHeading.textContent, /新版项目/);
  } finally { globalThis.fetch = original; }
});

test('导航实际填充角色；迟到项目及历史响应不能覆盖当前选择', async () => {
  const map = new Map();
  const storage = { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
  const document = { createElement: tag => ({ tagName: tag, textContent: '', children: [], listeners: {}, ownerDocument: document, addEventListener(name, action) { this.listeners[name] = action; }, append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; } }) };
  const el = () => document.createElement('div');
  const dom = { storage, projectList: el(), roleList: el(), roleDetail: el(), connectionStatus: el(), scopeHeading: el() };
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const role = name => ({ roleId: name, name, desiredState: 'enabled', bindingState: 'ready' });
  let resolveB; let resolveHistory; let bCalls = 0;
  const delayedB = new Promise(resolve => { resolveB = resolve; });
  const delayedHistory = new Promise(resolve => { resolveHistory = resolve; });
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    const p = String(url);
    let data;
    if (p === '/api/v1/session') data = { principalId: 'synthetic' };
    else if (p === '/api/v1/projects') data = { projects: [{ projectId: 'a', name: '甲', userPaused: false }, { projectId: 'b', name: '乙', userPaused: false }] };
    else if (p.endsWith('/history')) data = await delayedHistory;
    else if (p === '/api/v1/projects/a/roles') data = { roles: [role('甲角色')] };
    else if (p === '/api/v1/projects/b/roles') data = ++bCalls === 1 ? await delayedB : { roles: [role('乙角色')] };
    else throw new Error('UNEXPECTED_SYNTHETIC_ROUTE');
    return { ok: true, status: 200, json: async () => data };
  };
  try {
    await mountConsole(dom, { storage, document, location: { href: 'http://synthetic.invalid/' } });
    assert.match(dom.roleList.children[0].textContent, /甲角色/, '状态必须回写控制器，不能只更新函数局部变量');
    dom.projectList.children.find(n => n.textContent === '乙').listeners.click(); await tick();
    dom.projectList.children.find(n => n.textContent === '甲').listeners.click(); await tick();
    resolveB({ roles: [role('迟到乙角色')] }); await tick();
    assert.match(dom.scopeHeading.textContent, /甲/); assert.match(dom.roleList.children[0].textContent, /甲角色/);
    dom.roleList.children[0].listeners.click(); await tick();
    dom.projectList.children.find(n => n.textContent === '乙').listeners.click(); await tick();
    resolveHistory({ history: [{ revision: 1, snapshot: { desiredState: 'enabled', bindingState: 'ready' } }] }); await tick();
    assert.match(dom.scopeHeading.textContent, /乙/); assert.match(dom.roleList.children[0].textContent, /乙角色/);
    assert.equal(dom.roleDetail.children.length, 0, '旧角色历史不能渲染到新项目');
  } finally { globalThis.fetch = original; }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { startLocalGateway } from '../../../apps/kernel/dist/http/local-gateway.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

async function fixture(t, files = {}) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-static-', () => { for (const s of stores) s.close(); });
  const webDist = path.join(dir, 'web-dist'); fs.mkdirSync(webDist);
  fs.writeFileSync(path.join(webDist, 'index.html'), '<!doctype html><html lang="zh-CN"><title>ProjectOrch</title></html>');
  fs.writeFileSync(path.join(webDist, 'app.js'), 'export const boot = true;\n');
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(webDist, name), content);
  const store = openStore(path.join(dir, 'state.sqlite'));
  stores.push(store);
  const gateway = await startLocalGateway({ store, principalId: 'synthetic-local-user', webDistDir: webDist });
  t.after(() => { void gateway.close(); });
  return { gateway, authority: `127.0.0.1:${gateway.port}`, origin: `http://127.0.0.1:${gateway.port}` };
}
function get(port, target, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path: target, headers }, response => {
      const chunks = [];
      response.on('data', c => chunks.push(c));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('静态登录面：未认证可达、Content-Type正确、Host校验、穿越与特殊路径404', async t => {
  const f = await fixture(t);
  const index = await get(f.gateway.port, '/');
  assert.equal(index.status, 200);
  assert.match(index.headers['content-type'], /text\/html/);
  assert.match(index.body, /ProjectOrch/);
  const script = await get(f.gateway.port, '/app.js', { Host: f.authority });
  assert.equal(script.status, 200);
  assert.match(script.headers['content-type'], /text\/javascript/);
  assert.equal(script.body, 'export const boot = true;\n');
  // 无Host（非法）
  assert.equal((await get(f.gateway.port, '/', { Host: 'evil.example' })).status, 403);
  // 穿越与别名形态一律404不泄露存在性（点段由URL构造器先行规范化到根内，无法逃逸）
  for (const evil of ['/../state.sqlite', '/app.js%00', '/..%2fstate.sqlite', '/.git/config', '/node-repl-host.js']) {
    const response = await get(f.gateway.port, evil, { Host: f.authority });
    assert.equal(response.status, 404, evil);
  }
  const normalized = await get(f.gateway.port, '/sub/../app.js', { Host: f.authority });
  assert.equal(normalized.body, 'export const boot = true;\n', '点段规范化后仅命中同源合法文件');
  assert.equal((await get(f.gateway.port, '/missing.js', { Host: f.authority })).status, 404);
  assert.equal((await get(f.gateway.port, '/index.html', { Host: f.authority })).status, 200);
});

test('junction逃逸与API路由不受静态服务影响', async t => {
  // 含junction的目录在Windows上删除常遇EPERM；留在系统临时目录由其自清理，保证测试确定性。
  const dir = fs.mkdtempSync(path.join(os_tmp(), 'projectorch-static-junction-'));
  const stores = [];
  const dbDir = fs.mkdtempSync(path.join(dir, 'db-'));
  const store = openStore(path.join(dbDir, 'state.sqlite'));
  t.after(() => { try { store.close(); } catch { /* 已关闭 */ } });
  const webDist = path.join(dir, 'web-dist'); fs.mkdirSync(webDist);
  fs.writeFileSync(path.join(webDist, 'index.html'), '<html></html>');
  const secret = path.join(dir, 'secret'); fs.mkdirSync(secret);
  fs.writeFileSync(path.join(secret, 'secret.txt'), 'outside');
  const gateway = await startLocalGateway({ store, principalId: 'u', webDistDir: webDist });
  t.after(() => { void gateway.close(); });
  const authority = `127.0.0.1:${gateway.port}`;
  if (process.platform === 'win32') {
    try { fs.symlinkSync(secret, path.join(webDist, 'link'), 'junction'); } catch { /* 受限环境跳过 */ }
    if (fs.existsSync(path.join(webDist, 'link'))) {
      assert.equal((await get(gateway.port, '/link/secret.txt', { Host: authority })).status, 404, 'junction逃逸拒绝');
    }
  }
  // API路由优先于静态：未认证API仍401而非静态兜底
  assert.equal((await get(gateway.port, '/api/v1/session', { Host: authority, Origin: `http://${authority}` })).status, 401);
  assert.equal((await get(gateway.port, '/api/v1/missing', { Host: authority, Origin: `http://${authority}` })).status, 401, '未认证先于路由解析，不泄露API存在性');
});
function os_tmp() { return process.env.TEMP ?? '/tmp'; }

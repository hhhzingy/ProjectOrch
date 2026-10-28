import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalRoot, assertCanonicalRootCurrent, createProject } from '../../packages/domain/dist/projects/index.js';
import { openStore } from '../../packages/persistence/dist/index.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';

test('canonicalRoot 卷根、点段、大小写与等价写法收敛到同一身份（ZR-06）', () => {
  assert.equal(canonicalRoot('C:/'), 'C:\\', '卷根保留卷根语义');
  assert.equal(canonicalRoot('c:\\'), 'C:\\', '盘符大小写统一');
  const upper = canonicalRoot('C:/review/root');
  assert.equal(canonicalRoot('c:/review/root/.'), upper, '点段与大小写等价写法收敛');
  assert.equal(canonicalRoot('c:\\review\\root\\'), upper, '斜杠方向等价');
  assert.equal(canonicalRoot('C:/review/root/../root'), upper, '词法可解析的同目录穿越收敛');
  for (const evil of ['C:/x/../../..', '\\\\?\\C:\\x', 'relative/path', 'C:relative', 'C:', 'C:/x?', 'C:/x*']) {
    assert.throws(() => canonicalRoot(evil), /INVALID_PROJECT_ROOT/, evil);
  }
});

test('真实目录身份：大小写不敏感写入、realpath真实大小写与重解析点（ZR-06）', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'projectorch-canonical-real-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const inner = path.join(base, 'ReviewRoot');
  fs.mkdirSync(inner);
  // 用不同大小写访问同一目录，身份必须一致（NTFS不区分大小写，realpath返回真实大小写）
  const mixed = path.join(base, 'rEvIeWrOoT');
  assert.equal(canonicalRoot(mixed), canonicalRoot(inner), '大小写变体收敛到真实大小写身份');
  assert.equal(fs.existsSync(canonicalRoot(mixed).replaceAll('\\', path.sep)), true);
  assertCanonicalRootCurrent(canonicalRoot(inner), mixed);
  // junction：指向同一目标的junction与目标收敛为同一身份
  if (process.platform === 'win32') {
    const link = path.join(base, 'junction-link');
    try { fs.symlinkSync(inner, link, 'junction'); } catch { t.skip('junction创建受限'); return; }
    assert.equal(canonicalRoot(link), canonicalRoot(inner), 'junction解析到真实目标身份');
  }
  // 不存在目录：词法规范化仍可用（首次绑定前）
  assert.equal(canonicalRoot('E:/nonexistent-proj/root'), 'E:\\nonexistent-proj\\root');
});

test('重复绑定防线：同一目录等价写法被UNIQUE约束拒绝（ZR-06）', t => {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-canonical-db-', () => { for (const s of stores) s.close(); });
  const store = openStore(path.join(dir, 'state.sqlite'));
  stores.push(store);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'projectorch-canonical-dup-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const real = fs.mkdtempSync(path.join(base, 'real-'));
  createProject(store, { id: 'p1', name: 'a', hostId: 'host', canonicalRoot: real, objective: 'o' }, 100);
  assert.throws(() => createProject(store, { id: 'p2', name: 'b', hostId: 'host', canonicalRoot: real.toUpperCase().replace(/\\/g, '/'), objective: 'o' }, 101), /UNIQUE|INVALID_PROJECT_ROOT/);
});

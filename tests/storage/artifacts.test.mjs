import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../../packages/persistence/dist/index.js';
import { registerArtifact, readArtifactRecord, resolveWithinProject, verifyArtifactContent, readFileFingerprint } from '../../packages/domain/dist/artifacts/index.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-artifacts-', () => { for (const s of stores) s.close(); });
  const store = openStore(path.join(dir, 'state.sqlite'));
  stores.push(store);
  store.transaction(db => db.prepare("INSERT INTO projects(id,name,host_id,canonical_root,objective,created_at) VALUES('p1','s','h','E:/synthetic/art','o',0)").run());
  return { store, dir };
}
import { createHash } from 'node:crypto';
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

test('成果登记：相对路径校验、任务归属、记录不可变（A042基础）', t => {
  const { store } = fixture(t);
  const record = registerArtifact(store, { id: 'a1', projectId: 'p1', version: 'v1', pathRef: 'results/report.txt', sha256: sha256(Buffer.from('v1-content')), byteSize: 10 }, 100);
  assert.equal(record.version, 'v1');
  assert.deepEqual(readArtifactRecord(store, 'p1', 'a1'), record);
  for (const bad of [{ id: 'a2', projectId: 'p1', version: 'v', pathRef: '/abs/x' }, { id: 'a2', projectId: 'p1', version: 'v', pathRef: '../x' }, { id: 'a2', projectId: 'p1', version: 'v', pathRef: 'x\\y' }, { id: 'a2', projectId: 'p1', version: 'v', pathRef: 'x', sha256: 'zz' }, { id: 'a2', projectId: 'p-other', version: 'v', pathRef: 'x' }, { id: 'a2', projectId: 'p1', version: 'v', pathRef: 'x', taskId: 'missing-task' }]) {
    assert.throws(() => registerArtifact(store, bad, 101), /INVALID_ARTIFACT|ARTIFACT_PROJECT_NOT_FOUND|ARTIFACT_TASK_NOT_FOUND/);
  }
  assert.throws(() => registerArtifact(store, { id: 'a1', projectId: 'p1', version: 'v2', pathRef: 'results/other.txt' }, 102), /UNIQUE/);
});

test('路径边界（A043）：穿越/junction逃逸拒绝，项目内合法路径解析成功', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'projectorch-art-boundary-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const projectRoot = path.join(base, 'proj');
  fs.mkdirSync(path.join(projectRoot, 'results'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'results', 'report.txt'), 'inside');
  const secretDir = path.join(base, 'secret');
  fs.mkdirSync(secretDir);
  fs.writeFileSync(path.join(secretDir, 'secret.txt'), 'outside');
  assert.equal(resolveWithinProject(projectRoot, 'results/report.txt').ok, true);
  for (const evil of ['..\\secret\\secret.txt', '../../secret/secret.txt', 'results/../../../secret/secret.txt']) {
    const check = resolveWithinProject(projectRoot, evil);
    assert.equal(check.ok, false, evil);
    if (!check.ok) assert.equal(check.reason, 'ESCAPES_PROJECT_ROOT');
  }
  // junction指向项目外：真实解析逃逸必须拒绝（A043目录联接）
  if (process.platform === 'win32') {
    try { fs.symlinkSync(secretDir, path.join(projectRoot, 'link'), 'junction'); } catch { return; }
    const viaLink = resolveWithinProject(projectRoot, 'link/secret.txt');
    assert.equal(viaLink.ok, false, 'junction逃逸必须拒绝');
    assert.equal(resolveWithinProject(projectRoot, 'results/../results/report.txt').ok, false, '点段非良构路径');
  }
  assert.equal(resolveWithinProject(path.join(base, 'missing-root'), 'x').ok, false, '不可解析根明确报告');
});

test('内容核验（A042）：一致通过；缺失明确报告；漂移不静默替换', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'projectorch-art-content-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const projectRoot = path.join(base, 'proj');
  fs.mkdirSync(path.join(projectRoot, 'results'), { recursive: true });
  const { store } = fixture(t);
  const v1 = Buffer.from('v1-content');
  fs.writeFileSync(path.join(projectRoot, 'results', 'report.txt'), v1);
  registerArtifact(store, { id: 'a1', projectId: 'p1', version: 'v1', pathRef: 'results/report.txt', sha256: sha256(v1), byteSize: v1.length }, 100);
  assert.deepEqual(verifyArtifactContent(store, 'p1', 'a1', projectRoot, readFileFingerprint), { ok: true, sha256: sha256(v1), byteSize: v1.length });
  // 原路径内容被修改：登记版本证据不变，明确报告漂移
  fs.writeFileSync(path.join(projectRoot, 'results', 'report.txt'), 'tampered-content');
  const diverged = verifyArtifactContent(store, 'p1', 'a1', projectRoot, readFileFingerprint);
  assert.equal(diverged.ok, false);
  if (!diverged.ok) { assert.equal(diverged.reason, 'CONTENT_DIVERGED'); assert.notEqual(diverged.observedSha256, sha256(v1)); }
  assert.equal(readArtifactRecord(store, 'p1', 'a1').sha256, sha256(v1), '登记哈希不被新内容替换');
  // 文件删除：缺失明确报告
  fs.rmSync(path.join(projectRoot, 'results', 'report.txt'));
  const missing = verifyArtifactContent(store, 'p1', 'a1', projectRoot, readFileFingerprint);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, 'MISSING_CONTENT');
});

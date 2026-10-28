import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openStore } from '../../packages/persistence/dist/index.js';
import { createProject } from '../../packages/domain/dist/projects/index.js';
import { registerArtifact } from '../../packages/domain/dist/artifacts/index.js';
import { readArtifactChunk, artifactChunkBytes } from '../../packages/domain/dist/artifacts/content.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  let store; const dir = temporaryDirectory(t, 'projectorch-artifact-content-', () => store?.close());
  const root = path.join(dir, 'project'); fs.mkdirSync(root); fs.mkdirSync(path.join(root, 'results'));
  store = openStore(path.join(dir, 'state.sqlite'));
  createProject(store, { id: 'p', name: 'synthetic', hostId: 'h', canonicalRoot: root, objective: '专用内容读取测试' }, 100);
  const add = (id, bytes, relative = `results/${id}`) => { const filename = path.join(root, relative); fs.writeFileSync(filename, bytes); const record = registerArtifact(store, { id, projectId: 'p', pathRef: relative, version: hash(bytes), sha256: hash(bytes), byteSize: bytes.length }, 110); return { record, filename, bytes }; };
  const read = (record, offset = 0, check = () => {}) => store.transaction(() => readArtifactChunk(store, 'p', record.id, record.version, offset, check));
  return { store, dir, root, add, read };
}

test('UTF-8分片以字节续页，不切断中文/emoji，完整哈希绑定原始内容', t => {
  const f = fixture(t), bytes = Buffer.from('a'.repeat(artifactChunkBytes - 1) + '中🙂尾');
  const { record } = f.add('unicode', bytes), first = f.read(record), second = f.read(record, first.nextOffset);
  assert.equal(first.encoding, 'utf8'); assert.equal(first.nextOffset, artifactChunkBytes - 1);
  assert.equal(Buffer.from(first.content + second.content).equals(bytes), true);
  assert.equal(first.sha256, hash(bytes)); assert.equal(second.sha256, first.sha256); assert.equal(second.nextOffset, null);
  assert.throws(() => f.read(record, artifactChunkBytes), /INVALID_ARTIFACT_OFFSET/);
});

test('二进制可无损分页，空文件/EOF使用明确空内容，越界偏移拒绝', t => {
  const f = fixture(t), bytes = Buffer.from(Array.from({ length: 70000 }, (_, i) => i % 256));
  const { record } = f.add('binary', bytes), pages = []; let offset = 0;
  do { const page = f.read(record, offset); assert.equal(page.encoding, 'base64'); assert.ok(page.content.length <= 65536); pages.push(Buffer.from(page.content, 'base64')); offset = page.nextOffset; } while (offset !== null);
  assert.equal(Buffer.concat(pages).equals(bytes), true);
  assert.equal(f.read(record, bytes.length).content, '');
  const empty = f.add('empty', Buffer.alloc(0)).record;
  assert.deepEqual(f.read(empty), { artifactId: 'empty', version: hash(Buffer.alloc(0)), offset: 0, content: '', encoding: 'utf8', nextOffset: null, sha256: hash(Buffer.alloc(0)) });
  for (const bad of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, bytes.length + 1]) assert.throws(() => f.read(record, bad), /INVALID_ARTIFACT_OFFSET/);
});

test('版本不符、无登记哈希、尺寸错误或内容漂移不返回任何分片', t => {
  const f = fixture(t), { record, filename } = f.add('proof', Buffer.from('original'));
  assert.throws(() => f.read({ ...record, version: 'wrong' }), /ARTIFACT_VERSION_CONFLICT/);
  fs.writeFileSync(filename, 'changed!'); assert.throws(() => f.read(record), /ARTIFACT_CONTENT_CHANGED/);
  registerArtifact(f.store, { id: 'legacy', projectId: 'p', pathRef: 'results/proof', version: 'legacy' }, 120);
  assert.throws(() => f.read({ id: 'legacy', version: 'legacy' }), /ARTIFACT_HASH_REQUIRED/);
  registerArtifact(f.store, { id: 'bad-size', projectId: 'p', pathRef: 'results/proof', version: 'v1', sha256: hash(Buffer.from('changed!')), byteSize: 1 }, 121);
  assert.throws(() => f.read({ id: 'bad-size', version: 'v1' }), /ARTIFACT_CONTENT_CHANGED/);
});

test('每页都重核全部内容，后续页不能混入修改后的文件', t => {
  const f = fixture(t), original = Buffer.from('x'.repeat(70000)), { record, filename } = f.add('pages', original);
  const first = f.read(record); fs.writeFileSync(filename, Buffer.from('x'.repeat(69999) + 'y'));
  assert.throws(() => f.read(record, first.nextOffset), /ARTIFACT_CONTENT_CHANGED/);
  fs.writeFileSync(filename, original); assert.equal(f.read(record, first.nextOffset).content, 'x'.repeat(70000 - first.nextOffset));
});

test('项目逃逸和项目内别名绕过范围都拒绝，目录和异步授权不会被当作可读文件', t => {
  const f = fixture(t), privateDir = path.join(f.root, 'private'), outside = path.join(f.dir, 'outside');
  fs.mkdirSync(privateDir); fs.mkdirSync(outside); fs.writeFileSync(path.join(privateDir, 'secret'), 'synthetic private'); fs.writeFileSync(path.join(outside, 'secret'), 'synthetic private');
  const record = registerArtifact(f.store, { id: 'alias', projectId: 'p', pathRef: 'alias/secret', version: 'v1', sha256: hash(Buffer.from('synthetic private')), byteSize: 17 }, 120);
  const link = path.join(f.root, 'alias');
  fs.symlinkSync(outside, link, 'junction');
  try { assert.throws(() => f.read(record), /ARTIFACT_NOT_FOUND/); } finally { fs.unlinkSync(link); }
  fs.symlinkSync(privateDir, link, 'junction');
  try { assert.throws(() => f.read(record, 0, scope => { if (scope !== 'alias/secret') throw new Error('ARTIFACT_NOT_FOUND'); }), /ARTIFACT_NOT_FOUND/); } finally { fs.unlinkSync(link); }
  const normal = f.add('normal', Buffer.from('safe')).record;
  for (const check of [async () => {}, () => false, () => Promise.reject(new Error('PRIVATE_ERROR'))]) assert.throws(() => f.read(normal, 0, check), /ARTIFACT_SCOPE_CHECK_REQUIRED/);
  registerArtifact(f.store, { id: 'directory', projectId: 'p', pathRef: 'results', version: 'v1', sha256: 'a'.repeat(64) }, 120);
  assert.throws(() => f.read({ id: 'directory', version: 'v1' }), /ARTIFACT_NOT_FOUND/);
});

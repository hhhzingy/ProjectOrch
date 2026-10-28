import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, defaultMigrations } from '../../packages/persistence/dist/index.js';
import { registerArtifact } from '../../packages/domain/dist/artifacts/index.js';
import { readArtifactChunk } from '../../packages/domain/dist/artifacts/content.js';
import { createHash } from 'node:crypto';
import { registerGitArtifact, verifyGitArtifact, registerGitArtifactWithin, assertGitArtifactSource } from '../../packages/domain/dist/artifacts/git.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}
function fixture(t, initialMigrations) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-git-artifacts-', () => { for (const s of stores) s.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const open = (migrations) => { const result = openStore(filename, migrations ? { migrations } : {}); stores.push(result); return result; };
  const store = open(initialMigrations);
  store.transaction(db => db.prepare("INSERT INTO projects(id,name,host_id,canonical_root,objective,created_at) VALUES('p1','s','h',?,'o',0)").run(dir));
  // 真实临时git仓库：init+两次提交
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'probe@projectorch.invalid');
  git(repo, 'config', 'user.name', 'ProjectOrch Probe');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'first');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'first commit');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'second');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'second commit');
  return { store, repo, dir, open };
}

test('Git成果：真实提交登记（短SHA解析为完整SHA+元数据）、核验、缺失显式报告（A058准备）', t => {
  const { store, repo } = fixture(t);
  const head = git(repo, 'rev-parse', 'HEAD');
  const short = head.slice(0, 8);
  const registered = registerGitArtifact(store, { id: 'ga1', projectId: 'p1', taskId: null, repoRoot: repo, revision: short }, 120);
  assert.equal(registered.git.commitSha, head, '短SHA解析为完整SHA');
  assert.equal(registered.git.subject, 'second commit');
  assert.equal(registered.sha256, null, 'SHA-1提交不得冒充SHA-256字段');
  assert.equal(registered.version, head);
  assert.equal(registered.pathRef, `git:${head}`);
  // 核验：同仓库解析成功
  const verified = verifyGitArtifact(store, 'p1', 'ga1', repo);
  assert.equal(verified.ok, true);
  if (verified.ok) assert.equal(verified.evidence.subject, 'second commit');
  // 伪造提交不可登记
  assert.throws(() => registerGitArtifact(store, { id: 'ga2', projectId: 'p1', repoRoot: repo, revision: 'f'.repeat(40) }, 121), /GIT_COMMIT_NOT_FOUND/);
  assert.throws(() => registerGitArtifact(store, { id: 'ga2', projectId: 'p1', repoRoot: repo, revision: '../escape' }, 122), /INVALID_GIT_REVISION|GIT_COMMIT_NOT_FOUND/);
  // 新仓库不含该历史：核验显式报告不可解析（浅克隆/换库场景）
  const other = path.join(path.dirname(repo), 'other-repo');
  fs.mkdirSync(other);
  git(other, 'init', '-b', 'main');
  git(other, 'config', 'user.email', 'probe@projectorch.invalid');
  git(other, 'config', 'user.name', 'Probe');
  fs.writeFileSync(path.join(other, 'x'), 'x');
  git(other, 'add', '.');
  git(other, 'commit', '-m', 'unrelated');
  const missing = verifyGitArtifact(store, 'p1', 'ga1', other);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, 'GIT_REPOSITORY_CHANGED');
});

test('仓库来源与对象树随登记保存，失败整册回滚，来源不能被改写', t => {
  const { store, repo } = fixture(t);
  const head = git(repo, 'rev-parse', 'HEAD');
  const before = git(repo, 'status', '--porcelain=v1');
  registerGitArtifact(store, { id: 'source', projectId: 'p1', repoRoot: repo, revision: head }, 120);
  const source = store.db.prepare("SELECT * FROM artifact_git_sources WHERE artifact_id='source'").get();
  assert.equal(source.repository_path, 'repo'); assert.equal(source.tree_sha, git(repo, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(JSON.parse(source.identity_json).repository.path, fs.realpathSync.native(repo));
  assert.throws(() => store.db.exec("UPDATE artifact_git_sources SET repository_path='other'"), /GIT_SOURCE_IMMUTABLE/);
  assert.throws(() => store.db.exec('DELETE FROM artifact_git_sources'), /GIT_SOURCE_RETAINED/);
  store.db.exec("CREATE TRIGGER synthetic_git_source_failure BEFORE INSERT ON artifact_git_sources BEGIN SELECT RAISE(ABORT,'SOURCE_INSERT_FAILED'); END");
  assert.throws(() => registerGitArtifact(store, { id: 'failed', projectId: 'p1', repoRoot: repo, revision: head }, 121), /SOURCE_INSERT_FAILED/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE id='failed'").get().n, 0);
  assert.equal(git(repo, 'status', '--porcelain=v1'), before, '只读核验不改变工作树或索引');
});

test('13→14迁移保留旧裸Git原记录，不猜测仓库回填', t => {
  const { store, repo, open } = fixture(t, defaultMigrations().slice(0, 13));
  const head = git(repo, 'rev-parse', 'HEAD');
  registerArtifact(store, { id: 'legacy', projectId: 'p1', version: 'git:legacy subject', pathRef: `git:${head}`, sha256: head }, 120);
  const previous = store.db.prepare("SELECT * FROM artifacts WHERE id='legacy'").get();
  store.close(); const upgraded = open();
  assert.deepEqual(upgraded.db.prepare("SELECT * FROM artifacts WHERE id='legacy'").get(), previous);
  assert.equal(upgraded.db.prepare('SELECT COUNT(*) AS n FROM artifact_git_sources').get().n, 0);
  assert.equal(verifyGitArtifact(upgraded, 'p1', 'legacy', repo).reason, 'GIT_SOURCE_MISSING');
  assert.ok(fs.existsSync(upgraded.migrationBackup));
  assert.equal(upgraded.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('工作树修改和Git替代对象不改变已登记提交，环境Git目录注入被忽略', t => {
  const { store, repo } = fixture(t);
  const head = git(repo, 'rev-parse', 'HEAD'), parent = git(repo, 'rev-parse', 'HEAD^');
  registerGitArtifact(store, { id: 'stable', projectId: 'p1', repoRoot: repo, revision: head }, 120);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'uncommitted work');
  git(repo, 'replace', head, parent);
  const previous = process.env.GIT_DIR;
  try {
    process.env.GIT_DIR = path.join(repo, 'does-not-exist');
    const result = assertGitArtifactSource(store, 'p1', 'stable');
    assert.equal(result.evidence.commitSha, head); assert.equal(result.evidence.subject, 'second commit');
  } finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; }
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'uncommitted work');
});

test('相同路径换成含相同提交的另一个仓库仍拒绝，不能仅凭提交ID冒充原仓库', t => {
  const { store, repo, dir } = fixture(t); const head = git(repo, 'rev-parse', 'HEAD');
  registerGitArtifact(store, { id: 'pinned', projectId: 'p1', repoRoot: repo, revision: head }, 120);
  const moved = path.join(dir, 'original-repo');
  assert.equal(path.dirname(path.resolve(repo)), dir); assert.equal(path.dirname(path.resolve(moved)), dir);
  fs.renameSync(repo, moved);
  git(dir, '-c', 'core.hooksPath=', 'clone', '--no-hardlinks', '--no-checkout', moved, repo);
  assert.equal(git(repo, 'rev-parse', head), head);
  assert.equal(verifyGitArtifact(store, 'p1', 'pinned').reason, 'GIT_REPOSITORY_CHANGED');
});

test('根仓库有明确范围标识，越界junction、父目录发现和外部Git元数据拒绝', t => {
  const { store, repo, dir } = fixture(t);
  const head = git(repo, 'rev-parse', 'HEAD');
  store.db.prepare("UPDATE projects SET canonical_root=? WHERE id='p1'").run(repo);
  const scopes = [];
  store.transaction(() => registerGitArtifactWithin(store, { id: 'root', projectId: 'p1', repositoryPath: '.', revision: head }, 120, item => { scopes.push(item); }));
  assert.ok(scopes.length > 0); assert.ok(scopes.every(item => item === 'repositories/root'));
  fs.mkdirSync(path.join(repo, 'subdirectory'));
  assert.throws(() => store.transaction(() => registerGitArtifactWithin(store, { id: 'sub', projectId: 'p1', repositoryPath: 'subdirectory', revision: head }, 121)), /GIT_REPOSITORY_ROOT_REQUIRED/);
  const project = path.join(dir, 'project'); fs.mkdirSync(project); store.db.prepare("UPDATE projects SET canonical_root=? WHERE id='p1'").run(project);
  const link = path.join(project, 'escape');
  fs.symlinkSync(repo, link, 'junction');
  try { assert.throws(() => store.transaction(() => registerGitArtifactWithin(store, { id: 'escape', projectId: 'p1', repositoryPath: 'escape', revision: head }, 122)), /GIT_REPOSITORY_OUTSIDE_PROJECT/); }
  finally { fs.unlinkSync(link); }
  const linked = path.join(project, 'linked'); fs.mkdirSync(linked); fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${path.join(repo, '.git')}\n`);
  assert.throws(() => store.transaction(() => registerGitArtifactWithin(store, { id: 'metadata', projectId: 'p1', repositoryPath: 'linked', revision: head }, 123)), /GIT_METADATA_OUTSIDE_PROJECT/);
});

test('缺失blob或损坏提交无法核验，已有来源记录保持原样；外部对象替代路径不跟随', t => {
  for (const scenario of ['missing-blob', 'corrupt-commit', 'alternates']) {
    const { store, repo } = fixture(t); const head = git(repo, 'rev-parse', 'HEAD');
    registerGitArtifact(store, { id: 'proof', projectId: 'p1', repoRoot: repo, revision: head }, 120);
    const previous = store.db.prepare("SELECT * FROM artifact_git_sources WHERE artifact_id='proof'").get();
    const objects = path.join(repo, '.git', 'objects');
    if (scenario === 'missing-blob') { const blob = git(repo, 'rev-parse', 'HEAD:a.txt'); fs.unlinkSync(path.join(objects, blob.slice(0, 2), blob.slice(2))); }
    if (scenario === 'corrupt-commit') { const object = path.join(objects, head.slice(0, 2), head.slice(2)); fs.chmodSync(object, 0o600); fs.writeFileSync(object, 'corrupt object'); }
    if (scenario === 'alternates') fs.writeFileSync(path.join(objects, 'info', 'alternates'), 'C:/outside/project/objects\n');
    assert.equal(verifyGitArtifact(store, 'p1', 'proof').ok, false, scenario);
    assert.deepEqual(store.db.prepare("SELECT * FROM artifact_git_sources WHERE artifact_id='proof'").get(), previous);
  }
});

test('Git对象目录内的重解析点不被读取或作为可信对象源', t => {
  const { store, repo } = fixture(t);
  registerGitArtifact(store, { id: 'proof', projectId: 'p1', repoRoot: repo, revision: git(repo, 'rev-parse', 'HEAD') }, 120);
  const link = path.join(repo, '.git', 'objects', 'unsafe-link');
  fs.symlinkSync(repo, link, 'junction');
  try { assert.throws(() => assertGitArtifactSource(store, 'p1', 'proof'), /GIT_OBJECT_LINK_UNSUPPORTED/); }
  finally { fs.unlinkSync(link); }
});

test('项目内共享Git元数据也须额外授权，不能用自己的checkout路径读取其他仓库', t => {
  const { store, repo, dir } = fixture(t), checkout = path.join(dir, 'checkout');
  fs.mkdirSync(checkout); fs.writeFileSync(path.join(checkout, '.git'), `gitdir: ${path.join(repo, '.git')}\n`);
  const input = { id: 'shared', projectId: 'p1', repositoryPath: 'checkout', revision: git(repo, 'rev-parse', 'HEAD') };
  assert.throws(() => store.transaction(() => registerGitArtifactWithin(store, input, 120, scope => { if (scope !== 'checkout') throw new Error('FORBIDDEN'); })), /FORBIDDEN/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n, 0);
  const scopes = [];
  store.transaction(() => registerGitArtifactWithin(store, input, 121, scope => { scopes.push(scope); if (!['checkout', 'repo/.git'].includes(scope)) throw new Error('FORBIDDEN'); }));
  assert.ok(scopes.includes('repo/.git'));
});

test('Git范围检查须同步且显式以异常拒绝，异步或误返false不能放行', t => {
  const { store, repo } = fixture(t), input = { id: 'async', projectId: 'p1', repositoryPath: 'repo', revision: git(repo, 'rev-parse', 'HEAD') };
  for (const check of [async () => {}, () => false, () => Promise.reject(new Error('PRIVATE_SCOPE_ERROR'))]) {
    assert.throws(() => store.transaction(() => registerGitArtifactWithin(store, input, 120, check)), /GIT_SCOPE_CHECK_REQUIRED/);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM artifact_git_sources').get().n, 0);
  }
});

test('Git内容提供固定提交对象原始字节，SHA-256绑定返回内容而非冒充提交ID', t => {
  const { store, repo } = fixture(t), head = git(repo, 'rev-parse', 'HEAD');
  registerGitArtifact(store, { id: 'content', projectId: 'p1', repoRoot: repo, revision: head }, 120);
  const raw = execFileSync('git', ['-C', repo, 'cat-file', 'commit', head]);
  const page = store.transaction(() => readArtifactChunk(store, 'p1', 'content', head, 0, () => {}));
  assert.equal(page.encoding, 'utf8'); assert.equal(page.content, raw.toString('utf8')); assert.equal(page.version, head);
  assert.equal(page.sha256, createHash('sha256').update(raw).digest('hex')); assert.equal(page.nextOffset, null);
  assert.throws(() => store.transaction(() => readArtifactChunk(store, 'p1', 'content', 'wrong', 0, () => {})), /ARTIFACT_VERSION_CONFLICT/);
});

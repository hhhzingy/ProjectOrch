import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { NativeCompatibilityRegistry } from '../../apps/kernel/dist/native/compatibility.js';
import { VerifiedZCodeTextSession, zcodeTextAdapterProtocol } from '../../apps/kernel/dist/native/verified-zcode-session.js';
import { temporaryDirectory } from './temporary-directory.mjs';
const hash = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const ref = { harnessId: 'zcode', hostId: 'synthetic', profileId: 'synthetic', nativeConversationId: 'synthetic' };
test('未测构建可使用；运行中更新程序要求重启，新实例无需补历史测试记录', async t => {
  const dir = temporaryDirectory(t, 'projectorch-compat-');
  const bundle = path.join(dir, 'synthetic-worker.mjs');
  fs.copyFileSync(fileURLToPath(new URL('./zcode-cli-worker.mjs', import.meta.url)), bundle);
  const identity = { harnessId: 'zcode', version: 'synthetic-1', executableSha256: hash(process.execPath), bundleSha256: hash(bundle), adapterProtocol: zcodeTextAdapterProtocol, route: 'official_cli' };
  const options = { executable: process.execPath, bundle, cwd: dir, env: {}, timeoutMs: 2000 };
  const registry = new NativeCompatibilityRegistry();
  const owner = new VerifiedZCodeTextSession(dir, ref, options, registry, identity);
  assert.equal((await owner.execute('synthetic-before')).result.sessionId, ref.nativeConversationId);
  const originalHash = hash(bundle); assert.equal(originalHash, identity.bundleSha256);
  // 模拟官方更新；只有测试修改自己的fixture，生产适配器不修改原生软件。
  fs.appendFileSync(bundle, '\n// synthetic official update\n');
  await assert.rejects(owner.execute('synthetic-after'), /NATIVE_RUNTIME_CHANGED_RESTART_REQUIRED/); assert.equal(owner.phase, 'idle'); owner.close();
  const updated = { ...identity, version: 'synthetic-2', bundleSha256: hash(bundle) };
  const next = new VerifiedZCodeTextSession(dir, ref, options, registry, updated);
  assert.equal((await next.execute('synthetic-after')).result.sessionId, ref.nativeConversationId); next.close();
  assert.equal(hash(bundle), updated.bundleSha256);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';
const entry = fileURLToPath(new URL('../../../apps/kernel/dist/main.js', import.meta.url));
const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'COMSPEC'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const bounded = (promise, ms = 10000) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('APPLICATION_TEST_TIMEOUT')), ms); })]).finally(() => clearTimeout(timer)); };

test('标准入口真实子进程：静态页面→IPC配对→HTTP命令→单实例拒绝→停止重启保留状态', async t => {
  let child; let exited;
  t.after(async () => {
    if (child?.exitCode === null && child?.signalCode === null) {
      if (child.connected) child.send({ type: 'shutdown' });
      try { await bounded(exited, 5000); } catch { child.kill(); await bounded(exited, 5000); }
    }
  });
  const dir = temporaryDirectory(t, 'projectorch-application-entry-');
  const filename = path.join(dir, 'state.sqlite');
  const seed = openStore(filename);
  createProject(seed, { id: 'p-entry', name: '启动测试', hostId: 'synthetic', canonicalRoot: path.join(dir, 'workspace'), objective: '检验入口' }, Date.now());
  seed.close();
  child = spawn(process.execPath, [entry, '--data-dir', dir], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  exited = once(child, 'exit');
  let output = ''; let errorOutput = '';
  child.stderr.on('data', bytes => { errorOutput += bytes; });
  const ready = await bounded(new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error('APPLICATION_EXITED_BEFORE_READY')));
    child.stdout.on('data', bytes => {
      output += bytes;
      if (output.includes('\n')) { try { resolve(JSON.parse(output.split('\n')[0])); } catch { reject(new Error('INVALID_READY_OUTPUT')); } }
    });
  }));
  assert.equal(ready.status, 'ready');
  assert.match(ready.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await fetch(ready.origin)).status, 200);
  const pairingReply = bounded(once(child, 'message'));
  child.send({ type: 'pair' });
  const [challenge] = await pairingReply;
  assert.equal(challenge.type, 'pairing');
  const paired = await fetch(ready.origin + '/api/v1/pairing', { method: 'POST', headers: { Origin: ready.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ schemaVersion: 2, requestId: 'pair-entry', challengeId: challenge.challengeId, oneTimeCode: challenge.oneTimeCode }) });
  assert.equal(paired.status, 200);
  const cookie = paired.headers.get('set-cookie').split(';')[0];
  const { csrfToken } = await paired.json();
  const paused = await fetch(ready.origin + '/api/v1/commands', { method: 'POST', headers: { Origin: ready.origin, Cookie: cookie, 'Content-Type': 'application/json', 'x-projectorch-csrf': csrfToken }, body: JSON.stringify({ schemaVersion: 2, requestId: 'pause-entry', projectId: 'p-entry', type: 'project.pause', payload: { reason: '入口测试', currentWorkPolicy: 'finish' } }) });
  assert.ok([200, 202].includes(paused.status));
  const second = spawnSync(process.execPath, [entry, '--data-dir', dir, '--check'], { env, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(second.status, 1); assert.match(second.stderr, /KERNEL_ALREADY_RUNNING/);
  child.send({ type: 'shutdown' });
  assert.equal((await bounded(exited))[0], 0);
  assert.equal(output.includes(challenge.oneTimeCode), false, '配对秘密不进入stdout日志');
  assert.equal(errorOutput.includes(challenge.oneTimeCode), false);
  const restart = spawnSync(process.execPath, [entry, '--data-dir', dir, '--check'], { env, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(restart.status, 0); assert.equal(JSON.parse(restart.stdout).status, 'ready');
  const reopened = openStore(filename);
  try { assert.equal(reopened.db.prepare("SELECT user_paused FROM projects WHERE id='p-entry'").get().user_paused, 1); }
  finally { reopened.close(); }
});

test('标准入口错误参数和重定向配对拒绝，help不创建用户数据', t => {
  const dir = temporaryDirectory(t, 'projectorch-entry-arguments-');
  const target = path.join(dir, 'not-created');
  for (const args of [['--data-dir', target, '--unknown'], ['--data-dir', target, '--pair'], ['--data-dir', 'relative', '--check']]) {
    const run = spawnSync(process.execPath, [entry, ...args], { env, encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(run.status, 1); assert.equal(fs.existsSync(target), false);
  }
  const help = spawnSync(process.execPath, [entry, '--help'], { env: { ...env, PROJECTORCH_DATA_DIR: target }, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(help.status, 0); assert.equal(fs.existsSync(target), false);
});

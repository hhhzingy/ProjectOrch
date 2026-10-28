import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const read = p => JSON.parse(fs.readFileSync(new URL(`../../contracts/examples/${p}.json`, import.meta.url), 'utf8'));

test('独立客户端进程与新服务协商版本交集、扩展字段及未知能力', async t => {
  const child = fork(fileURLToPath(new URL('./negotiation-worker.mjs', import.meta.url)), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { if (child.connected) child.disconnect(); await exited; });
  let id = 0;
  function exchange(patch = {}) {
    return new Promise((resolve, reject) => {
      const request = { id: ++id, versions: [2], hello: read('capabilities'), requiredCapabilities: [], message: read('message'), ...patch };
      const timer = setTimeout(() => { child.off('message', reply); reject(new Error('CONTRACT_HANDSHAKE_TIMEOUT')); }, 3000);
      function reply(response) { if (response.id !== request.id) return; clearTimeout(timer); child.off('message', reply); resolve(response); }
      child.on('message', reply); child.send(request);
    });
  }
  for (const versions of [[2], [1, 2], [3, 2]]) {
    const result = await exchange({ versions }); assert.equal(result.status, 'accepted'); assert.equal(result.schemaVersion, 2);
  }
  for (const versions of [[1], [3], [], ['2']]) {
    const result = await exchange({ versions }); assert.equal(result.status, 'rejected'); assert.match(result.reason, /VERSION/); assert.equal(Object.hasOwn(result, 'requestId'), false);
  }
  const unknown = await exchange({ requiredCapabilities: ['invented'] });
  assert.equal(unknown.status, 'rejected'); assert.equal(unknown.reason, 'UNKNOWN_CAPABILITY');
  const unverified = await exchange({ requiredCapabilities: ['attachExisting'] });
  assert.equal(unverified.reason, 'CAPABILITY_NOT_VERIFIED');
  const message = { ...read('message'), sql: 'SYNTHETIC_PRIVATE_VALUE' };
  const extension = await exchange({ message }); assert.equal(extension.reason, 'SCHEMA_MISMATCH'); assert.equal(JSON.stringify(extension).includes('SYNTHETIC_PRIVATE_VALUE'), false);
  const hello = read('capabilities'); hello.capabilities.invented = { state: 'unknown', semantics: 'synthetic', evidenceRefs: [] };
  assert.equal((await exchange({ hello })).status, 'rejected');
  assert.equal((await exchange()).status, 'accepted');
});

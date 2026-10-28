import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ZCodeTextProcess } from '../../apps/kernel/dist/native/zcode-text-process.js';
const fixture = fileURLToPath(new URL('./zcode-cli-worker.mjs', import.meta.url));
const options = { executable: process.execPath, bundle: fixture, cwd: fileURLToPath(new URL('../../', import.meta.url)), env: {}, timeoutMs: 2000 };
test('真实合成CLI子进程正常退出才交付，同实例可精确续接，stderr只计字节', async () => {
  const owner = new ZCodeTextProcess(options);
  const first = await owner.execute('synthetic 中文 $()', null);
  assert.equal(first.exitConfirmed, true); assert.equal(first.result.response, 'synthetic 中文 $()'); assert.ok(first.stderrBytes > 0);
  assert.equal(JSON.stringify(first).includes('synthetic-secret'), false); assert.equal(owner.phase, 'idle');
  const second = await owner.execute('synthetic second', first.result.sessionId);
  assert.equal(second.result.sessionId, first.result.sessionId); assert.notEqual(second.pid, first.pid);
});
test('超时、异常退出或坏帧后保留unknown占用，禁止重发和并行执行', async () => {
  for (const text of ['silent', 'exit', 'bad']) {
    const owner = new ZCodeTextProcess({ ...options, timeoutMs: 300 });
    const run = owner.execute(text, 'synthetic-existing');
    await assert.rejects(owner.execute('synthetic parallel', 'synthetic-existing'), /CLI_OWNER_NOT_IDLE/);
    await assert.rejects(run, e => e.delivery === 'uncertain');
    assert.equal(owner.phase, 'unknown');
    await assert.rejects(owner.execute('synthetic repeat', 'synthetic-existing'), /CLI_OWNER_NOT_IDLE/);
  }
});
test('无效输入/启动失败为发送前失败，保留原会话目标', async () => {
  const owner = new ZCodeTextProcess({ ...options, executable: fileURLToPath(new URL('./missing-executable', import.meta.url)) });
  await assert.rejects(owner.execute(' ', null), /INVALID_CLI_INPUT/); assert.equal(owner.phase, 'idle');
  await assert.rejects(owner.execute('synthetic', null), /CLI_SPAWN_NOT_SENT/); assert.equal(owner.phase, 'idle');
});
test('旧进程代次的终止不影响新执行，精确当前目标终止后保持uncertain', async () => {
  const runner = new ZCodeTextProcess(options);
  const first = await runner.execute('synthetic-first', 'synthetic-existing');
  assert.equal(runner.requestOwnedProcessTermination(first.processEpoch).status, 'not_running');
  const next = runner.execute('delayed', 'synthetic-existing');
  assert.equal(runner.requestOwnedProcessTermination(first.processEpoch).status, 'stale_target');
  assert.equal((await next).result.response, 'delayed');
  const running = runner.execute('silent', 'synthetic-existing');
  const epoch = runner.snapshot.processEpoch;
  const stopped = runner.requestOwnedProcessTermination(epoch);
  assert.equal(stopped.status, 'termination_requested');
  await assert.rejects(running, error => error.code === 'CLI_TERMINATED_UNCERTAIN' && error.delivery === 'uncertain');
  assert.equal(runner.phase, 'unknown'); assert.equal(runner.snapshot.exitConfirmed, true);
  assert.equal(runner.requestOwnedProcessTermination(epoch).status, 'not_running');
  await assert.rejects(runner.execute('synthetic-retry', 'synthetic-existing'), /CLI_OWNER_NOT_IDLE/);
});

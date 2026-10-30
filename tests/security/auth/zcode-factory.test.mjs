/** T111（PR2-W1）：ZCode持久会话工厂（离线部分——真实CLI调用见A111原生验收）。
 * 合成"bundle"脚本模拟官方CLI：--version返回版本；--prompt输出stream-json帧（session_created/assistant/result）。
 * executable=真node（与生产形态一致：node <bundle> --prompt ...）。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import { ZcodeSessionFactory, detectZcodeIdentity } from '../../../apps/kernel/dist/execution/zcode-supervisor.js';
import { NativeCompatibilityRegistry } from '../../../apps/kernel/dist/native/compatibility.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';
import { NativeSessionLease } from '../../../apps/kernel/dist/native/session-lease.js';

function makeSyntheticBundle(dir, mode = 'ok') {
  const script = path.join(dir, 'synthetic-zcode.cjs');
  const body = mode === 'ok'
    ? `const sid = 'sess_synthetic_' + (process.env.PROJECTORCH_TEST_SID ?? 'default');
const frames = [
  { type: 'system', subtype: 'session_created', sessionId: sid, turnId: null },
  { type: 'assistant', subtype: 'text', text: 'CHARTER_ACK', turnId: 'turn_synthetic_1', sessionId: sid },
  { type: 'result', isError: false, sessionId: sid, turnId: 'turn_synthetic_1', response: 'CHARTER_ACK', projection: { status: 'idle', turnCount: 1 } },
];
for (const f of frames) console.log(JSON.stringify(f));`
    : mode === 'timeout'
      ? `setTimeout(() => console.log('never'), 60000);`
      : `process.stderr.write('synthetic failure\\n'); process.exit(1);`;
  fs.writeFileSync(script, `const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.17.0-synthetic'); process.exit(0); }
${body}
`);
  return script;
}

function registryWith(partial) {
  const registry = new NativeCompatibilityRegistry();
  const identity = { harnessId: 'zcode', adapterProtocol: 'zcode-cli-jsonl-v2', route: 'official_cli', ...partial };
  registry.recordTrustedProbe({ identity, probeId: 'synthetic-factory', evidenceSha256: 'c'.repeat(64), capabilities: { textInput: 'verified', resume: 'verified', historyRead: 'verified' } });
  return registry;
}
const identityOf = (exe, bundle) => detectZcodeIdentity(exe, bundle);

test('T111离线：现场身份保留，历史测试哈希不匹配不阻止接入', t => {
  const dir = temporaryDirectory(t, 'projectorch-t111-id-');
  const bundle = makeSyntheticBundle(dir, 'ok');
  const identity = identityOf(process.execPath, bundle);
  assert.equal(identity.version, '0.17.0-synthetic', '版本来自现场探针');
  assert.match(identity.bundleSha256, /^[a-f0-9]{64}$/);
  assert.match(identity.executableSha256, /^[a-f0-9]{64}$/);
  // 合成历史记录与当前构建不同，不能据此设置运行白名单。
  const registry = registryWith({ harnessId: 'zcode', version: '0.17.0-synthetic', executableSha256: 'f'.repeat(64), bundleSha256: 'e'.repeat(64), adapterProtocol: 'zcode-cli-jsonl-v2', route: 'official_cli' });
  const factory = new ZcodeSessionFactory({ executable: process.execPath, bundle, env: {}, leaseDirectory: dir, registry });
  assert.doesNotThrow(() => factory.assertCapabilities());
});

test('工厂租约目录缺失在CLI发送前拒绝，不创建未知会话',async t=>{
 const dir=temporaryDirectory(t,'projectorch-factory-lease-preflight-');
 const bundle=makeSyntheticBundle(dir,'ok');
 const registry=registryWith(identityOf(process.execPath,bundle));const steps=[];
 const factory=new ZcodeSessionFactory({executable:process.execPath,bundle,env:{},leaseDirectory:path.join(dir,'missing'),registry});
 await assert.rejects(factory.createSessionWithCharter({charter:'不得发送',workspaceRoot:dir,hostId:'h',profileId:'p',onStep:s=>steps.push(s)}),e=>e.delivery==='not_sent'&&e.message==='FACTORY_LEASE_DIRECTORY_UNAVAILABLE');
 assert.equal(steps.length,0);
});

test('T111离线：合成CLI持久会话创建+章程——onStep边界（sent→observed）、真实sessionId、单次发送不重试', async t => {
  const dir = temporaryDirectory(t, 'projectorch-t111-ok-');
  const bundle = makeSyntheticBundle(dir, 'ok');
  const registry = registryWith(identityOf(process.execPath, bundle));
  const leaseDir = path.join(dir, 'leases'); fs.mkdirSync(leaseDir);
  const factory = new ZcodeSessionFactory({ executable: process.execPath, bundle, env: { PROJECTORCH_TEST_SID: 'abc123' }, leaseDirectory: leaseDir, registry, executionTimeoutMs:900000 });
  const steps = [];
  const outcome = await factory.createSessionWithCharter({
    charter: '你是演示角色，职责：只回复CHARTER_ACK',
    workspaceRoot: dir, hostId: 'host-1', profileId: 'profile-1',
    onStep: s => steps.push(s),
  });
  assert.equal(outcome.nativeSessionId, 'sess_synthetic_abc123', '官方观察的持久会话ID');
  assert.equal(outcome.nativeTurnId, 'turn_synthetic_1');
  const nextOwner=NativeSessionLease.acquire(leaseDir,outcome.sessionRef);
  nextOwner.releaseAfterExit(true);
  assert.ok(steps.some(s => s.step === 'create-session' && s.state === 'sent'), '发送边界先记录');
  assert.ok(steps.some(s => s.step === 'create-session' && s.state === 'observed'), '观察结果后记录');
  assert.ok(steps.some(s => s.step === 'deliver-charter' && s.state === 'observed'), '章程下发观察');
  assert.equal(steps.filter(s => s.step === 'create-session' && s.state === 'sent').length, 1, '不盲重试（单次发送边界）');
});

test('T111离线：立即失败→failed如实；不伪造observed', async t => {
  const dir = temporaryDirectory(t, 'projectorch-t111-fail-');
  const bundle = makeSyntheticBundle(dir, 'fail');
  const registry = registryWith(identityOf(process.execPath, bundle));
  const leaseDir = path.join(dir, 'leases'); fs.mkdirSync(leaseDir);
  const factory = new ZcodeSessionFactory({ executable: process.execPath, bundle, env: {}, leaseDirectory: leaseDir, registry, timeoutMs: 15000 });
  const steps = [];
  await assert.rejects(() => factory.createSessionWithCharter({ charter: 'x', workspaceRoot: dir, hostId: 'h', profileId: 'p', onStep: s => steps.push(s) }));
  assert.ok(steps.some(s => s.state === 'failed' || s.state === 'unknown'), '失败如实记录');
  assert.ok(!steps.some(s => s.state === 'observed'), '不伪造observed');
});

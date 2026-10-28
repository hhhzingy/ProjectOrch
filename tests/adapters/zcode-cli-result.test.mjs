import assert from 'node:assert/strict';
import test from 'node:test';
import { ZCodeCliResultCollector, zcodeTextOnlyArgs } from '../../apps/kernel/dist/native/zcode-cli-result.js';
const result = { type: 'result', sessionId: 'synthetic-session', turnId: 'synthetic-turn', response: '合成中文', projection: { status: 'idle', turnCount: 1 } };
const bytes = frame => Buffer.from(`${JSON.stringify(frame)}\n`);
test('ZCode结果仅在同会话、完整分帧及正常退出后确认，支持UTF8跨块', () => {
  const c = new ZCodeCliResultCollector(result.sessionId);
  c.push(bytes({ type: 'turn.completed', sessionId: result.sessionId }));
  const b = bytes(result); const split = b.indexOf(Buffer.from('合')) + 1;
  c.push(b.subarray(0, split)); c.push(b.subarray(split));
  assert.deepEqual(c.finish(0, null), { sessionId: result.sessionId, turnId: result.turnId, response: result.response, turnCount: 1 });
  assert.throws(() => c.finish(0, null), /CLI_ALREADY_FINISHED/);
});
test('替代会话、重复结果、畸形/截断/超限/异常退出保持uncertain', () => {
  const cases = [
    ['CLI_RESULT_ERROR', c => c.push(bytes({ ...result, isError: true }))],
    ['CLI_SESSION_MISMATCH', c => c.push(bytes({ ...result, sessionId: 'different' }))],
    ['CLI_DATA_AFTER_RESULT', c => { c.push(bytes(result)); c.push(bytes(result)); }],
    ['CLI_INVALID_FRAME', c => c.push(Buffer.from('{bad\n'))],
    ['CLI_TRUNCATED_FRAME', c => { c.push(Buffer.from('{')); c.finish(0, null); }],
    ['CLI_EXIT_UNCERTAIN', c => { c.push(bytes(result)); c.finish(1, null); }],
    ['CLI_EXIT_UNCERTAIN', c => { c.push(bytes(result)); c.finish(null, 'SIGTERM'); }],
    ['CLI_RESULT_MISSING', c => { c.push(bytes({ type: 'turn.completed' })); c.finish(0, null); }],
    ['CLI_INVALID_RESULT', c => c.push(bytes({ ...result, projection: { status: 'running', turnCount: 1 } }))],
    ['CLI_INVALID_RESULT', c => c.push(bytes({ ...result, turnId: '' }))],
    ['CLI_INVALID_RESULT', c => c.push(bytes({ ...result, projection: { status: 'idle', turnCount: -1 } }))],
  ];
  for (const [code, action] of cases) {
    const c = new ZCodeCliResultCollector(result.sessionId);
    assert.throws(() => action(c), e => e.code === code && e.delivery === 'uncertain');
    assert.throws(() => c.push(bytes(result)), e => e.delivery === 'uncertain');
  }
  const small = new ZCodeCliResultCollector(null, 128);
  assert.throws(() => small.push(Buffer.alloc(129)), /CLI_OUTPUT_LIMIT/);
});
test('纯文本CLI参数精确resume，不把提示文本交给shell或静默continue/fork', () => {
  const text = 'synthetic $() ` --force';
  const args = zcodeTextOnlyArgs('official.cjs', text, result.sessionId);
  assert.equal(args[2], text); assert.deepEqual(args.slice(-2), ['--resume', result.sessionId]);
  assert.deepEqual(args.slice(5, 7), ['--disallowedTools', '*']);
  assert.equal(args.includes('--force'), false); assert.equal(args.includes('--continue'), false);
  assert.equal(zcodeTextOnlyArgs('official.cjs', text, null).includes('--resume'), false);
  assert.throws(() => zcodeTextOnlyArgs('official.cjs', ' ', null), /INVALID_CLI_INPUT/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { ContractError, negotiateAdapter, negotiateProtocol, parseContract, parseContractJson } from '../../packages/contracts/dist/index.js';

const read = rel => JSON.parse(fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8'));
test('成果分片明确编码并支持空内容；旧缺编码响应和非法编码拒绝', () => {
  const empty = read('contracts/examples/artifact-chunk-empty.json');
  assert.deepEqual(parseContract('artifact-chunk', empty), empty);
  const missing = { ...empty }; delete missing.encoding;
  assert.throws(() => parseContract('artifact-chunk', missing));
  assert.throws(() => parseContract('artifact-chunk', { ...empty, encoding: 'guess' }));
  assert.throws(() => parseContract('artifact-chunk', { ...empty, content: 'x'.repeat(65537) }));
});
test('回执使用已有固定领域定义，失败必须带错误，未知定义不能动态加载', () => {
  const receipt = { requestId: 'synthetic', projectId: 'synthetic-project', commandId: 'synthetic-command', status: 'completed', receiptUrl: '/synthetic-not-live', entityIds: [], error: null, lastEventSequence: 0 };
  assert.deepEqual(parseContract('receipt', receipt), receipt);
  for (const patch of [{ status: 'failed' }, { admin: true }, { lastEventSequence: -1 }, { commandId: '' }]) assert.throws(() => parseContract('receipt', { ...receipt, ...patch }));
  assert.throws(() => parseContract('domain#/$defs/Receipt', receipt), e => e.reason === 'UNKNOWN_CONTRACT');
});
test('固定运行时 Schema 与全部正反例一致；未知 Schema 不可由调用者动态注入', () => {
  const catalog = read('contracts/examples/catalog.json');
  for (const row of catalog.examples) {
    const name = row.schema.split('/').at(-1).replace('.schema.json', '');
    const action = () => parseContract(name, read(row.path));
    if (row.valid) assert.doesNotThrow(action, row.path); else assert.throws(action, ContractError, row.path);
  }
  for (const name of ['__proto__', 'constructor', 'external-schema']) assert.throws(() => parseContract(name, {}), e => e.reason === 'UNKNOWN_CONTRACT');
});
test('请求拒绝自报身份、Schema、SQL、旧版本，且不修改调用对象', () => {
  const message = read('contracts/examples/message.json');
  for (const field of ['principal', 'fromRoleId', 'admin', '$schema', 'schema', 'sql', '__proto__']) assert.throws(() => parseContract('message', { ...message, [field]: 'synthetic-untrusted' }));
  assert.throws(() => parseContract('message', { ...message, schemaVersion: 1 }), e => e.reason === 'UNSUPPORTED_PROTOCOL_VERSION');
  assert.throws(() => parseContract('message', Object.create(message)));
  const parsed = parseContract('message', message);
  assert.deepEqual(parsed, message); parsed.body = 'changed'; assert.notEqual(parsed.body, message.body);
  const before = structuredClone(message);
  assert.throws(() => parseContract('message', { ...message, requestId: 123 })); assert.deepEqual(message, before);
});
test('版本交集仅支持已实现v2，旧客户端和未知版本明确拒绝，不静默执行', () => {
  for (const versions of [[2], [1, 2], [3, 2]]) assert.equal(negotiateProtocol(versions), 2);
  for (const versions of [[1], [3], [], ['2'], null, [0], [2.5], Array(17).fill(2)]) assert.throws(() => negotiateProtocol(versions), ContractError);
});
test('能力握手拒绝未知、未实证声明及没有证据引用的verified声明', () => {
  const hello = read('contracts/examples/capabilities.json');
  assert.throws(() => negotiateAdapter([2], hello, ['invented']), e => e.reason === 'UNKNOWN_CAPABILITY');
  assert.throws(() => negotiateAdapter([2], hello, ['attachExisting']), e => e.reason === 'CAPABILITY_NOT_VERIFIED');
  assert.throws(() => negotiateAdapter([2], { ...hello, capabilities: { ...hello.capabilities, invented: { state: 'verified', semantics: 'synthetic', evidenceRefs: ['not-native'] } } }, []));
  hello.capabilities.attachExisting.state = 'verified'; hello.capabilities.attachExisting.evidenceRefs = [];
  assert.throws(() => negotiateAdapter([2], hello, ['attachExisting']));
  hello.capabilities.attachExisting.evidenceRefs = ['synthetic-structure-only-not-native-PASS'];
  assert.equal(negotiateAdapter([2], hello, ['attachExisting']).schemaVersion, 2);
});
test('JSON解析限制体积、畸形输入，错误不回显秘密或完整对象', () => {
  assert.throws(() => parseContractJson('message', '{bad'), e => e.reason === 'INVALID_JSON');
  assert.throws(() => parseContractJson('message', null), e => e.reason === 'INVALID_JSON');
  assert.throws(() => parseContractJson('message', ' '.repeat(1024 * 1024 + 1)), e => e.reason === 'INPUT_TOO_LARGE');
  assert.throws(() => parseContract('message', { password: 'SYNTHETIC_PRIVATE_VALUE' }), e => !JSON.stringify(e).includes('SYNTHETIC_PRIVATE_VALUE') && e.issues.length <= 16);
  const message = read('contracts/examples/message.json');
  assert.deepEqual(parseContractJson('message', JSON.stringify(message)), message);
});

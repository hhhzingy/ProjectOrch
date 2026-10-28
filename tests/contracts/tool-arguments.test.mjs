import test from 'node:test';
import assert from 'node:assert/strict';
import { parseToolArguments, toolArgumentSchema, schemaFingerprint } from '../../packages/contracts/dist/index.js';
import { mcpToolEntries, mcpToolDescription } from '../../apps/kernel/dist/tools/mcp-catalog.js';

test('工具参数从内置合同派生，写入需要requestId且不能注入来源或任意字段', () => {
  const args = { requestId: 'claim', taskId: 'task', expectedRevision: 1, expectedSpecRevision: 1 };
  assert.deepEqual(parseToolArguments('command', 'task.claim', args), args);
  for (const extra of [{ roleId: 'other' }, { callerNativeExecutionId: 'other' }, { projectId: 'other' }]) assert.throws(() => parseToolArguments('command', 'task.claim', { ...args, ...extra }));
  assert.throws(() => parseToolArguments('command', 'task.claim', { taskId: 'task', expectedRevision: 1, expectedSpecRevision: 1 }));
  assert.deepEqual(parseToolArguments('query', 'task.read', { taskId: 'task' }), { taskId: 'task' });
  const file = { requestId: 'file', taskId: 't', taskRevision: 1, kind: 'report', path: 'results/out.txt', sha256: 'a'.repeat(64), byteSize: 1 };
  const git = { requestId: 'git', taskId: 't', taskRevision: 1, kind: 'git_commit', repositoryPath: 'repo', commitId: 'b'.repeat(40) };
  assert.deepEqual(parseToolArguments('command', 'artifact.register', file), file); assert.deepEqual(parseToolArguments('command', 'artifact.register', git), git);
  assert.throws(() => parseToolArguments('command', 'artifact.register', { ...file, roleId: 'other' }));
});

test('全部已列MCP工具的输入Schema内联本地引用，不要求客户端联网解析内部地址', () => {
  const names = new Set();
  for (const entry of mcpToolEntries) {
    const description = mcpToolDescription(entry); assert.equal(description.inputSchema.type, 'object');
    assert.doesNotMatch(JSON.stringify(description.inputSchema), /"\$ref"|projectorch\.invalid/);
    assert.equal(names.has(description.name), false); names.add(description.name);
    assert.throws(() => parseToolArguments(entry.source, entry.variant, { unknownExtraField: true }));
  }
  assert.ok(names.has('projectorch_task_report')); assert.equal([...names].some(n => /pause|approve|reset|configure|bootstrap/.test(n)), false);
});

test('返回Schema副本不能篡改后续验证，未知合同/变体拒绝且不改变生成合同指纹', () => {
  const before = schemaFingerprint; const schema = toolArgumentSchema('command', 'task.claim'); schema.properties.requestId.minLength = 0;
  assert.throws(() => parseToolArguments('command', 'task.claim', { requestId: '', taskId: 't', expectedRevision: 1, expectedSpecRevision: 1 }));
  assert.throws(() => toolArgumentSchema('arbitrary-file', 'x')); assert.throws(() => toolArgumentSchema('command', 'file.execute'));
  assert.equal(schemaFingerprint, before);
});

test('工具反馈聚焦实际操作缺字段；保留未知操作及数组约束，不回显参数值',()=>{
 const input={requestId:'req',expectedPlanRevision:1,reason:'secret-value-must-not-echo',operations:[{type:'role.create',roleId:'manager',parentRoleId:'lead',roleType:'manager',permissionProfileId:'manager',capabilityTags:[]}]};
 assert.throws(()=>parseToolArguments('changeset','',input),error=>{
  assert.match(error.message,/TOOL_ARGUMENTS_INVALID/);
  assert.ok(error.issues.some(e=>e.instancePath==='/operations/0'&&e.field==='name'));
  assert.equal(error.issues.some(e=>e.field==='taskId'),false);
  assert.doesNotMatch(JSON.stringify(error.issues),/secret-value-must-not-echo/);return true;
 });
 for(const operations of [[],[{type:'unknown.operation'}]])assert.throws(()=>parseToolArguments('changeset','',{...input,operations}),error=>{assert.ok(error.issues.length>0);return true;});
 assert.throws(()=>parseToolArguments('result','',{schemaVersion:2,projectId:'hidden-project',requestId:'result'}),error=>{assert.ok(error.issues.some(e=>e.field==='schemaVersion'));assert.doesNotMatch(JSON.stringify(error.issues),/hidden-project/);return true;});
});

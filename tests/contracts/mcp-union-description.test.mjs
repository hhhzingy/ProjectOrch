import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import Ajv from 'ajv';
import {mcpToolDescription,mcpToolArguments,mcpToolEntries} from '../../apps/kernel/dist/tools/mcp-catalog.js';

test('成果登记工具顶层声明字段，分支file/git校验仍严格；无参/混用分支拒绝',()=>{
  const entry=mcpToolEntries.find(e=>e.tool==='artifact.register');
  const schema=mcpToolDescription(entry).inputSchema;
  assert.ok(schema.properties.requestId);assert.ok(schema.properties.path);assert.ok(schema.properties.repositoryPath);
  assert.deepEqual(new Set(schema.properties.kind.enum),new Set(['file','report','git_commit']));
  const validate=new Ajv({strict:false}).compile(schema);
  const file={requestId:'register-1',taskId:'task-1',taskRevision:1,kind:'file',path:'result.txt',sha256:createHash('sha256').update('x').digest('hex'),byteSize:1};
  assert.equal(validate(file),true);assert.deepEqual(mcpToolArguments(entry,file),file);
  assert.equal(validate({}),false);assert.throws(()=>mcpToolArguments(entry,{}));
  assert.equal(validate({...file,repositoryPath:'repo',commitId:'a'.repeat(40)}),false);
  assert.throws(()=>mcpToolArguments(entry,{...file,repositoryPath:'repo'}));
});

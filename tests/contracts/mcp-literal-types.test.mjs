import test from 'node:test';import assert from 'node:assert/strict';import Ajv from 'ajv';
import {toolArgumentSchema} from '../../packages/contracts/dist/index.js';
import {mcpToolEntries,mcpToolDescription,mcpToolArguments} from '../../apps/kernel/dist/tools/mcp-catalog.js';

test('MCP展示明确protocolVersion数字类型；数字2可用，字符串2仍被原合同与tools/list Schema拒绝',()=>{
 const entry=mcpToolEntries.find(e=>e.tool==='role.startup_ack'),before=toolArgumentSchema(entry.source,entry.variant),schema=mcpToolDescription(entry).inputSchema;
 assert.equal(schema.properties.protocolVersion.const,2);assert.equal(schema.properties.protocolVersion.type,'integer');assert.deepEqual(toolArgumentSchema(entry.source,entry.variant),before,'不修改内核原始合同');
 const validate=new Ajv({strict:false}).compile(schema),input={requestId:'ack',roleId:'worker',bindingEpoch:1,protocolVersion:2,policyRevision:1,planRevision:1,roleRevision:2,taskSpecRevisions:[{taskId:'task',specRevision:1}]};
 assert.equal(validate(input),true,JSON.stringify(validate.errors));assert.equal(mcpToolArguments(entry,input).protocolVersion,2);
 const wrong={...input,protocolVersion:'2'};assert.equal(validate(wrong),false);assert.throws(()=>mcpToolArguments(entry,wrong));assert.equal(wrong.protocolVersion,'2','不做字符串转数字宽松处理');
});

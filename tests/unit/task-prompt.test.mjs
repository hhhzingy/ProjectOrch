import test from 'node:test';
import assert from 'node:assert/strict';
import {taskExecutionPrompt} from '../../apps/kernel/dist/execution/task-prompt.js';
test('执行输入保留完整规格和版本，非法或过大输入在发送前拒绝',()=>{
 const input={taskId:'t',specRevision:7,spec:{goal:'生成实际文件',inputArtifacts:[{artifactId:'input',version:'v1'}],outputRequirements:[{name:'out',kind:'file',description:'仅UTF8'}],acceptance:[{ruleId:'r',mode:'user',description:'检查内容'}],dependencies:[]}};
 const prompt=taskExecutionPrompt(input);assert.ok(prompt.includes(JSON.stringify(input)));assert.match(prompt,/currentAttempt/);assert.match(prompt,/checks/);assert.match(prompt,/不能使用顶层实体/);assert.match(prompt,/workspaceRelativeToProjectRoot/);assert.match(prompt,/基准始终是项目根/);
 assert.throws(()=>taskExecutionPrompt({}),/INVALID_TASK_EXECUTION_INPUT/);
 assert.throws(()=>taskExecutionPrompt({spec:{goal:'a'.repeat(64000)}}),/TASK_EXECUTION_INPUT_TOO_LARGE/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';
import { writeBindingToolConfig, codexRoleToolOverrides } from '../../../apps/kernel/dist/tools/binding-tool-config.js';

test('角色工具配置不会覆盖用户文件、其他角色或外部编辑；同绑定允许轮换', t=>{
  const root=temporaryDirectory(t,'projectorch-tool-config-');
  const ws=path.join(root,'role');const url='http://127.0.0.1:1234/mcp';
  writeBindingToolConfig(ws,'p','b1',url,'synthetic-one');
  writeBindingToolConfig(ws,'p','b1',url,'synthetic-two');
  const config=path.join(ws,'.zcode/config.json');const before=fs.readFileSync(config,'utf8');
  assert.match(before,/synthetic-two/);
  assert.throws(()=>writeBindingToolConfig(ws,'p','b2',url,'other'),/WORKSPACE_COLLISION/);
  assert.equal(fs.readFileSync(config,'utf8'),before);
  fs.writeFileSync(config,'{"userSetting":"preserve"}');
  assert.throws(()=>writeBindingToolConfig(ws,'p','b1',url,'third'),/EXISTING_ROLE_CONFIG_PRESERVED/);
  assert.equal(fs.readFileSync(config,'utf8'),'{"userSetting":"preserve"}');
  const user=path.join(root,'user');fs.mkdirSync(path.join(user,'.zcode'),{recursive:true});
  fs.writeFileSync(path.join(user,'.zcode/config.json'),'user bytes');
  assert.throws(()=>writeBindingToolConfig(user,'p','b1',url,'third'),/EXISTING_ROLE_CONFIG_PRESERVED/);
  assert.equal(fs.readFileSync(path.join(user,'.zcode/config.json'),'utf8'),'user bytes');
});

test('Codex角色入口使用官方每进程配置覆盖和环境引用，不将凭据放入参数',()=>{
  const args=codexRoleToolOverrides('http://127.0.0.1:1234/mcp');
  assert.ok(args.some(x=>x==='mcp_servers.projectorch.bearer_token_env_var="PROJECTORCH_ROLE_CREDENTIAL"'));
  assert.ok(args.some(x=>x==='mcp_servers.projectorch.enabled=true'));
  assert.ok(!args.some(x=>x.includes('Bearer ')));
  const limited=codexRoleToolOverrides('http://127.0.0.1:1234/mcp',['projectorch_identity','projectorch_message_send']);
  assert.ok(limited.includes('mcp_servers.projectorch.tools.projectorch_identity.approval_mode="approve"'));
  assert.ok(limited.includes('mcp_servers.projectorch.enabled_tools=["projectorch_identity","projectorch_message_send"]'));
  assert.ok(!limited.some(x=>x.includes('task_accept')||x.startsWith('approval_policy=')));
  assert.throws(()=>codexRoleToolOverrides('http://127.0.0.1:1234/mcp',['other.tool']),/INVALID_ROLE_TOOL_NAME/);
});

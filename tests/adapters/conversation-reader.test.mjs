import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';
import {temporaryDirectory} from './temporary-directory.mjs';
import {visibleConversation,readNativeConversation} from '../../apps/kernel/dist/native/conversation-reader.js';

test('正文白名单：只显示用户/助手文本，不带工具、推理或凭据；错会话拒绝',()=>{
 const token='a'.repeat(36)+'.'+'b'.repeat(43),codex={thread:{id:'n',turns:[{items:[{id:'u',type:'userMessage',content:[{type:'text',text:'hello '+token},{type:'image',url:'PRIVATE_IMAGE'}]},{id:'a',type:'agentMessage',text:'<script>只作文本</script>'},{id:'t',type:'mcpToolCall',arguments:'PRIVATE_TOOL'},{id:'r',type:'reasoning',text:'PRIVATE_REASONING'}]}]}};
 const page=visibleConversation('codex',codex,'n');assert.equal(page.items.length,2);assert.match(page.items[0].text,/已隐藏角色凭据/);assert.doesNotMatch(JSON.stringify(page),/PRIVATE_|bbbbbbbb/);
 assert.throws(()=>visibleConversation('codex',codex,'other'),/TARGET_UNPROVEN/);
 const zcode={messages:[{info:{id:'u',sessionID:'n',role:'user'},parts:[{type:'text',text:'hello'},{type:'tool',text:'PRIVATE_TOOL'}]}]};assert.equal(visibleConversation('zcode',zcode,'n').items[0].text,'hello');assert.throws(()=>visibleConversation('zcode',zcode,'other'),/TARGET_UNPROVEN/);
});

for(const harnessId of ['codex','zcode'])test(`${harnessId}生产读取器实际子进程RPC只读，不创建/发送模型轮`,async t=>{
 const dir=temporaryDirectory(t,'projectorch-conversation-reader-'),script=path.join(dir,'app-server');
 fs.writeFileSync(script,`const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const q=JSON.parse(line);fs.appendFileSync('calls',q.method+'\\n');if(!q.id)return;let result={};if(q.method==='thread/read')result={thread:{id:'n',turns:[{items:[{id:'a',type:'agentMessage',text:'CODEX_BODY'}]}]}};else if(q.method==='session/resume')result={sessionId:'n'};else if(q.method==='session/messages')result={messages:[{info:{id:'a',sessionID:'n',role:'assistant'},parts:[{type:'text',text:'ZCODE_BODY'}]}]};else if(q.method!=='initialize')process.exit(2);console.log(JSON.stringify({id:q.id,result}));});`);
 let checks=0;const session={harnessId,hostId:'synthetic',profileId:'synthetic',nativeConversationId:'n',nativeWorkspaceId:dir};
 const page=await readNativeConversation({executable:process.execPath,...(harnessId==='zcode'?{bundle:script}:{}),cwd:dir,env:{SystemRoot:process.env.SystemRoot??''}},session,()=>checks++);
 assert.equal(page.items[0].text,harnessId==='codex'?'CODEX_BODY':'ZCODE_BODY');assert.ok(checks>=3);
 const calls=fs.readFileSync(path.join(dir,'calls'),'utf8');assert.doesNotMatch(calls,/thread\/start|turn\/start|session\/create|session\/send/);assert.match(calls,harnessId==='codex'?/thread\/read/:/session\/messages/);
});

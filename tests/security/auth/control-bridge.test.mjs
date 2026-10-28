import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {createControlBridge} from '../../../scripts/mcp-control-bridge.mjs';
import {startApplication} from '../../../apps/kernel/dist/lifecycle/application.js';
import {temporaryDirectory} from '../../adapters/temporary-directory.mjs';

test('本地stdio入口从发现文件连生产MCP；内核换端口后重握手，控制令牌不进入身份回执',async t=>{
 let runtime;t.after(async()=>runtime?.stop());const dir=temporaryDirectory(t,'projectorch-control-bridge-');runtime=await startApplication(dir);
 const bridge=createControlBridge(dir),request=(id,method,params={})=>({jsonrpc:'2.0',id,method,params});
 const init=await bridge(request(1,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}}));assert.ok(init.result);
 await bridge({jsonrpc:'2.0',method:'notifications/initialized',params:{}});
 const before=await bridge(request(2,'tools/call',{name:'projectorch_identity',arguments:{}}));assert.equal(before.result?.isError,false,JSON.stringify(before));
 const secret=JSON.parse(fs.readFileSync(path.join(dir,'control-entry.json'),'utf8')).token;assert.equal(JSON.stringify(before).includes(secret),false);
 await runtime.stop();runtime=await startApplication(dir);
 const after=await bridge(request(3,'tools/call',{name:'projectorch_identity',arguments:{}}));assert.equal(after.result?.isError,false,JSON.stringify(after));
});

test('拒绝外部发现端点；网络失败的写意图不自动重发且不泄露错误/凭据',async t=>{
 const dir=temporaryDirectory(t,'projectorch-bridge-failure-');
 fs.writeFileSync(path.join(dir,'control-entry.json'),JSON.stringify({token:'projectorch-control-synthetic-secret'}));
 const discover=url=>fs.writeFileSync(path.join(dir,'runtime-discovery.json'),JSON.stringify({schemaVersion:2,mcpUrl:url,startedAt:1}));
 let writes=0;const fetcher=async(_url,options)=>{const request=JSON.parse(options.body);if(request.method==='tools/call'){writes++;throw Error('secret-body-and-token');}return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{}}),{status:200,headers:{'mcp-session-id':'sid'}});};
 discover('https://remote.invalid/mcp');const invalid=createControlBridge(dir,fetcher);assert.ok((await invalid({jsonrpc:'2.0',id:1,method:'initialize',params:{}})).error);assert.equal(writes,0);
 discover('http://127.0.0.1:1234/mcp');const bridge=createControlBridge(dir,fetcher);await bridge({jsonrpc:'2.0',id:2,method:'initialize',params:{}});await bridge({jsonrpc:'2.0',method:'notifications/initialized'});
 const response=await bridge({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'message.send'}});assert.equal(writes,1);assert.equal(response.error.message,'PROJECTORCH_UNAVAILABLE_NO_AUTOMATIC_REPLAY');assert.doesNotMatch(JSON.stringify(response),/secret-body|synthetic-secret/);
});

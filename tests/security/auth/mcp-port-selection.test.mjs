// 负责人端口选择回归：真实本机HTTP监听；只让首个address候选报告Fetch禁用端口，非官方模型。
import test from 'node:test';import assert from 'node:assert/strict';import {Server} from 'node:http';
import {startMcpHttpHost} from '../../../apps/kernel/dist/tools/mcp-http-host.js';
import {browserHttpPortAllowed} from '../../../apps/kernel/dist/http/browser-listener.js';
test('MCP首个动态监听候选为Fetch禁用端口时应重选安全端口',async()=>{
 const realAddress=Server.prototype.address;let injected=false,host;
 Server.prototype.address=function(){const result=realAddress.call(this);if(!injected&&result&&typeof result==='object'){injected=true;return {...result,port:6000};}return result;};
 try{
  host=await startMcpHttpHost({backendForConnection:()=>({list:()=>[],call:()=>({ok:true,payload:{}}),closed:()=>{}})});
  const port=Number(new URL(host.url).port);console.log(JSON.stringify({injectedFirstCandidate:6000,publishedPort:port,allowed:browserHttpPortAllowed(port),officialModelInputs:0}));
  assert.equal(injected,true);assert.equal(browserHttpPortAllowed(port),true,'MCP不能把Fetch拒绝的端口发布给客户端');
  assert.equal((await fetch(host.url)).status,405,'最终实际端口可由Fetch访问，仍保留方法限制');
 }finally{Server.prototype.address=realAddress;await host?.close();}
});

test('MCP连续命中Fetch禁用端口时有界失败并关闭全部候选',async()=>{
 const realAddress=Server.prototype.address,realClose=Server.prototype.close;let candidates=0,closed=0,lastServer;
 Server.prototype.address=function(){const result=realAddress.call(this);if(result&&typeof result==='object'){lastServer=this;candidates++;return {...result,port:6000};}return result;};
 Server.prototype.close=function(...args){closed++;return realClose.apply(this,args);};
 try{
  await assert.rejects(()=>startMcpHttpHost({backendForConnection:()=>({list:()=>[],call:()=>({ok:true,payload:{}}),closed:()=>{}})}),/NO_BROWSER_SAFE_PORT/);
  assert.equal(candidates,16);assert.equal(closed,16);assert.equal(lastServer.listening,false);assert.equal(lastServer.listenerCount('error'),0);
 }finally{Server.prototype.address=realAddress;Server.prototype.close=realClose;}
});

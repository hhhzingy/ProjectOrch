import test from 'node:test';import assert from 'node:assert/strict';import net from 'node:net';import {once} from 'node:events';import {setTimeout as delay} from 'node:timers/promises';
import {startMcpHttpHost} from '../../../apps/kernel/dist/tools/mcp-http-host.js';
import {startApplication} from '../../../apps/kernel/dist/lifecycle/application.js';
import {temporaryDirectory} from '../../adapters/temporary-directory.mjs';
const init={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'synthetic-shutdown',version:'1'}}};
const backend=label=>({list:()=>[],call:()=>({ok:true,payload:{label}}),closed:()=>{}});
async function post(host,token,frame,sid){const response=await fetch(host.url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(sid?{'Mcp-Session-Id':sid}:{})},body:JSON.stringify(frame)});return response;}

test('MCP会话ID不能跨角色凭据或复用控制入口权限，拒绝后原连接继续有效',async()=>{
 const host=await startMcpHttpHost({backendForConnection:()=>backend('control'),resolveBearer:token=>['role-a','role-b'].includes(token)?backend(token):null});
 try{
  const control=(await post(host,host.bearerToken,init)).headers.get('mcp-session-id'),a=(await post(host,'role-a',init)).headers.get('mcp-session-id');
  const initialized={jsonrpc:'2.0',method:'notifications/initialized',params:{}};await post(host,host.bearerToken,initialized,control);await post(host,'role-a',initialized,a);
  const call={jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'synthetic-write',arguments:{}}};
  for(const sid of [control,a])assert.equal((await post(host,'role-b',call,sid)).status,404,'其他有效凭据也不能继承该会话身份');
  const own=await post(host,'role-a',call,a);assert.equal(own.status,200);assert.match(JSON.stringify(await own.json()),/role-a/);
 }finally{await host.close();}
});

test('MCP未收齐正文时有界关闭，重复close同一Promise；迟到正文不执行工具',async()=>{
 let headersSeen=0,ready;const received=new Promise(r=>{ready=r;}),calls=[];
 const host=await startMcpHttpHost({backendForConnection:()=>{if(++headersSeen===3)ready();return {list:()=>[],call:name=>{calls.push(name);return{ok:true,payload:{}};},closed:()=>{}};}});
 const endpoint=new URL(host.url),socket=net.createConnection({host:'127.0.0.1',port:Number(endpoint.port)});socket.on('error',()=>{});
 const connected=once(socket,'connect');
 try{
  await connected;
  const sid=(await post(host,host.bearerToken,init)).headers.get('mcp-session-id');await post(host,host.bearerToken,{jsonrpc:'2.0',method:'notifications/initialized'},sid);
  const body=JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'must-not-run',arguments:{}}});
  socket.write(`POST /mcp HTTP/1.1\r\nHost: ${endpoint.host}\r\nAuthorization: Bearer ${host.bearerToken}\r\nMcp-Session-Id: ${sid}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body.slice(0,10)}`);await received;
  const closed=host.close();assert.equal(host.close(),closed);socket.write(body.slice(10));
  await Promise.race([closed,delay(700).then(()=>{throw Error('MCP_CLOSE_WAITED_FOR_BODY');})]);await delay(15);assert.deepEqual(calls,[]);assert.equal(host.connections(),0);
 }finally{socket.destroy();await host.close();}
});

test('标准应用停止不被MCP半包绕过观察期限，未释放客户端前数据库已关闭',async t=>{
 const directory=temporaryDirectory(t,'projectorch-mcp-shutdown-'),runtime=await startApplication(directory,{shutdownDrainMs:40}),endpoint=new URL(runtime.mcpEntrypoint.url),socket=net.createConnection({host:'127.0.0.1',port:Number(endpoint.port)});socket.on('error',()=>{});
 try{
  await once(socket,'connect');socket.write(`POST /mcp HTTP/1.1\r\nHost: ${endpoint.host}\r\nAuthorization: Bearer ${runtime.mcpEntrypoint.bearerToken}\r\nContent-Length: 1000\r\n\r\n{`);await delay(50);
  let stopped=false;const closing=runtime.stop().then(()=>{stopped=true;});await delay(400);const beforeRelease={stopped,open:runtime.store.db.isOpen};socket.destroy();await closing;
  assert.equal(beforeRelease.stopped,true);assert.equal(beforeRelease.open,false);
 }finally{socket.destroy();await runtime.stop();}
});

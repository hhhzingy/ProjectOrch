/** 官方stdio MCP配置入口。仅读取指定ProjectOrch数据目录的自有发现/控制码，绝不读取Harness认证。
 * 写请求失败不重放；内核地址变化只重建协议握手。stdout仅协议帧，stderr只固定错误代码。 */
import fs from 'node:fs';import path from 'node:path';import readline from 'node:readline';import {fileURLToPath} from 'node:url';

export function createControlBridge(dataDirectory,fetcher=fetch){
 if(!path.isAbsolute(dataDirectory)||/^(?:\\\\|\/\/)/.test(dataDirectory))throw Error('LOCAL_DATA_DIRECTORY_REQUIRED');
 const directory=fs.realpathSync.native(dataDirectory);let key=null,sessionId=null,initialize=null,initialized=false;
 const discover=()=>{
   const load=name=>{const file=path.join(directory,name),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw Error('UNSAFE_DISCOVERY_FILE');return JSON.parse(fs.readFileSync(file,'utf8'));};
   const discovery=load('runtime-discovery.json'),credential=load('control-entry.json');
   const url=new URL(discovery.mcpUrl);
   if(discovery.schemaVersion!==2||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/mcp'||url.search||url.hash||url.username||url.password||!url.port||typeof credential.token!=='string'||!credential.token.startsWith('projectorch-control-'))throw Error('INVALID_LOCAL_DISCOVERY');
   return{url:url.href,token:credential.token,key:JSON.stringify([url.href,discovery.startedAt,credential.token])};
 };
 const post=async(target,frame)=>{
   const headers={'Content-Type':'application/json',Authorization:`Bearer ${target.token}`};if(sessionId)headers['Mcp-Session-Id']=sessionId;
   const response=await fetcher(target.url,{method:'POST',headers,body:JSON.stringify(frame),signal:AbortSignal.timeout(15000)});
   sessionId=response.headers.get('mcp-session-id')??sessionId;
   if(response.status===202)return null;
   if(response.status!==200)throw Error('KERNEL_HTTP_REJECTED');
   const text=await response.text();if(Buffer.byteLength(text)>1048576)throw Error('KERNEL_FRAME_TOO_LARGE');return JSON.parse(text);
 };
 return async(frame)=>{
   const request=frame&&typeof frame==='object'&&!Array.isArray(frame)&&frame.jsonrpc==='2.0'&&typeof frame.method==='string';
   const id=frame?.id??null;
   if(!request)return{jsonrpc:'2.0',id,error:{code:-32600,message:'INVALID_REQUEST'}};
   try{
     if(frame.method==='initialize'){initialize=frame.params;initialized=false;sessionId=null;const target=discover();key=target.key;return await post(target,frame);}
     if(!initialize)throw Error('INITIALIZE_REQUIRED');
     const target=discover();
     if(key!==target.key){
       sessionId=null;const init=await post(target,{jsonrpc:'2.0',id:'projectorch-bridge-reinitialize',method:'initialize',params:initialize});if(init?.error)throw Error('KERNEL_INITIALIZE_REJECTED');
       await post(target,{jsonrpc:'2.0',method:'notifications/initialized',params:{}});key=target.key;initialized=true;
     }
     if(frame.method==='notifications/initialized')initialized=true;
     else if(!initialized)throw Error('INITIALIZED_NOTIFICATION_REQUIRED');
     return await post(target,frame);
   }catch{
     // 不输出Error.message/URL/token或未知请求正文；失败写意图保留由调用方按原requestId核对。
     if(frame.id===undefined)return null;
     return{jsonrpc:'2.0',id,error:{code:-32000,message:'PROJECTORCH_UNAVAILABLE_NO_AUTOMATIC_REPLAY'}};
   }
 };
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const index=process.argv.indexOf('--data-dir');if(index<0||!process.argv[index+1])throw Error('DATA_DIRECTORY_REQUIRED');
 let bridge;try{bridge=createControlBridge(process.argv[index+1]);}catch{process.stderr.write('PROJECTORCH_DISCOVERY_UNAVAILABLE\n');process.exit(1);}
 let pending=0,chain=Promise.resolve();
 const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
 lines.on('line',line=>{
   if(Buffer.byteLength(line)>1048576||++pending>32){process.stderr.write('MCP_INPUT_LIMIT\n');lines.close();process.stdin.destroy();return;}
   chain=chain.then(async()=>{try{let frame;try{frame=JSON.parse(line);}catch{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'PARSE_ERROR'}})+'\n');return;}const response=await bridge(frame);if(response)process.stdout.write(JSON.stringify(response)+'\n');}finally{pending--;}});
 });
}

import type {SessionRef} from '@projectorch/adapter-contract';
import {StdioPeer} from './stdio-peer.js';

export interface VisibleConversationItem {readonly id:string;readonly role:'user'|'assistant';readonly text:string;}
export interface VisibleConversation {readonly items:readonly VisibleConversationItem[];readonly limited:boolean;}
const record=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const list=(v:unknown):unknown[]=>Array.isArray(v)?v:[];
const clean=(s:string)=>s.replace(/[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}/g,'[已隐藏角色凭据]').replace(/projectorch-control-[A-Za-z0-9-]+/g,'[已隐藏控制码]').slice(0,16000);

/** 只投影用户/助手正文，不返回工具参数、环境、内部推理或认证配置。 */
export function visibleConversation(harnessId:string,snapshot:unknown,nativeId:string):VisibleConversation{
 const rows:VisibleConversationItem[]=[];let limited=false,total=0;
 const add=(id:unknown,role:'user'|'assistant',text:string)=>{
  if(typeof id!=='string'||!id||!text)return;
  if(rows.length>=200||total+text.length>300000){limited=true;return;}
  if(text.length>16000)limited=true;const body=clean(text);total+=body.length;rows.push({id,role,text:body});
 };
 const root=record(snapshot);
 if(harnessId==='codex'){
  const thread=record(root.thread);if(thread.id!==nativeId||!Array.isArray(thread.turns))throw Error('CONVERSATION_TARGET_UNPROVEN');
  for(const turn of thread.turns)for(const value of list(record(turn).items)){
   const item=record(value);
   if(item.type==='userMessage')add(item.id,'user',list(item.content).map(record).filter(p=>p.type==='text'&&typeof p.text==='string').map(p=>p.text).join('\n'));
   if(item.type==='agentMessage'&&typeof item.text==='string')add(item.id,'assistant',item.text);
  }
 }else if(harnessId==='zcode'){
  if(!Array.isArray(root.messages))throw Error('CONVERSATION_TARGET_UNPROVEN');
  if(root.messages.length>=200)limited=true;
  for(const value of root.messages){const item=record(value),info=record(item.info);if(info.sessionID!==nativeId)throw Error('CONVERSATION_TARGET_UNPROVEN');
   if(info.role==='user'||info.role==='assistant')add(info.id,info.role,list(item.parts).map(record).filter(p=>p.type==='text'&&typeof p.text==='string').map(p=>p.text).join('\n'));
  }
 }else throw Error('CONVERSATION_HARNESS_UNSUPPORTED');
 return {items:rows,limited};
}

/** 仅从固定绑定的官方历史读取。不创建会话/轮次，不调用send，也不修改业务终态。 */
export async function readNativeConversation(config:{executable:string;bundle?:string;env:Readonly<Record<string,string>>;cwd:string},session:SessionRef,assertCurrent:()=>void):Promise<VisibleConversation>{
 if(!['codex','zcode'].includes(session.harnessId)||session.harnessId==='zcode'&&!config.bundle)throw Error('CONVERSATION_HARNESS_UNSUPPORTED');
 assertCurrent();
 const peer=new StdioPeer({executable:config.executable,args:session.harnessId==='codex'?['app-server']:[config.bundle as string,'app-server'],cwd:config.cwd,env:config.env,timeoutMs:20000,maxFrameBytes:4*1024*1024});
 try{
  await peer.ready;assertCurrent();
  if(session.harnessId==='codex'){
   await peer.request('initialize',{clientInfo:{name:'projectorch_conversation_readonly',version:'2'}});await peer.notify('initialized',{});assertCurrent();
   const result=await peer.request('thread/read',{threadId:session.nativeConversationId,includeTurns:true});assertCurrent();return visibleConversation('codex',result,session.nativeConversationId);
  }
  await new Promise(resolve=>setTimeout(resolve,5000));assertCurrent();
  const resumed=record(await peer.request('session/resume',{sessionId:session.nativeConversationId,workspace:{workspacePath:config.cwd,workspaceKey:config.cwd}}));
  if((resumed.sessionId??record(resumed.session).sessionId)!==session.nativeConversationId)throw Error('CONVERSATION_TARGET_UNPROVEN');
  assertCurrent();const result=await peer.request('session/messages',{sessionId:session.nativeConversationId,limit:200});assertCurrent();return visibleConversation('zcode',result,session.nativeConversationId);
 }finally{await peer.close().catch(()=>undefined);}
}

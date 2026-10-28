import {createHash} from 'node:crypto';
import type {SessionRef} from '@projectorch/adapter-contract';
import {StdioPeer} from './stdio-peer.js';

type RecordValue=Record<string,unknown>;
const record=(value:unknown):RecordValue=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as RecordValue:{};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

/** 换绑前静止观察；只与内核无未决副作用核验组合使用，不能据此结算旧unknown轮。 */
export function sessionQuiescent(harnessId:string,snapshot:unknown,sessionId:string):boolean{
 const value=record(snapshot);if(!sessionId)return false;
 if(harnessId==='codex'){
  const thread=record(value.thread);
  return thread.id===sessionId&&['idle','notLoaded'].includes(String(record(thread.status).type))&&Array.isArray(thread.turns)&&thread.turns.every(t=>['completed','failed','interrupted'].includes(String(record(t).status)));
 }
 if(harnessId!=='zcode')return false;
 const session=record(value.session),projection=record(value.projection);
 return session.sessionId===sessionId&&session.status==='idle'&&projection.sessionId===sessionId&&projection.status==='idle'&&Array.isArray(projection.activeToolCalls)&&projection.activeToolCalls.length===0&&Array.isArray(projection.pendingPermissions)&&projection.pendingPermissions.length===0;
}

/** 仅精确ID只读，禁止把身份/模型可读当作空闲证明。 */
export async function inspectSessionQuiescence(config:{executable:string;bundle?:string;env:Readonly<Record<string,string>>;cwd:string},session:SessionRef):Promise<boolean>{
 if(!['codex','zcode'].includes(session.harnessId)||session.harnessId==='zcode'&&!config.bundle)return false;
 const peer=new StdioPeer({executable:config.executable,args:session.harnessId==='codex'?['app-server']:[config.bundle as string,'app-server'],cwd:config.cwd,env:config.env,timeoutMs:30000});
 try{
  await peer.ready;
  if(session.harnessId==='codex'){
   await peer.request('initialize',{clientInfo:{name:'projectorch_succession_readonly',version:'2'}});await peer.notify('initialized',{});
   return sessionQuiescent('codex',await peer.request('thread/read',{threadId:session.nativeConversationId,includeTurns:true}),session.nativeConversationId);
  }
  await new Promise(resolve=>setTimeout(resolve,5000));
  const resumed=record(await peer.request('session/resume',{sessionId:session.nativeConversationId,workspace:{workspacePath:config.cwd,workspaceKey:config.cwd}}));
  const ids=[resumed.sessionId,record(resumed.session).sessionId,resumed.id].filter(id=>id!==undefined);if(!ids.length||ids.some(id=>id!==session.nativeConversationId))return false;
  return sessionQuiescent('zcode',await peer.request('session/read',{sessionId:session.nativeConversationId,contentProfile:'index'}),session.nativeConversationId);
 }catch{return false;}finally{await peer.close().catch(()=>undefined);}
}

/** 仅解释已可信观察到的线程；精确匹配唯一原章程输入、原生终态和确认标记，空闲本身不作证明。 */
export function codexCharterProof(snapshot:unknown,session:SessionRef,expectedInput:string,marker:string){
 const thread=record(record(snapshot).thread);if(thread.id!==session.nativeConversationId||!['idle','notLoaded'].includes(String(record(thread.status).type))||!Array.isArray(thread.turns)||!expectedInput||!marker)return null;
 if(thread.turns.some(value=>!['completed','failed','interrupted'].includes(String(record(value).status))))return null;
 const matches=thread.turns.map(record).filter(turn=>{
  if(!Array.isArray(turn.items))return false;const inputs=turn.items.map(record).filter(item=>item.type==='userMessage');
  return inputs.length===1&&Array.isArray(inputs[0]?.content)&&inputs[0].content.map(value=>record(value).text??'').join('\n')===expectedInput;
 });
 if(matches.length!==1||matches[0]?.status!=='completed'||typeof matches[0].id!=='string')return null;
 const text=(matches[0].items as unknown[]).map(record).filter(item=>item.type==='agentMessage'&&typeof item.text==='string').map(item=>item.text).join('\n');
 if(!text.includes(marker))return null;
 return {session,executionId:matches[0].id,status:'completed' as const,terminalConfirmed:true as const,inputSha256:hash(expectedInput),responseSha256:hash(text)};
}

/** 官方只读thread/read；不start/resume轮次、不列线程、不搜索cwd、不发送模型输入。 */
export async function inspectCodexCharter(config:{executable:string;env:Readonly<Record<string,string>>;cwd:string},session:SessionRef,expectedInput:string,marker:string){
 const peer=new StdioPeer({executable:config.executable,args:['app-server'],cwd:config.cwd,env:config.env,timeoutMs:12000});
 try{await peer.ready;await peer.request('initialize',{clientInfo:{name:'projectorch_factory_readonly',version:'2'}});await peer.notify('initialized',{});return codexCharterProof(await peer.request('thread/read',{threadId:session.nativeConversationId,includeTurns:true}),session,expectedInput,marker);}
 catch{return null;}finally{await peer.close().catch(()=>undefined);}
}

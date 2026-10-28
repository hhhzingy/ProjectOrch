import type { SessionRef } from '@projectorch/adapter-contract';
import type { NativeExecutionOutcome } from '../execution/coordinator.js';
import { StdioPeer } from './stdio-peer.js';
import { zcodeHistoryTerminal } from './zcode-history-observation.js';

export async function inspectZcodeExecution(config:{executable:string;bundle:string;env:Readonly<Record<string,string>>;cwd:string},session:SessionRef,executionId:string):Promise<NativeExecutionOutcome>{
  const unknown={session,executionId,status:'unknown' as const,terminalConfirmed:false};
  const peer=new StdioPeer({executable:config.executable,args:[config.bundle,'app-server'],cwd:config.cwd,env:config.env,timeoutMs:7000});
  try{
    await peer.ready;
    await new Promise(resolve=>setTimeout(resolve,1200));
    const resumed=await peer.request('session/resume',{sessionId:session.nativeConversationId,workspace:{workspacePath:config.cwd,workspaceKey:config.cwd}}) as {sessionId?:string;session?:{sessionId?:string}};
    if((resumed.sessionId??resumed.session?.sessionId)!==session.nativeConversationId)return unknown;
    const snapshot=await peer.request('session/read',{sessionId:session.nativeConversationId,contentProfile:'index'});
    // 读取受限专用会话的历史，不向业务调用方或日志返回正文。历史不足保持unknown。
    const messages=await peer.request('session/messages',{sessionId:session.nativeConversationId,limit:200});
    const status=zcodeHistoryTerminal(snapshot,messages,session.nativeConversationId,executionId);
    return status?{session,executionId,status,terminalConfirmed:true}:unknown;
  }catch{return unknown;}finally{await peer.close().catch(()=>undefined);}
}

export async function inspectCodexExecution(config:{executable:string;env:Readonly<Record<string,string>>;cwd:string;configOverrides?:readonly string[]},session:SessionRef,executionId:string):Promise<NativeExecutionOutcome>{
  const unknown={session,executionId,status:'unknown' as const,terminalConfirmed:false};
  const args=[...(config.configOverrides??[]).flatMap(v=>['-c',v]),'app-server'];
  const peer=new StdioPeer({executable:config.executable,args,cwd:config.cwd,env:config.env,timeoutMs:7000});
  try{
    await peer.ready;await peer.request('initialize',{clientInfo:{name:'projectorch_readonly_observer',version:'2.0.0'}});await peer.notify('initialized',{});
    const response=await peer.request('thread/read',{threadId:session.nativeConversationId,includeTurns:true}) as {thread?:{id?:string;status?:{type?:string};turns?:{id?:string;status?:unknown}[]}};
    if(response.thread?.id!==session.nativeConversationId||!Array.isArray(response.thread.turns))return unknown;
    if(response.thread.status?.type==='active'||response.thread.turns.some(t=>!['completed','failed','interrupted'].includes(String(t.status))))return unknown;
    const matches=response.thread.turns.filter(t=>t.id===executionId);
    if(matches.length!==1||!['completed','failed','interrupted'].includes(String(matches[0]?.status)))return unknown;
    return {session,executionId,status:matches[0]!.status as 'completed'|'failed'|'interrupted',terminalConfirmed:true};
  }catch{return unknown;}finally{await peer.close().catch(()=>undefined);}
}

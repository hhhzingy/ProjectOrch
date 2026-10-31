import {randomUUID} from 'node:crypto';
import {StdioPeer,NativeRpcError} from './stdio-peer.js';
import {selectZcodeModel,type NativeModelSelection} from './model-selection.js';
import {NativeSessionLease} from './session-lease.js';
import type {ZCodeTextProcessOptions} from './zcode-text-process.js';
import type {FactoryOutcome,FactoryOperationStep} from '../execution/zcode-supervisor.js';

/** 空会话在一些官方环境中不跨进程保留；首轮必须在create/setModel的同连接完成，不能假定CLI可恢复。 */
export async function createSelectedZcodeSession(options:ZCodeTextProcessOptions,leaseDirectory:string,input:{charter:string;workspaceRoot:string;hostId:string;profileId:string;modelSelection:NativeModelSelection;assertCanSend?:()=>void;onStep:(s:FactoryOperationStep)=>void}):Promise<FactoryOutcome>{
 let sessionId:string|null=null,turnId:string|null=null,response='',floor=0,terminal=false,sent=false;
 const inputId=randomUUID(),epoch=randomUUID();let lease:NativeSessionLease|undefined;
 let resolveTurn:(()=>void)|undefined;const completed=new Promise<void>(resolve=>{resolveTurn=resolve;});let nativeStatus:string|null=null;
 const peer=new StdioPeer({executable:options.executable,args:[options.bundle,'app-server'],cwd:options.cwd,env:options.env,timeoutMs:20000,serverHandlers:new Map([['session/requestRuntimePreferences',()=>({nativeSearchEnhancementsEnabled:false,memoryEnabled:false,askUserQuestionAutoResolutionEnabled:false})]]),onNotification(method,raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return;const frame=raw as Record<string,unknown>;
  if(!sessionId||frame.sessionId!==sessionId||!sent)return;
  if(method==='session/event'){
   const p=frame.payload as Record<string,unknown>|undefined;
   if(p?.kind==='text_delta'&&typeof p.delta==='string'&&response.length<65536)response=(response+p.delta).slice(0,65536);
  }
  if(method!=='v4/telemetry/event'||!Number.isSafeInteger(frame.eventSeq)||Number(frame.eventSeq)<=floor)return;floor=Number(frame.eventSeq);
  if(frame.kind==='turn.started'&&frame.sourceCommandId===inputId&&typeof frame.turnId==='string')turnId=frame.turnId;
  if(frame.kind==='turn.terminal'&&turnId&&frame.turnId===turnId){nativeStatus=String(frame.status??frame.resultType??'unknown');terminal=['success','completed','failed','error','interrupted','cancelled'].includes(nativeStatus);resolveTurn?.();}
 }});
 const guard=()=>{input.assertCanSend?.();if(sessionId)lease?.assertCurrent({harnessId:'zcode',hostId:input.hostId,profileId:input.profileId,nativeConversationId:sessionId,nativeWorkspaceId:input.workspaceRoot});};
 let timeout:ReturnType<typeof setTimeout>|undefined;
 try{
  await peer.ready;await new Promise(r=>setTimeout(r,1200));guard();
  input.onStep({step:'create-session',state:'sent',detail:null,at:Date.now()});
  const raw=await peer.request('session/create',{workspace:{workspacePath:input.workspaceRoot,workspaceKey:input.workspaceRoot},titleGenerationEnabled:false,persistence:'immediate',toolAllowlist:[],mcpServers:[],dynamicWorkflowEnabled:false,offPeakToolEnabled:false},guard) as {sessionId?:string;session?:{sessionId?:string};id?:string};
  const ids=[raw.sessionId,raw.session?.sessionId,raw.id].filter(v=>v!==undefined);if(!ids.length||ids.some(v=>typeof v!=='string'||!v||v!==ids[0]))throw new NativeRpcError('FACTORY_SESSION_NOT_OBSERVED','uncertain');sessionId=ids[0]!;
  input.onStep({step:'create-session',state:'observed',detail:sessionId,at:Date.now()});
  const sessionRef={harnessId:'zcode',hostId:input.hostId,profileId:input.profileId,nativeConversationId:sessionId,nativeWorkspaceId:input.workspaceRoot};lease=NativeSessionLease.acquire(leaseDirectory,sessionRef);
  try{await selectZcodeModel(peer,sessionId,input.modelSelection,guard);}catch(e){if(e instanceof NativeRpcError&&e.delivery==='rejected')throw new NativeRpcError(`MODEL_SELECTION_REJECTED_${e.nativeCode??'RPC'}`,'not_sent');throw e;}
  const subscribed=await peer.request('session/subscribe',{sessionId,deliveryKind:'desktop-continuous',includeSnapshot:false,afterSeq:0},guard) as {sessionId?:string;eventSeq?:number};
  if(subscribed.sessionId!==sessionId||!Number.isSafeInteger(subscribed.eventSeq))throw new NativeRpcError('FACTORY_SUBSCRIPTION_NOT_PROVEN','not_sent');floor=Number(subscribed.eventSeq);
  const deadline=new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new NativeRpcError('FACTORY_TURN_UNKNOWN','uncertain')),options.timeoutMs??900000);});
  guard();input.onStep({step:'deliver-charter',state:'sent',detail:null,at:Date.now()});sent=true;
  await Promise.race([peer.request('session/send',{sessionId,content:input.charter,inputId},guard),deadline]);
  await Promise.race([completed,deadline,peer.exited.then(()=>{throw new NativeRpcError('FACTORY_TURN_UNKNOWN','uncertain');})]);
  if(!terminal||!turnId)throw new NativeRpcError('FACTORY_TURN_UNKNOWN','uncertain');
  if(!['success','completed'].includes(String(nativeStatus)))throw new NativeRpcError('FACTORY_TURN_FAILED','rejected');
  const read=await peer.request('session/read',{sessionId,contentProfile:'index'}) as {session?:{sessionId?:string;status?:string};settings?:{model?:{current?:{modelId?:string;providerId?:string;options?:{reasoningLevel?:string}}}}};
  const current=read.settings?.model?.current;
  if(read.session?.sessionId!==sessionId||read.session.status!=='idle'||!current?.modelId||(input.modelSelection.modelId&&current.modelId!==input.modelSelection.modelId)||(input.modelSelection.providerId&&current.providerId!==input.modelSelection.providerId)||(input.modelSelection.reasoningLevel&&current.options?.reasoningLevel!==input.modelSelection.reasoningLevel))throw new NativeRpcError('FACTORY_MODEL_SELECTION_UNCONFIRMED','uncertain');
  input.onStep({step:'deliver-charter',state:'observed',detail:turnId,at:Date.now()});input.onStep({step:'observe-effective-model',state:'observed',detail:`${current.providerId??'?'}/${current.modelId}`,at:Date.now()});
  await peer.close();if(!peer.diagnostics.exitConfirmed)throw new NativeRpcError('FACTORY_CHILD_EXIT_UNCONFIRMED','uncertain');lease.releaseAfterExit(true);lease=undefined;
  return {receipt:{protocol:'official_rpc',sessionId,turnId,status:'completed',response,exitConfirmed:true},sessionRef,processEpoch:epoch,nativeSessionId:sessionId,nativeTurnId:turnId,effectiveModel:{modelId:current.modelId,providerId:current.providerId??null}};
 }catch(error){
  input.onStep({step:sent?'deliver-charter':'create-session',state:error instanceof NativeRpcError&&error.delivery!=='uncertain'?'failed':'unknown',detail:error instanceof NativeRpcError?error.code:'FACTORY_SESSION_FAILED',at:Date.now()});
  await peer.close().catch(()=>undefined);
  if(lease&&error instanceof NativeRpcError&&((!sent&&error.delivery==='not_sent')||(terminal&&error.delivery==='rejected'))&&peer.diagnostics.exitConfirmed)lease.releaseAfterExit(true);
  throw error;
 }finally{clearTimeout(timeout);await peer.close().catch(()=>undefined);}
}

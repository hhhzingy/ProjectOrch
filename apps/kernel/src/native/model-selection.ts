import type { SessionRef } from '@projectorch/adapter-contract';
import { StdioPeer, NativeRpcError } from './stdio-peer.js';

export interface NativeModelSelection { readonly modelId:string|null; readonly reasoningLevel:string|null; readonly providerId?:string; }
/** 同一官方连接上的选择/读回，工厂可在任何模型输入之前调用。 */
export async function selectZcodeModel(peer:StdioPeer,sessionId:string,selection:NativeModelSelection,assertCurrent:()=>void):Promise<void>{
   const read=await peer.request('session/read',{sessionId,contentProfile:'index'}) as {session?:{sessionId?:string;status?:string};settings?:{model?:{current?:{providerId?:string;modelId?:string;options?:Record<string,unknown>};available?:{ref?:{providerId?:string;modelId?:string}}[]}}};
   if(read.session?.sessionId!==sessionId||read.session.status!=='idle')throw new NativeRpcError('MODEL_SESSION_NOT_IDLE','not_sent');
   let current=read.settings?.model?.current;
   if(!current?.providerId){
     const history=await peer.request('session/messages',{sessionId,limit:100}) as {messages?:{info?:{sessionID?:string;role?:string;providerId?:string;modelId?:string}}[]};
     const last=[...(history.messages??[])].reverse().find(m=>m.info?.sessionID===sessionId&&m.info.role==='assistant'&&m.info.providerId&&m.info.modelId)?.info;
     if(last)current={providerId:last.providerId!,modelId:last.modelId!};
   }
   let providerId=selection.providerId??current?.providerId;
   if(selection.modelId&&Array.isArray(read.settings?.model?.available)){
     const matches=read.settings.model.available.map(entry=>entry.ref).filter(ref=>ref?.modelId===selection.modelId&&typeof ref.providerId==='string'&&(!selection.providerId||ref.providerId===selection.providerId));
     if(!matches.length)throw new NativeRpcError('MODEL_SELECTION_UNAVAILABLE','not_sent');
     const providers=[...new Set(matches.map(ref=>ref!.providerId!))];
     if(providers.includes(providerId??''))providerId=providerId!;
     else if(providers.length===1)providerId=providers[0];
     else throw new NativeRpcError('MODEL_PROVIDER_AMBIGUOUS','not_sent');
   }
   const modelId=selection.modelId??current?.modelId;
   const model={providerId,modelId,options:{...(providerId===current?.providerId&&modelId===current?.modelId?current?.options:{}),...(selection.reasoningLevel?{reasoningLevel:selection.reasoningLevel}:{})}};
   if(!model.providerId||!model.modelId)throw new NativeRpcError('MODEL_SELECTION_UNRESOLVED','not_sent');
   await peer.request('session/setModel',{sessionId,model},assertCurrent);
   const verify=await peer.request('session/read',{sessionId,contentProfile:'index'}) as typeof read,effective=verify.settings?.model?.current;
   if(verify.session?.sessionId!==sessionId||verify.session.status!=='idle'||effective?.modelId!==model.modelId||effective?.providerId!==model.providerId||(selection.reasoningLevel&&effective?.options?.reasoningLevel!==selection.reasoningLevel))throw new NativeRpcError('MODEL_SELECTION_NOT_APPLIED','not_sent');
   assertCurrent();
}
export async function applyZcodeModelSelection(config:{executable:string;bundle:string;cwd:string;env:Readonly<Record<string,string>>},session:SessionRef,selection:NativeModelSelection,assertCurrent:()=>void):Promise<void>{
 const peer=new StdioPeer({executable:config.executable,args:[config.bundle,'app-server'],cwd:config.cwd,env:config.env,timeoutMs:7000});
 let phase='READY';
 try{
   await peer.ready;await new Promise(r=>setTimeout(r,1200));assertCurrent();
   phase='RESUME';await peer.request('session/resume',{sessionId:session.nativeConversationId,workspace:{workspacePath:config.cwd,workspaceKey:config.cwd}});
   phase='READ';
   await selectZcodeModel(peer,session.nativeConversationId,selection,assertCurrent);
 }catch(e){if(e instanceof NativeRpcError&&e.delivery==='not_sent')throw e;const reason=e instanceof NativeRpcError?`${e.nativeCode??'RPC'}_${e.category??'REJECTED'}`:e instanceof Error&&/^MODEL_[A-Z_]+$/.test(e.message)?e.message:'UNAVAILABLE';throw new NativeRpcError(`MODEL_SELECTION_${phase}_${reason}`,'not_sent');}
 finally{await peer.close().catch(()=>undefined);}
}

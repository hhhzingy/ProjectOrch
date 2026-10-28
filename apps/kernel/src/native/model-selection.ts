import type { SessionRef } from '@projectorch/adapter-contract';
import { StdioPeer, NativeRpcError } from './stdio-peer.js';

export interface NativeModelSelection { readonly modelId:string|null; readonly reasoningLevel:string|null; readonly providerId?:string; }
export async function applyZcodeModelSelection(config:{executable:string;bundle:string;cwd:string;env:Readonly<Record<string,string>>},session:SessionRef,selection:NativeModelSelection,assertCurrent:()=>void):Promise<void>{
 const peer=new StdioPeer({executable:config.executable,args:[config.bundle,'app-server'],cwd:config.cwd,env:config.env,timeoutMs:7000});
 let phase='READY';
 try{
   await peer.ready;await new Promise(r=>setTimeout(r,1200));assertCurrent();
   phase='RESUME';await peer.request('session/resume',{sessionId:session.nativeConversationId,workspace:{workspacePath:config.cwd,workspaceKey:config.cwd}});
   phase='READ';
   const read=await peer.request('session/read',{sessionId:session.nativeConversationId,contentProfile:'index'}) as {session?:{sessionId?:string;status?:string};settings?:{model?:{current?:{providerId?:string;modelId?:string;options?:Record<string,unknown>}}}};
   if(read.session?.sessionId!==session.nativeConversationId||read.session.status!=='idle')throw new Error('MODEL_SESSION_NOT_IDLE');
   let current=read.settings?.model?.current;
   if(!current?.providerId){
     // 未运行模型的只读app-server可能未物化current；仅用该会话官方历史的实际provider，不读认证配置或猜供应商。
     const history=await peer.request('session/messages',{sessionId:session.nativeConversationId,limit:100}) as {messages?:{info?:{sessionID?:string;role?:string;providerId?:string;modelId?:string}}[]};
     const last=[...(history.messages??[])].reverse().find(m=>m.info?.sessionID===session.nativeConversationId&&m.info.role==='assistant'&&m.info.providerId&&m.info.modelId)?.info;
     if(last)current={providerId:last.providerId!,modelId:last.modelId!};
   }
   const model={providerId:selection.providerId??current?.providerId,modelId:selection.modelId??current?.modelId,options:{...current?.options,...(selection.reasoningLevel?{reasoningLevel:selection.reasoningLevel}:{})}};
   if(!model.providerId||!model.modelId)throw new Error('MODEL_SELECTION_UNRESOLVED');
   phase='SET';await peer.request('session/setModel',{sessionId:session.nativeConversationId,model},assertCurrent);
   phase='VERIFY';
   const verify=await peer.request('session/read',{sessionId:session.nativeConversationId,contentProfile:'index'}) as typeof read;
   const effective=verify.settings?.model?.current;
   if(verify.session?.sessionId!==session.nativeConversationId||effective?.modelId!==model.modelId||effective?.providerId!==model.providerId||(selection.reasoningLevel&&effective?.options?.reasoningLevel!==selection.reasoningLevel))throw new Error('MODEL_SELECTION_NOT_APPLIED');
 }catch(e){if(e instanceof NativeRpcError&&e.delivery==='not_sent')throw e;const reason=e instanceof NativeRpcError?`${e.nativeCode??'RPC'}_${e.category??'REJECTED'}`:e instanceof Error&&/^MODEL_[A-Z_]+$/.test(e.message)?e.message:'UNAVAILABLE';throw new NativeRpcError(`MODEL_SELECTION_${phase}_${reason}`,'not_sent');}
 finally{await peer.close().catch(()=>undefined);}
}

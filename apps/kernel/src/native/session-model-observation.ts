/** 只采纳指定会话的明确current字段；模型目录/历史正文中的modelId不能证明当前模型。 */
function record(value:unknown):Record<string,unknown>{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
function identifier(value:unknown,max:number):string|null{return typeof value==='string'&&value.length>0&&value.length<=max&&!/[\r\n\0]/.test(value)?value:null;}
export interface ZcodeSessionModelObservation {readonly sessionId:string;readonly model:{readonly modelId:string;readonly providerId:string|null;readonly reasoningLevel:string|null}|null;}
export function zcodeSessionModelObservation(resumed:unknown,snapshot:unknown,expectedSessionId:string):ZcodeSessionModelObservation|null{
 const resume=record(resumed),read=record(snapshot);
 const ids=[resume.sessionId,record(resume.session).sessionId,resume.id].filter(v=>v!==undefined);
 if(!identifier(expectedSessionId,512)||!ids.length||ids.some(v=>v!==expectedSessionId)||record(read.session).sessionId!==expectedSessionId)return null;
 const current=record(record(record(read.settings).model).current),modelId=identifier(current.modelId,128);
 if(!modelId)return {sessionId:expectedSessionId,model:null};
 const providerId=current.providerId===undefined||current.providerId===null?null:identifier(current.providerId,256);
 if(current.providerId!==undefined&&current.providerId!==null&&!providerId)return null;
 const reasoningLevel=identifier(record(current.options).reasoningLevel,32);
 return {sessionId:expectedSessionId,model:{modelId,providerId,reasoningLevel}};
}

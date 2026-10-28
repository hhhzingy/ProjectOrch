import {canonicalJson} from '@projectorch/persistence/outbox';
import {isWellFormedRelativePath} from '@projectorch/domain/policy';

export const jsonAssertionSchemaId='projectorch.check.json-assertions.v1';
export interface JsonAssertionParameters {readonly files:readonly {readonly path:string;readonly assertions:readonly {readonly pointer:string;readonly equals:unknown}[]}[];}

/** 固定纯数据参数；不编译模型给出的表达式、正则或脚本，不接收shell参数。 */
export function jsonAssertionParameters(input:unknown):JsonAssertionParameters{
 if(Buffer.byteLength(canonicalJson(input),'utf8')>65536)throw Error('CHECK_PARAMETERS_TOO_LARGE');
 const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('CHECK_PARAMETERS_INVALID');return value as Record<string,unknown>;};
 const p=object(input);if(Object.keys(p).some(k=>k!=='files')||!Array.isArray(p.files)||p.files.length<1||p.files.length>16)throw Error('CHECK_PARAMETERS_INVALID');
 const seen=new Set<string>();let count=0;
 for(const item of p.files){const file=object(item);if(Object.keys(file).some(k=>!['path','assertions'].includes(k))||typeof file.path!=='string'||!isWellFormedRelativePath(file.path)||seen.has(file.path)||!Array.isArray(file.assertions)||!file.assertions.length)throw Error('CHECK_PARAMETERS_INVALID');seen.add(file.path);
  for(const value of file.assertions){const assertion=object(value);if(++count>64||Object.keys(assertion).some(k=>!['pointer','equals'].includes(k))||!Object.hasOwn(assertion,'equals')||typeof assertion.pointer!=='string'||assertion.pointer.length>1024||assertion.pointer!==''&&!assertion.pointer.startsWith('/')||/~(?:[^01]|$)/.test(assertion.pointer))throw Error('CHECK_PARAMETERS_INVALID');}
 }
 return p as unknown as JsonAssertionParameters;
}

/** 仅消费内核提供的冻结字节，输出只含位置和结果，不回显目标值或期望值。 */
export function runJsonAssertions(files:ReadonlyMap<string,Uint8Array>,input:unknown,deadline:number){
 const parameters=jsonAssertionParameters(input),results:{file:string;assertion:number;outcome:'passed'|'failed';code:string}[]=[];
 for(const file of parameters.files){
  if(Date.now()>deadline)throw Error('CHECK_TIMEOUT');const bytes=files.get(file.path);if(!bytes||bytes.length>1024*1024)throw Error('CHECK_TARGET_FILE_UNAVAILABLE');
  let document:unknown;try{document=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw Error('CHECK_TARGET_JSON_INVALID');}
  for(const [index,assertion] of file.assertions.entries()){
   if(Date.now()>deadline)throw Error('CHECK_TIMEOUT');let value=document,found=true;
   for(const key of assertion.pointer===''?[]:assertion.pointer.slice(1).split('/').map(k=>k.replaceAll('~1','/').replaceAll('~0','~'))){if(value===null||typeof value!=='object'||!Object.hasOwn(value,key)){found=false;break;}value=(value as Record<string,unknown>)[key];}
   const passed=found&&canonicalJson(value)===canonicalJson(assertion.equals);results.push({file:file.path,assertion:index,outcome:passed?'passed':'failed',code:passed?'JSON_ASSERTION_MATCH':found?'JSON_ASSERTION_MISMATCH':'JSON_POINTER_NOT_FOUND'});
  }
 }
 return {outcome:results.every(r=>r.outcome==='passed')?'passed' as const:'failed' as const,results};
}

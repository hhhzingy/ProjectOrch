import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,unlinkSync,rmdirSync} from 'node:fs';
import path from 'node:path';
import type {NativeModelSelection} from './model-selection.js';
import {NativeRpcError} from './stdio-peer.js';

/** 官方 app-server 不自行加载账户；账户 CLI 使用独立个人配置，不能复制含密钥的用户个人配置。 */
export const accountProviderEnv='PROJECTORCH_ZCODE_ACCOUNT_PROVIDER';
export function usesZcodeAccountProfile(env:Readonly<Record<string,string>>,selection:NativeModelSelection):boolean{
 return !!(selection.providerId?.startsWith('account:')||env[accountProviderEnv]);
}
type Provider={providerId:string;config:{builtinModelIds:string[];access?:{type?:string;mode?:string}}};
export function prepareZcodeAccountProfile(env:Readonly<Record<string,string>>,directory:string,selection:NativeModelSelection){
 const providerId=selection.providerId??env[accountProviderEnv];
 if(!providerId||!selection.modelId)throw new NativeRpcError('MODEL_ACCOUNT_PROVIDER_REQUIRED','not_sent');
 if(selection.reasoningLevel)throw new NativeRpcError('MODEL_ACCOUNT_REASONING_UNVERIFIED','not_sent');
 // 当前官方 standalone CLI 只实现 individual-coding-plan 的登录和请求；不能伪造 Start Plan 权限。
 if(!/^account:(bigmodel|zai)-individual-coding-plan$/.test(providerId))throw new NativeRpcError('MODEL_ACCOUNT_CLI_PROVIDER_UNSUPPORTED','not_sent');
 const source=env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
 if(!source||!path.isAbsolute(source)||path.basename(source)!=='zcode-builtin.json')throw new NativeRpcError('MODEL_BUILTIN_METADATA_REQUIRED','not_sent');
 let bytes:Buffer,providers:Provider[];
 try{
  bytes=readFileSync(source);if(bytes.length>4*1024*1024)throw Error();
  const doc=JSON.parse(bytes.toString('utf8'));providers=doc.config.providerConfigRules.providerRules;
  if(doc.schemaVersion!==1||!Array.isArray(providers)||!providers.length||providers.some(p=>typeof p.providerId!=='string'||!Array.isArray(p.config?.builtinModelIds)||p.config.builtinModelIds.some(m=>typeof m!=='string')))throw Error();
  const rejectSecrets=(v:unknown):void=>{if(!v||typeof v!=='object')return;for(const[k,x]of Object.entries(v)){if(/^(apiKey|password|secret|accessToken|refreshToken|authorization)$/i.test(k)&&x)throw Error();rejectSecrets(x);}};rejectSecrets(doc);
 }catch{throw new NativeRpcError('MODEL_BUILTIN_METADATA_INVALID','not_sent');}
 const target=providers.find(p=>p.providerId===providerId);
 if(target?.config.access?.type!=='zhipu-account'||target.config.access.mode!=='individual-coding-plan'||!target.config.builtinModelIds.includes(selection.modelId))throw new NativeRpcError('MODEL_SELECTION_UNAVAILABLE','not_sent');
 const personal=JSON.stringify({schemaVersion:1,config:{providerOrder:[providerId],providerConfigRules:{providerRules:providers.map(p=>({providerId:p.providerId,enabled:p.providerId===providerId,config:{}}))},modelConfigRules:{providerModelRules:providers.flatMap(p=>p.config.builtinModelIds.map(modelId=>({providerId:p.providerId,modelId,config:{enabled:p.providerId===providerId&&modelId===selection.modelId}}))),manualProviderModelRules:[]},defaultModelSelection:{providerId,modelId:selection.modelId,...(selection.reasoningLevel?{options:{reasoningLevel:selection.reasoningLevel}}:{})}}});
 mkdirSync(directory,{recursive:true});const own=mkdtempSync(path.join(directory,'zcode-model-')),builtinFile=path.join(own,'zcode-builtin.json'),personalFile=path.join(own,'personal.json');
 const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex'),builtinHash=hash(bytes),personalHash=hash(personal);
 const cleanup=()=>{for(const p of [personalFile,builtinFile])try{unlinkSync(p);}catch{}try{rmdirSync(own);}catch{}};
 try{writeFileSync(builtinFile,bytes,{flag:'wx'});writeFileSync(personalFile,personal,{flag:'wx'});}catch(e){cleanup();throw e;}
 const childEnv:Record<string,string>={...env,ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:builtinFile,ZCODE_PERSONAL_PROVIDER_CONFIG_FILE:personalFile};
 // 固定未改动的官方元数据，避免 CDN 更新在核验与发送之间引入可回退模型。
 delete childEnv.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE;delete childEnv[accountProviderEnv];
 return {env:childEnv,providerId,modelId:selection.modelId,cleanup,assertCurrent(){if(hash(readFileSync(builtinFile))!==builtinHash||hash(readFileSync(personalFile))!==personalHash)throw new NativeRpcError('MODEL_PROFILE_CHANGED','not_sent');}};
}

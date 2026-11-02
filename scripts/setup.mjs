/** AI/用户一次配置入口。无依赖；不读取 Harness 认证，不创建原生会话，不调用模型。 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const help=`ProjectOrch 安装配置工具（Setup）
用法：node scripts/setup.mjs <discover|init|check|mcp-config> [选项]
  --data-dir <绝对路径>             与 start.cmd 相同的数据目录
  --native <native-config.json路径> check 指定配置；不读取 auth/provider 配置
  --codex-executable <codex.exe>    init 使用的官方程序
  --share-codex-login               init 显式复用当前用户正常登录环境
  --zcode-bundle <zcode.cjs>        init 使用的官方 CLI 入口
  --zcode-node <node.exe>           init 可选，默认当前 Node
  --zcode-account-provider <ID>     init 可选：account:bigmodel-individual-coding-plan 或 account:zai-individual-coding-plan
  --zcode-data-dir <绝对路径>       init 可选，默认由内核发现标准 SPB_Data
  --zcode-install-dir <绝对路径>    discover 的额外官方安装位置
  --probe-native                   check 仅执行已配置官方程序 --version，零模型输入
  --probe-mcp                      check 通过本机桥调用 tools/list 和 identity，零模型输入
  --format <codex|zcode|zcode-ui>   mcp-config 格式；仅输出片段，不修改官方配置
  --json                           机器可读报告；退出码 0=配置检查无失败，2=失败
init 仅首次创建 native-config.json，已有文件拒绝覆盖。check/discover/mcp-config 不写文件。
静态或版本检查不证明登录、模型权益、额度或真实协作成功。`;
const fail=code=>{throw new Error(code);};
const switches=new Set(['json','share-codex-login','probe-native','probe-mcp']);
const allowed={discover:['zcode-install-dir','json'],init:['data-dir','codex-executable','share-codex-login','zcode-bundle','zcode-node','zcode-account-provider','zcode-data-dir','json'],check:['data-dir','native','probe-native','probe-mcp','json'],'mcp-config':['data-dir','format','json']};
function args(input){
 const command=input[0]??'help',options={};if(['help','--help','-h'].includes(command))return {command:'help',options};
 if(!allowed[command])fail('UNKNOWN_COMMAND');
 for(let i=1;i<input.length;i++){const key=input[i]?.slice(2);if(!input[i]?.startsWith('--')||!allowed[command].includes(key)||Object.hasOwn(options,key))fail('INVALID_OR_DUPLICATE_OPTION');
  if(switches.has(key))options[key]=true;else{const value=input[++i];if(!value||value.startsWith('--'))fail('OPTION_VALUE_REQUIRED');options[key]=value;}}
 return {command,options};
}
const local=value=>{if(typeof value!=='string'||!path.isAbsolute(value)||/^(?:\\\\|\/\/)/.test(value)||/[\r\n\0<>]/.test(value))fail('ABSOLUTE_LOCAL_PATH_REQUIRED');return path.resolve(value);};
const defaultData=env=>path.join(env.LOCALAPPDATA??path.join(os.homedir(),'.local','share'),'ProjectOrch');
const ordinaryFile=file=>{try{const stat=fs.lstatSync(file);return stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1;}catch{return false;}};
function ensureNoLinks(target){for(let cursor=target;;cursor=path.dirname(cursor)){if(fs.existsSync(cursor)&&fs.lstatSync(cursor).isSymbolicLink())fail('CONFIG_PATH_REPARSE_REFUSED');if(path.dirname(cursor)===cursor)break;}}
function loadConfig(file){
 // 只允许明确的无密钥原生配置文件，拒绝把 auth.json 等作为检查输入。
 if(!/^native-config(?:\.example)?\.json$/i.test(path.basename(file)))fail('NATIVE_CONFIG_FILENAME_REQUIRED');
 ensureNoLinks(file);if(!ordinaryFile(file)||fs.statSync(file).size>262144)fail('CONFIG_FILE_UNSAFE_OR_MISSING');
 let raw;try{raw=JSON.parse(fs.readFileSync(file,'utf8'));}catch{fail('CONFIG_INVALID_JSON_UTF8_NO_BOM_REQUIRED');}
 const secretKeys=/^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|authorization|bearer|auth|credentials|token)$/i;
 const visit=(v,depth=0)=>{if(depth>16)fail('CONFIG_TOO_DEEP');if(v&&typeof v==='object')for(const [k,x]of Object.entries(v)){if(secretKeys.test(k))fail('INLINE_AUTHENTICATION_FORBIDDEN');visit(x,depth+1);}};visit(raw);
 if(!raw||typeof raw!=='object'||Array.isArray(raw))fail('CONFIG_OBJECT_REQUIRED');
 const keys=(v,list)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!list.includes(k)))fail('CONFIG_UNKNOWN_FIELD');};
 keys(raw,['_comment','codex','zcode','zcodeEnv','leaseDirectory','workspaceRoot']);
 if(raw.codex!==undefined)keys(raw.codex,['executable','sharedLogin','executionTimeoutMs','timeoutMs','rpcTimeoutMs']);
 if(raw.zcode!==undefined)keys(raw.zcode,['executable','bundle','executionTimeoutMs','timeoutMs']);
 if(raw.zcodeEnv!==undefined){keys(raw.zcodeEnv,['ZCODE_DATA_BASE_DIR','ZCODE_BUILTIN_PROVIDER_CONFIG_FILE','ZCODE_PERSONAL_PROVIDER_CONFIG_FILE','ZCODE_BASE_URL','ZCODE_ENV','PROJECTORCH_ZCODE_ACCOUNT_PROVIDER']);if(Object.values(raw.zcodeEnv).some(v=>typeof v!=='string'))fail('CONFIG_ENV_STRING_REQUIRED');}
 return raw;
}
function nativeChecks(raw,add){
 const file=(value,code)=>{let good=false;try{good=ordinaryFile(local(value));}catch{}add(code,good?'PASS':'FAIL',good?'已找到普通本地程序/入口文件。':'请填入存在的绝对本地文件路径，不能用占位符、链接或命令名称。');};
 for(const name of ['leaseDirectory','workspaceRoot'])if(raw[name]!==undefined){try{local(raw[name]);ensureNoLinks(raw[name]);add(name.toUpperCase(),'PASS','本地绝对路径。');}catch{add(name.toUpperCase(),'FAIL','需要无链接的绝对本地目录。');}}
 for(const name of ['codex','zcode']){
  const value=raw[name];if(value===undefined){add(name.toUpperCase()+'_NOT_CONFIGURED','WARN','未接入该 Harness；不会自动创建对应会话。');continue;}
  file(value.executable,name.toUpperCase()+'_EXECUTABLE');if(name==='zcode')file(value.bundle,'ZCODE_BUNDLE');
  const duration=value.executionTimeoutMs??value.timeoutMs??900000;
  if(!Number.isSafeInteger(duration)||duration<1||duration>1800000||value.executionTimeoutMs!==undefined&&value.timeoutMs!==undefined&&value.executionTimeoutMs!==value.timeoutMs)add(name.toUpperCase()+'_TIMEOUT','FAIL','执行时限需为1至1800000毫秒，旧新字段不能冲突。');
  if(name==='codex'){
   if(value.sharedLogin!==undefined&&typeof value.sharedLogin!=='boolean')add('CODEX_SHARED_LOGIN','FAIL','sharedLogin 必须是布尔值。');
   else add('CODEX_SHARED_LOGIN',value.sharedLogin===true?'PASS':'WARN',value.sharedLogin===true?'将复用当前用户登录环境；未读取认证。':'未开启登录复用；默认隔离环境不会继承正常登录。');
   const rpc=value.rpcTimeoutMs??20000;if(!Number.isSafeInteger(rpc)||rpc<1||rpc>60000)add('CODEX_RPC_TIMEOUT','FAIL','RPC时限需为1至60000毫秒。');
  }
 }
 const env=raw.zcodeEnv??{};
 for(const key of ['ZCODE_DATA_BASE_DIR','ZCODE_BUILTIN_PROVIDER_CONFIG_FILE','ZCODE_PERSONAL_PROVIDER_CONFIG_FILE'])if(env[key]){
  try{const target=local(env[key]);add(key,fs.existsSync(target)?'PASS':'FAIL','仅检查配置指向的路径是否存在；不读取供应商配置或认证内容。');}catch{add(key,'FAIL','需要存在的绝对本地路径。');}}
 if(env.PROJECTORCH_ZCODE_ACCOUNT_PROVIDER&&!/^account:(bigmodel|zai)-individual-coding-plan$/.test(env.PROJECTORCH_ZCODE_ACCOUNT_PROVIDER))add('ZCODE_ACCOUNT_PROVIDER','FAIL','本接入账户路径仅支持已实现的 BigModel/Z.ai individual-coding-plan；不能将 Start Plan 等同此路径。');
 if(env.ZCODE_BASE_URL){try{const url=new URL(env.ZCODE_BASE_URL);if(url.username||url.password||url.search||url.hash||url.protocol!=='https:')throw Error();add('ZCODE_BASE_URL','PASS','HTTPS产品地址不含内嵌凭据。');}catch{add('ZCODE_BASE_URL','FAIL','产品地址须为不含凭据/查询参数的HTTPS地址。');}}
 if(!raw.codex&&!raw.zcode)add('NO_NATIVE_HARNESS','WARN','仅能运行本地控制台，尚未配置原生执行端。');
}
function discover(root,env,extra){
 const codex=[],zcode=[];const home=env.LOCALAPPDATA;
 const bin=home&&path.join(home,'OpenAI','Codex','bin');
 if(bin&&fs.existsSync(bin)){for(const name of fs.readdirSync(bin).slice(0,256)){const p=path.join(bin,name,'codex.exe');if(ordinaryFile(p))codex.push(p);}}
 for(const dir of [extra,home&&path.join(home,'Programs','ZCode'),home&&path.join(home,'Programs','zcode'),env.ProgramFiles&&path.join(env.ProgramFiles,'ZCode')].filter(Boolean))for(const relative of ['resources/glm/zcode.cjs','resources/app/glm/zcode.cjs']){const p=path.join(dir,relative);if(ordinaryFile(p))zcode.push(p);}
 return {kind:'ProjectOrch setup discovery',codexExecutables:[...new Set(codex)].sort(),zcodeBundles:[...new Set(zcode)].sort(),suggestedNode:process.execPath,defaultDataDirectory:defaultData(env),authentication:'NOT_READ_OR_VERIFIED',note:'有限标准目录发现，不扫描整盘，不自动选择多个候选，也不读取认证。可显式指定其他安装路径。'};
}
export async function runSetup(input,{root=ROOT,env=process.env}={}){
 const {command,options:o}=args(input);if(command==='help')return {output:help,exitCode:0};
 const data=local(o['data-dir']??defaultData(env));
 if(command==='discover')return {report:discover(root,env,o['zcode-install-dir']?local(o['zcode-install-dir']):null),exitCode:0};
 if(command==='mcp-config'){
  const node=ordinaryFile(path.join(root,'runtime/node.exe'))?path.join(root,'runtime/node.exe'):process.execPath,bridge=path.join(root,'scripts/mcp-control-bridge.mjs');if(!ordinaryFile(bridge))fail('CONTROL_BRIDGE_MISSING');
  const entry={command:node,args:[bridge,'--data-dir',data]},format=o.format??'codex';let output;
  if(format==='codex')output=`[mcp_servers.projectorch]\ncommand = ${JSON.stringify(node.replaceAll('\\','/'))}\nargs = ${JSON.stringify(entry.args.map(x=>x.replaceAll('\\','/')))}\n`;
  else if(format==='zcode')output=JSON.stringify({mcp:{servers:{projectorch:entry}}},null,2);
  else if(format==='zcode-ui')output=JSON.stringify({projectorch:entry},null,2);else fail('UNKNOWN_MCP_FORMAT');
  return {output,report:{kind:'ProjectOrch MCP configuration snippet',format,entry,codexCliArgs:['mcp','add','projectorch','--',node,...entry.args],configurationFilesModified:false,containsCredentials:false},exitCode:0};
 }
 if(command==='init'){
  const config={};
  if(o['codex-executable'])config.codex={executable:local(o['codex-executable']),sharedLogin:o['share-codex-login']===true,executionTimeoutMs:900000,rpcTimeoutMs:20000};
  if(o['share-codex-login']&&!config.codex)fail('CODEX_EXECUTABLE_REQUIRED');
  if(o['zcode-bundle'])config.zcode={executable:local(o['zcode-node']??process.execPath),bundle:local(o['zcode-bundle']),executionTimeoutMs:900000};
  if(!config.zcode&&(o['zcode-node']||o['zcode-account-provider']||o['zcode-data-dir']))fail('ZCODE_BUNDLE_REQUIRED');
  if(o['zcode-account-provider']||o['zcode-data-dir'])config.zcodeEnv={...(o['zcode-account-provider']?{PROJECTORCH_ZCODE_ACCOUNT_PROVIDER:o['zcode-account-provider']}:{}),...(o['zcode-data-dir']?{ZCODE_DATA_BASE_DIR:local(o['zcode-data-dir'])}:{})};
  if(!config.codex&&!config.zcode)fail('HARNESS_PATH_REQUIRED');
  const checks=[];nativeChecks(config,(code,status,message)=>checks.push({code,status,message}));if(checks.some(c=>c.status==='FAIL'))return {report:{status:'FAIL',checks,filesWritten:0},exitCode:2};
  ensureNoLinks(data);const file=path.join(data,'native-config.json');if(fs.existsSync(file))fail('CONFIG_EXISTS_NOT_OVERWRITTEN');
  fs.mkdirSync(data,{recursive:true});const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(config,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  return {report:{status:'CREATED',configPath:file,filesWritten:1,authentication:'NOT_READ_OR_VERIFIED',checks},exitCode:0};
 }
 const checks=[],add=(code,status,message,details)=>checks.push({code,status,message,...(details?{details}:{})});
 const version=process.versions.node.split('.').map(Number);add('NODE_RUNTIME',version[0]===24&&version[1]>=14?'PASS':'FAIL','需要 Node.js 24.14+ 的24系列；Windows ZIP附带24.22.0。');
 const file=local(o.native??path.join(data,'native-config.json'));let raw;
 try{raw=loadConfig(file);add('NATIVE_CONFIG','PASS','原生配置结构可读，不含内嵌认证字段。');nativeChecks(raw,add);
  if(raw.zcode&&!raw.zcodeEnv?.ZCODE_DATA_BASE_DIR){const base=path.join(env.APPDATA??path.join(os.homedir(),'AppData','Roaming'),'SPB_Data');add('ZCODE_STANDARD_DATA_DIRECTORY',fs.existsSync(base)?'PASS':'WARN','仅检查标准SPB_Data目录存在；自定义位置请显式指定，未验证登录。');}
 }catch(error){add('NATIVE_CONFIG','FAIL','未读取认证；配置检查失败。',{code:/^[A-Z0-9_]+$/.test(error.message)?error.message:'CONFIG_CHECK_FAILED'});}
 for(const [relative,code]of [['apps/kernel/dist/main.js','KERNEL_BUILT'],['apps/web/dist/index.html','WEB_BUILT'],['scripts/mcp-control-bridge.mjs','CONTROL_BRIDGE']])add(code,ordinaryFile(path.join(root,relative))?'PASS':'FAIL','检查当前安装/构建入口文件。');
 if(o['probe-native']&&raw&&!checks.some(c=>c.status==='FAIL'))for(const name of ['codex','zcode'])if(raw[name]){
  const native=raw[name],probe=spawnSync(native.executable,name==='zcode'?[native.bundle,'--version']:['--version'],{env:Object.fromEntries(Object.entries(env).filter(([k])=>['SYSTEMROOT','WINDIR','PATH','PATHEXT','COMSPEC','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','HOME','CODEX_HOME'].includes(k.toUpperCase()))),encoding:'utf8',timeout:15000,maxBuffer:65536,windowsHide:true});
  const match=probe.status===0&&/\b(v?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)\b/.exec(probe.stdout??'');add(name.toUpperCase()+'_VERSION_PROBE',match?'PASS':'FAIL',match?'官方程序版本命令返回；不代表登录或模型可用。':'版本探针失败/超时；未发送模型输入，原始输出不展示。',match?{version:match[1]}:undefined);
 }
 if(o['probe-mcp']){
  try{
   const {createControlBridge}=await import('./mcp-control-bridge.mjs'),bridge=createControlBridge(data);
   const init=await bridge({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'projectorch-setup-check',version:'1'}}});if(init?.error||!init?.result)throw Error();
   await bridge({jsonrpc:'2.0',method:'notifications/initialized',params:{}});
   const list=await bridge({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});if(!list?.result?.tools?.some(x=>x.name==='projectorch_identity'))throw Error();
   const reply=await bridge({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'projectorch_identity',arguments:{}}});if(reply?.error||!reply?.result||reply.result.isError)throw Error();
   const identity=JSON.parse(reply.result.content?.find(c=>c.type==='text')?.text??'null');if(identity?.kind!=='control_entry')throw Error();
   add('LOCAL_MCP_IDENTITY','PASS','本数据目录的控制桥完成握手、工具发现和identity调用；零模型输入，不打印控制凭据或返回正文。');
  }catch{add('LOCAL_MCP_IDENTITY','FAIL','无法连接本数据目录的内核控制入口；先正常启动内核，核对数据目录。不得复制控制令牌或盲目重发业务。');}
 }
 add('ACCOUNT_AND_MODEL_ACCESS','NOT_VERIFIED','未检查或读取Harness认证，未调用模型；登录、供应商权益及额度需官方登录和经授权的实际测试确认。');
 return {report:{schemaVersion:1,kind:'ProjectOrch configuration check',status:checks.some(c=>c.status==='FAIL')?'FAIL':checks.some(c=>c.status==='WARN')?'WARN':'PASS_CONFIGURATION_ONLY',dataDirectory:data,configPath:file,checks,nativeModelInputs:0,nativeSessionsCreated:0,existingFilesModified:false},exitCode:checks.some(c=>c.status==='FAIL')?2:0};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const result=await runSetup(process.argv.slice(2));const json=process.argv.includes('--json');
  if(json&&result.report)console.log(JSON.stringify(result.report,null,2));else if(result.output)console.log(result.output);else{console.log(result.report.status??result.report.kind);for(const c of result.report.checks??[])console.log(`[${c.status}] ${c.code}: ${c.message}`);if(result.report.configPath)console.log('配置文件：'+result.report.configPath);if(result.report.codexExecutables)console.log(JSON.stringify(result.report,null,2));}process.exitCode=result.exitCode;
 }catch(error){console.log(JSON.stringify({status:'FAIL',code:/^[A-Z0-9_]+$/.test(error.message)?error.message:'SETUP_FAILED',nativeModelInputs:0}));process.exitCode=2;}
}

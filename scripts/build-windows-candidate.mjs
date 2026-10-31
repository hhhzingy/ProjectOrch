/** 私有Windows候选，不执行安装、不公开发布、不选定本项目许可证。 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {zipSync,unzipSync,strToU8,strFromU8} from 'fflate';

const ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const sha=b=>createHash('sha256').update(b).digest('hex');
const safe=p=>typeof p==='string'&&p.length>0&&p.length<500&&!/[\\:<>"|?*]/.test(p)&&![...p].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127)&&!p.startsWith('/')&&p.split('/').every(v=>v!=='.'&&v!=='..'&&v!==''&&!/[. ]$/.test(v)&&! /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(v));
const frozenTime=new Date('2026-10-18T00:00:00Z');
const release=JSON.parse(fs.readFileSync(path.join(ROOT,'PUBLIC_RELEASE.json'),'utf8'));if(release.license!=='Apache-2.0')throw Error('APACHE_RELEASE_METADATA_REQUIRED');
function walk(directory){
 const rootStat=fs.lstatSync(directory);if(rootStat.isSymbolicLink()||!rootStat.isDirectory())throw Error('CANDIDATE_LINK_REJECTED');
 const files=[];
 for(const item of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  const full=path.join(directory,item.name),stat=fs.lstatSync(full);
  if(stat.isSymbolicLink())throw Error('CANDIDATE_LINK_REJECTED');
  if(stat.isDirectory())files.push(...walk(full));else if(stat.isFile())files.push(full);else throw Error('CANDIDATE_NON_FILE_REJECTED');
 }
 return files;
}
export function verifyWindowsCandidate(bytes){
 const errors=[];let total=0;
 let entries;
 try{entries=unzipSync(bytes,{filter:f=>{total+=f.originalSize;if(total>512*1048576||f.originalSize>256*1048576)throw Error('ARCHIVE_TOO_LARGE');return true;}});}catch{return ['ARCHIVE_INVALID_OR_TOO_LARGE'];}
 const raw=entries['ProjectOrch/MANIFEST.json'];if(!raw||raw.length>2*1048576)return ['MANIFEST_MISSING_OR_TOO_LARGE'];
 let m;try{m=JSON.parse(strFromU8(raw));}catch{return ['MANIFEST_INVALID'];}
 if(m.kind!=='ProjectOrch Windows private candidate'||!Array.isArray(m.files)||m.files.length>3000)return ['MANIFEST_INVALID'];
 const names=new Set(['projectorch/manifest.json']),allowed=new Set(['ProjectOrch/MANIFEST.json']);
 for(const f of m.files){
  if(!safe(f.path)||names.has(('ProjectOrch/'+f.path).toLowerCase())||!Number.isSafeInteger(f.size)||f.size<0||!/^[a-f0-9]{64}$/.test(f.sha256)){errors.push('MANIFEST_ENTRY_INVALID');continue;}
  const key='ProjectOrch/'+f.path;names.add(key.toLowerCase());allowed.add(key);
  if(!entries[key]||entries[key].length!==f.size||sha(entries[key])!==f.sha256)errors.push('FILE_HASH_MISMATCH:'+f.path);
 }
 for(const key of Object.keys(entries))if(!allowed.has(key))errors.push('UNLISTED_FILE:'+key);
 return errors;
}

export function buildWindowsCandidate({root=ROOT,nodeDirectory=path.join(ROOT,'work/node-runtime/node-v24.22.0-win-x64')}={}){
 root=fs.realpathSync(root);nodeDirectory=fs.realpathSync(nodeDirectory);
 const entries={},files=[],source={},names=new Set();
 const add=(target,bytes,sourcePath)=>{
  if(!safe(target)||names.has(target.toLowerCase()))throw Error('DUPLICATE_OR_UNSAFE_CANDIDATE_PATH');
  names.add(target.toLowerCase());const buffer=Buffer.from(bytes);files.push({path:target,size:buffer.length,sha256:sha(buffer)});entries['ProjectOrch/'+target]=[new Uint8Array(buffer),{mtime:frozenTime}];
  if(sourcePath)source[sourcePath]=sha(buffer);
 };
 const copy=(sourceFile,target)=>{
  const stat=fs.lstatSync(sourceFile);if(!stat.isFile()||stat.isSymbolicLink())throw Error('CANDIDATE_FILE_REQUIRED');
  const actual=fs.realpathSync(sourceFile);
  if(!actual.startsWith(root+path.sep)&&!actual.startsWith(nodeDirectory+path.sep))throw Error('CANDIDATE_SOURCE_OUTSIDE_ROOT');
  add(target,fs.readFileSync(sourceFile),sourceFile.startsWith(root+path.sep)?path.relative(root,sourceFile).replaceAll('\\','/'):'node-runtime/'+path.basename(sourceFile));
 };
 const copyTree=(directory,target,predicate=()=>true)=>{for(const file of walk(directory)){const rel=path.relative(directory,file).replaceAll('\\','/');if(predicate(rel))copy(file,target+'/'+rel);}};
 const production=rel=>!rel.endsWith('.map')&&!rel.endsWith('.ts')&&!rel.endsWith('.tsbuildinfo');
 copyTree(path.join(root,'apps/kernel/dist'),'apps/kernel/dist',production);
 copy(path.join(root,'apps/kernel/package.json'),'apps/kernel/package.json');
 copyTree(path.join(root,'apps/web/dist'),'apps/web/dist',production);
 const workspaces=new Map();for(const parent of ['apps','packages'])for(const d of fs.readdirSync(path.join(root,parent))){const file=path.join(root,parent,d,'package.json');if(fs.existsSync(file)){const pkg=JSON.parse(fs.readFileSync(file));workspaces.set(pkg.name,path.dirname(file));}}
 const dependencies=[],done=new Map(),queue=[path.join(root,'apps/kernel')];
 while(queue.length){
  const dir=queue.shift(),pkg=JSON.parse(fs.readFileSync(path.join(dir,'package.json')));
  if(done.has(pkg.name)){if(done.get(pkg.name)!==pkg.version)throw Error('DEPENDENCY_VERSION_CONFLICT');continue;}
  done.set(pkg.name,pkg.version);
  if(pkg.name!=='@projectorch/kernel'){
   const target='node_modules/'+pkg.name;
   if(workspaces.has(pkg.name)){
    copy(path.join(dir,'package.json'),target+'/package.json');copyTree(path.join(dir,'dist'),target+'/dist',production);
    if(pkg.name==='@projectorch/persistence')copyTree(path.join(dir,'migrations'),target+'/migrations',p=>p.endsWith('.sql'));
   }else{
    // 固定运行依赖中的已发布文件；不沿pnpm链接复制整个开发机node_modules。
    for(const file of walkPackage(dir)){const rel=path.relative(dir,file).replaceAll('\\','/');copy(file,target+'/'+rel);}
   }
  }
  const record={name:pkg.name,version:pkg.version,license:pkg.license??null,packageSha256:sha(fs.readFileSync(path.join(dir,'package.json'))),dependencies:[]};
  const req=createRequire(path.join(dir,'package.json'));
  for(const [name,version] of Object.entries(pkg.dependencies??{})){
   let next=workspaces.get(name);if(!next)next=path.dirname(fs.realpathSync(req.resolve(name+'/package.json')));
   const actual=JSON.parse(fs.readFileSync(path.join(next,'package.json')));
   if(actual.name!==name||(workspaces.has(name)&&actual.version!==version))throw Error('DEPENDENCY_IDENTITY_MISMATCH');
   record.dependencies.push(name+'@'+actual.version);queue.push(next);
  }
  dependencies.push(record);
 }
 for(const p of ['config/compatibility.json','config/native-policy.json','scripts/mcp-control-bridge.mjs'])copy(path.join(root,p),p);
 copy(path.join(root,'docs/user/WINDOWS_CANDIDATE_GUIDE.md'),'docs/USER_MANUAL.md');
 copy(path.join(root,'docs/user/ALPHA_FIRST_USE.md'),'docs/ALPHA_FIRST_USE.md');
 copy(path.join(root,'docs/user/ALPHA_KNOWN_ISSUES.md'),'docs/ALPHA_KNOWN_ISSUES.md');
 copy(path.join(root,'docs/user/OPEN_SOURCE_PREPARATION.md'),'docs/OPEN_SOURCE_PREPARATION.md');
 copy(path.join(root,'LICENSE'),'LICENSE');copy(path.join(root,'PUBLIC_RELEASE.json'),'PUBLIC_RELEASE.json');copy(path.join(root,'docs/SUPPORT_STATUS.json'),'docs/SUPPORT_STATUS.json');
 for(const p of ['native-config.example.json','codex-mcp-entry.toml','zcode-mcp-entry.json'])copy(path.join(root,'docs/config-samples',p),'docs/config-samples/'+p);
 const binary=path.join(nodeDirectory,'node.exe'),license=path.join(nodeDirectory,'LICENSE');
 if(sha(fs.readFileSync(binary))!=='ba93f9a70bd86fce3ebbb39ec758501458453467aa92a34a0a3602d1e3fc2b9c')throw Error('PINNED_RUNTIME_HASH_MISMATCH');
 copy(binary,'runtime/node.exe');copy(license,'runtime/NODE_LICENSE.txt');
 const version=spawnSync(binary,['--version'],{encoding:'utf8',windowsHide:true,timeout:10000});
 if(version.status!==0||version.stdout.trim()!=='v24.22.0')throw Error('PINNED_WINDOWS_RUNTIME_REQUIRED');
 add('start.cmd','@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0apps\\kernel\\dist\\main.js" %*\r\n');
 add('README.txt','ProjectOrch 0.1.0-alpha.3 Windows Apache Alpha本地候选（hhhzingy；https://github.com/hhhzingy/ProjectOrch）\r\n以普通用户解压到本地目录，运行 start.cmd --pair；不要以管理员运行。\r\n--data-dir 可选择独立数据目录；默认数据保存在用户本地应用数据目录。\r\nCtrl+C 停止。卸载仅移除安装目录，保留项目、数据目录和官方Harness。\r\n真实模型需要自行安装/登录官方Harness并配置native-config；候选不含认证。\r\n本项目采用Apache-2.0；已获完成Alpha后发布授权，基本Alpha子集已验收；本包构建时尚未公开，实际分发以GitHub Release记录为准。\r\n基本Alpha子集已验；干净Windows与完整路线仍未验。详见docs/USER_MANUAL.md。\r\n');
 add('THIRD_PARTY_NOTICES.md','# 第三方运行依赖\n\nProjectOrch采用Apache-2.0，官方原文见根LICENSE；各第三方依赖沿用各自许可。各包许可正文位于对应 node_modules 包目录；Node.js 及其附带组件许可见 runtime/NODE_LICENSE.txt。\n\n'+dependencies.filter(p=>!p.name.startsWith('@projectorch/')).map(p=>`- ${p.name}@${p.version}：${p.license??'待核对'}`).join('\n')+'\n');
 add('DEPENDENCIES.json',JSON.stringify({schemaVersion:1,scope:'actual private candidate runtime dependency inventory',node:{version:version.stdout.trim(),sha256:sha(fs.readFileSync(binary))},dependencies},null,2)+'\n');
 // 同时绑定构建输入和实际复制的产物；只保存输入哈希，不收录开发源码/私有报告正文。
 for(const parent of ['apps','packages'])for(const d of fs.readdirSync(path.join(root,parent))){const src=path.join(root,parent,d,'src');if(fs.existsSync(src))for(const file of walk(src))source[path.relative(root,file).replaceAll('\\','/')]=sha(fs.readFileSync(file));}
 for(const p of ['package.json','package-lock.json','pnpm-lock.yaml','tsconfig.json','tsconfig.base.json','scripts/build-app.mjs','scripts/build-windows-candidate.mjs'])source[p]=sha(fs.readFileSync(path.join(root,p)));
 const snapshot=Object.fromEntries(Object.entries(source).sort(([a],[b])=>a.localeCompare(b)));
 add('BUILD_SOURCES.json',JSON.stringify(snapshot,null,2)+'\n');
 const manifest={schemaVersion:1,kind:'ProjectOrch Windows private candidate',applicationVersion:JSON.parse(fs.readFileSync(path.join(root,'apps/kernel/package.json'))).version,ownLicense:release.license,publicationAuthorization:release.publicationAuthorization,publicationReadiness:release.publicationReadiness,publicReleaseAuthorized:false,sourceSnapshotSha256:sha(Buffer.from(JSON.stringify(snapshot))),files:files.sort((a,b)=>a.path.localeCompare(b.path))};
 entries['ProjectOrch/MANIFEST.json']=[strToU8(JSON.stringify(manifest,null,2)+'\n'),{mtime:frozenTime}];
 const bytes=zipSync(entries,{level:6});const errors=verifyWindowsCandidate(bytes);if(errors.length)throw Error(errors.join('\n'));
 return {bytes,manifest,sha256:sha(bytes)};
}

function walkPackage(directory){
 const files=[];
 for(const item of fs.readdirSync(directory,{withFileTypes:true})){if(['node_modules','.git','test','tests','examples','benchmark','benchmarks'].includes(item.name))continue;const full=path.join(directory,item.name),stat=fs.lstatSync(full);if(stat.isSymbolicLink())throw Error('DEPENDENCY_LINK_REJECTED');if(stat.isDirectory())files.push(...walkPackage(full));else if(stat.isFile()&&!full.endsWith('.map')&&!full.endsWith('.ts'))files.push(full);}
 return files;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);if(args.length!==0&&(args.length!==2||args[0]!=='--runtime-dir'||!path.isAbsolute(args[1])))throw Error('EXPECTED_OPTIONAL_ABSOLUTE_RUNTIME_DIR');
 const build=spawnSync(process.execPath,['scripts/build-app.mjs'],{cwd:ROOT,stdio:'inherit',windowsHide:true});if(build.status!==0)process.exit(build.status??1);
 const result=buildWindowsCandidate(args.length?{nodeDirectory:args[1]}:{}),out=path.join(ROOT,'outputs');fs.mkdirSync(out,{recursive:true});
 const name='ProjectOrch-windows-apache-'+result.sha256.slice(0,16)+'.zip',target=path.join(out,name);
 if(fs.existsSync(target)){if(sha(fs.readFileSync(target))!==result.sha256)throw Error('EXISTING_CANDIDATE_CONFLICT');}else fs.writeFileSync(target,result.bytes,{flag:'wx'});
 fs.writeFileSync(target+'.sha256.txt',result.sha256+'  '+name+'\n');
 console.log(JSON.stringify({path:target,sha256:result.sha256,files:result.manifest.files.length,bytes:result.bytes.length,publicReleaseAuthorized:false}));
}

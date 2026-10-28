// 只使用专用合成字符串，绝不读取用户认证内容。
import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import path from'node:path';import{createHash}from'node:crypto';
import{executionFixture}from'./execution-fixture.mjs';import{registerArtifactWithin,resolveWithinProject}from'../../../packages/domain/dist/artifacts/index.js';import{readArtifactChunk}from'../../../packages/domain/dist/artifacts/content.js';import{isRuntimeMetadataPath}from'../../../packages/domain/dist/policy/index.js';

test('已知Harness/内核运行凭据路径不可作为成果；历史行也不能读，普通源码配置仍可用',t=>{
 const f=executionFixture(t),bytes=Buffer.from('SYNTHETIC_ONLY'),hash=createHash('sha256').update(bytes).digest('hex');
 for(const [i,relative]of['workspace/.zcode/config.json','workspace/.CODEX/auth.json','workspace/control-entry.json','workspace/binding-credentials.json'].entries()){
  const filename=path.join(f.dir,relative);fs.mkdirSync(path.dirname(filename),{recursive:true});fs.writeFileSync(filename,bytes);assert.equal(isRuntimeMetadataPath(relative),true);assert.throws(()=>f.store.transaction(db=>registerArtifactWithin(db,{id:'new-'+i,projectId:'p',pathRef:relative,version:'v1',sha256:hash,byteSize:bytes.length},300)),/RUNTIME_METADATA_REFUSED/);
  f.store.db.prepare('INSERT INTO artifacts(id,project_id,version,path_ref,sha256,byte_size) VALUES(?,?,?,?,?,?)').run('legacy-'+i,'p','v1',relative,hash,bytes.length);assert.throws(()=>f.store.transaction(()=>readArtifactChunk(f.store,'p','legacy-'+i,'v1',0,()=>{})),/RUNTIME_METADATA_REFUSED/);assert.equal(resolveWithinProject(f.dir,relative).reason,'RUNTIME_METADATA_REFUSED');
 }
 const ordinary='workspace/app-config.json';fs.writeFileSync(path.join(f.dir,ordinary),bytes);f.store.transaction(db=>registerArtifactWithin(db,{id:'ordinary',projectId:'p',pathRef:ordinary,version:'v1',sha256:hash,byteSize:bytes.length},300));assert.equal(f.store.transaction(()=>readArtifactChunk(f.store,'p','ordinary','v1',0,()=>{})).content,'SYNTHETIC_ONLY');
});

test('普通成果路径经链接转向运行配置也拒绝，保留目标字节',t=>{
 const f=executionFixture(t),metadata=path.join(f.driver.workspaceRoot,'.zcode'),link=path.join(f.driver.workspaceRoot,'linked');fs.mkdirSync(metadata);fs.writeFileSync(path.join(metadata,'config.json'),'SYNTHETIC_ONLY');fs.symlinkSync(metadata,link,process.platform==='win32'?'junction':'dir');
 try{f.store.db.prepare('INSERT INTO artifacts(id,project_id,version,path_ref,sha256,byte_size) VALUES(?,?,?,?,?,?)').run('aliased','p','v1','workspace/linked/config.json',createHash('sha256').update('SYNTHETIC_ONLY').digest('hex'),14);assert.throws(()=>f.store.transaction(()=>readArtifactChunk(f.store,'p','aliased','v1',0,()=>{})),/RUNTIME_METADATA_REFUSED/);assert.equal(resolveWithinProject(f.dir,'workspace/linked/config.json').reason,'RUNTIME_METADATA_REFUSED');}finally{fs.unlinkSync(link);}
});

// 硬链接（Hard link）没有可识别的路径别名；统一按不支持处理，不扫描或读取原始配置。
for(const route of ['register','legacy-read','fingerprint','snapshot'])test(`多硬链接合成配置在${route}边界拒绝且保留文件`,async t=>{
 const f=executionFixture(t),root=f.driver.workspaceRoot,metadata=path.join(root,'.zcode'),source=path.join(root,'source');fs.mkdirSync(metadata);fs.mkdirSync(source);
 const original=path.join(metadata,'mcp.json'),alias=path.join(source,'ordinary.json'),bytes=Buffer.from('SYNTHETIC_HARDLINK_ONLY');fs.writeFileSync(original,bytes);fs.linkSync(original,alias);
 const input={id:'alias',projectId:'p',version:'v1',pathRef:'workspace/source/ordinary.json',sha256:createHash('sha256').update(bytes).digest('hex'),byteSize:bytes.length};
 if(route==='register')assert.throws(()=>f.store.transaction(db=>registerArtifactWithin(db,input,300)),/HARDLINK_UNSUPPORTED/);
 if(route==='legacy-read'){
  f.store.db.prepare('INSERT INTO artifacts(id,project_id,version,path_ref,sha256,byte_size) VALUES(?,?,?,?,?,?)').run(input.id,input.projectId,input.version,input.pathRef,input.sha256,input.byteSize);
  assert.throws(()=>f.store.transaction(()=>readArtifactChunk(f.store,'p','alias','v1',0,()=>{})),/HARDLINK_UNSUPPORTED/);
 }
 if(route==='fingerprint'){const {readFileFingerprint}=await import('../../../packages/domain/dist/artifacts/index.js');assert.equal(readFileFingerprint(alias),null);}
 if(route==='snapshot'){const{workspaceContentSnapshot}=await import('../../../apps/kernel/dist/tools/workspace-fingerprint.js');assert.throws(()=>f.store.transaction(()=>workspaceContentSnapshot(f.store,'p','workspace',()=>{},{contentPath:'source'})),/HARDLINK_UNSUPPORTED/);}
 assert.equal(fs.readFileSync(original,'utf8'),'SYNTHETIC_HARDLINK_ONLY');assert.equal(fs.lstatSync(alias).nlink,2);
});

test('登记后的普通文件变为硬链接，旧登记不能继续读取或核验',async t=>{
 const f=executionFixture(t),root=f.driver.workspaceRoot,file=path.join(root,'ordinary.json'),alias=path.join(root,'alias.json'),bytes=Buffer.from('SYNTHETIC_ONLY');fs.writeFileSync(file,bytes);
 f.store.transaction(db=>registerArtifactWithin(db,{id:'ordinary',projectId:'p',version:'v1',pathRef:'workspace/ordinary.json',sha256:createHash('sha256').update(bytes).digest('hex'),byteSize:bytes.length},300));
 assert.equal(f.store.transaction(()=>readArtifactChunk(f.store,'p','ordinary','v1',0,()=>{})).content,'SYNTHETIC_ONLY');fs.linkSync(file,alias);
 assert.throws(()=>f.store.transaction(()=>readArtifactChunk(f.store,'p','ordinary','v1',0,()=>{})),/HARDLINK_UNSUPPORTED/);
 const{readFileFingerprint}=await import('../../../packages/domain/dist/artifacts/index.js');assert.equal(readFileFingerprint(file),null);
});

// 在打开/读取边界实际变更链接计数，验证不把已读取的字节返回调用者。
for(const route of ['artifact','snapshot','fingerprint'])for(const timing of ['before-open','during-read'])test(`${route}在${timing}出现第二链接，明确拒绝且无成功内容`,async t=>{
 const {syncBuiltinESMExports}=await import('node:module');
 const f=executionFixture(t),source=path.join(f.driver.workspaceRoot,'source');fs.mkdirSync(source);const file=path.join(source,'ordinary.json'),alias=path.join(source,'late-alias.json');fs.writeFileSync(file,'SYNTHETIC_ONLY');
 f.store.transaction(db=>registerArtifactWithin(db,{id:'ordinary',projectId:'p',version:'v1',pathRef:'workspace/source/ordinary.json',sha256:createHash('sha256').update('SYNTHETIC_ONLY').digest('hex'),byteSize:14},300));
 const originalOpen=fs.openSync,originalRead=fs.readSync;let targetFd,changed=false;
 fs.openSync=function(filename,...args){if(String(filename)===file&&timing==='before-open'&&!changed){fs.linkSync(file,alias);changed=true;}const fd=originalOpen(filename,...args);if(String(filename)===file)targetFd=fd;return fd;};
 fs.readSync=function(fd,...args){const count=originalRead(fd,...args);if(fd===targetFd&&count>0&&timing==='during-read'&&!changed){fs.linkSync(file,alias);changed=true;}return count;};syncBuiltinESMExports();
 try{
  if(route==='artifact')assert.throws(()=>f.store.transaction(()=>readArtifactChunk(f.store,'p','ordinary','v1',0,()=>{})),/ARTIFACT_CONTENT_CHANGED/);
  if(route==='snapshot'){const {workspaceContentSnapshot}=await import('../../../apps/kernel/dist/tools/workspace-fingerprint.js');assert.throws(()=>f.store.transaction(()=>workspaceContentSnapshot(f.store,'p','workspace',()=>{},{contentPath:'source'})),/WORKSPACE_CONTENT_CHANGED/);}
  if(route==='fingerprint'){const {readFileFingerprint}=await import('../../../packages/domain/dist/artifacts/index.js');assert.equal(readFileFingerprint(file),null);}
  assert.equal(changed,true);
 }finally{fs.openSync=originalOpen;fs.readSync=originalRead;syncBuiltinESMExports();}
});

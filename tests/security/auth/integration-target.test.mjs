// 实际临时Git/非Git文件读取；不调用官方Harness，不冒充集成交付验收。
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {executionFixture} from './execution-fixture.mjs';
import {inspectIntegrationTarget,integrationTargetFingerprint} from '../../../apps/kernel/dist/integration/target.js';

function fixture(t){const f=executionFixture(t);f.store.db.exec("UPDATE workspaces SET base_version='baseline'");const inspect=(kind='files',baseline='baseline',check=()=>{})=>f.store.transaction(()=>inspectIntegrationTarget(f.store,'p','workspace',kind,baseline,check));return Object.assign(f,{inspect});}

test('非Git准确目标保留原请求基线并计算整合后字节清单；变化不套旧哈希',t=>{
 const f=fixture(t),file=path.join(f.driver.workspaceRoot,'merged.json');fs.writeFileSync(file,'{"left":1,"right":2}');const a=f.inspect();
 assert.equal(a.baseline,'baseline');assert.equal(a.kind,'files');assert.match(a.outputVersion,/^[a-f0-9]{64}$/);assert.deepEqual(a.files.map(f=>f.path),['merged.json']);assert.equal(a.bytes,20);
 assert.deepEqual(f.inspect(),a);fs.writeFileSync(file,'{"left":1,"right":3}');const b=f.inspect();assert.notEqual(b.outputVersion,a.outputVersion);assert.notEqual(integrationTargetFingerprint(a),integrationTargetFingerprint(b));
 assert.throws(()=>f.inspect('files','other'),/BASELINE_CHANGED/);assert.throws(()=>f.inspect('files','baseline',(action,p)=>{if(p==='workspace/merged.json')throw Error('FORBIDDEN');}),/FORBIDDEN/);
 f.store.db.exec("UPDATE workspaces SET state='unknown'");assert.throws(()=>f.inspect(),/NOT_QUIESCENT/);
});

test('Harness运行元数据拒绝整目录读取；显式交付子目录记录范围，不读配置也不冒充全目录',t=>{
 const f=fixture(t),root=f.driver.workspaceRoot,content=path.join(root,'source');fs.mkdirSync(content);fs.writeFileSync(path.join(content,'out.json'),'{"delivered":true}');fs.mkdirSync(path.join(root,'.zcode'));fs.writeFileSync(path.join(root,'.zcode','config.json'),'SYNTHETIC_SECRET_DO_NOT_READ');
 assert.throws(()=>f.inspect(),/RUNTIME_METADATA_REQUIRES_CONTENT_PATH/);
 const selected=()=>f.store.transaction(()=>inspectIntegrationTarget(f.store,'p','workspace','files','baseline',()=>{},'source')),snapshot=selected();assert.equal(snapshot.contentPath,'source');assert.deepEqual(snapshot.files.map(f=>f.path),['out.json']);assert.equal(JSON.stringify(snapshot).includes('SYNTHETIC_SECRET'),false);
 fs.writeFileSync(path.join(root,'.zcode','config.json'),'SYNTHETIC_ROTATED_CONFIG');assert.deepEqual(selected(),snapshot,'明确交付范围外的运行配置不属于该内容版本');assert.throws(()=>f.inspect(),/RUNTIME_METADATA_REQUIRES_CONTENT_PATH/);
 for(const value of ['../source','source/../.zcode','.zcode','source\\out.json'])assert.throws(()=>f.store.transaction(()=>inspectIntegrationTarget(f.store,'p','workspace','files','baseline',()=>{},value)),/CONTENT_PATH_INVALID/);
 fs.mkdirSync(path.join(content,'.codex'));assert.throws(selected,/RUNTIME_METADATA_REQUIRES_CONTENT_PATH/);
});

test('未决写预约及重解析路径拒绝准确目标，不释放旧unknown',t=>{
 const f=fixture(t);f.store.db.exec("INSERT INTO workspace_reservations(id,project_id,workspace_id,task_id,task_revision,fence,state) VALUES('write','p','workspace','task',1,1,'unknown')");
 assert.throws(()=>f.inspect(),/TARGET_UNRESOLVED/);assert.equal(f.store.db.prepare("SELECT state FROM workspace_reservations WHERE id='write'").get().state,'unknown');f.store.db.exec("UPDATE workspace_reservations SET state='released'");
 const outside=path.join(f.dir,'outside'),link=path.join(f.driver.workspaceRoot,'link');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'asset'),'untouched');fs.symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');try{assert.throws(()=>f.inspect(),/REPARSE/);assert.equal(fs.readFileSync(path.join(outside,'asset'),'utf8'),'untouched');}finally{fs.unlinkSync(link);}
});

test('不同workspace ID按真实路径和适用写范围核对，重叠unknown/reserved不释放，独立目录可检查',async t=>{
 for(const mode of ['same-alias','ancestor','descendant','independent','declared-overlap','unresolvable'])for(const state of ['reserved','unknown'])await t.test(mode+'-'+state,inner=>{
  const f=fixture(inner),root=f.driver.workspaceRoot,nested=path.join(root,'nested'),other=path.join(f.dir,'other');fs.mkdirSync(nested);fs.mkdirSync(other);
  const location=mode==='same-alias'?(process.platform==='win32'?root.toUpperCase():root+path.sep):mode==='ancestor'?f.dir:mode==='descendant'?nested:mode==='unresolvable'?path.join(f.dir,'missing'):other;
  const writes=mode==='declared-overlap'?['workspace/*']:mode==='independent'?['other/*']:[];
  f.store.db.prepare("INSERT INTO workspaces(id,project_id,canonical_path,base_version,managed,enforcement,state,write_paths_json) VALUES('other-writer','p',?,'old',1,'advisory','available',?)").run(location,JSON.stringify(writes));f.store.db.prepare("INSERT INTO workspace_reservations(id,project_id,workspace_id,task_id,task_revision,fence,state) VALUES('other-lock','p','other-writer','task',1,1,?)").run(state);
  if(mode==='independent')assert.match(f.inspect().contentHash,/^[a-f0-9]{64}$/);else assert.throws(()=>f.inspect(),/UNRESOLVED|IDENTITY_CHANGED/);
  assert.equal(f.store.db.prepare("SELECT state FROM workspace_reservations WHERE id='other-lock'").get().state,state);
 });
});

test('预约目录被改为重解析目标后拒绝，不沿新路径读取或清原占位',t=>{
 const f=fixture(t),writer=path.join(f.dir,'writer'),moved=path.join(f.dir,'writer-moved');fs.mkdirSync(writer);f.store.db.prepare("INSERT INTO workspaces(id,project_id,canonical_path,managed,enforcement,state,write_paths_json) VALUES('changed-writer','p',?,1,'advisory','unknown','[]')").run(writer);
 fs.renameSync(writer,moved);fs.symlinkSync(moved,writer,process.platform==='win32'?'junction':'dir');try{assert.throws(()=>f.inspect(),/UNRESOLVED|IDENTITY_CHANGED/);assert.equal(f.store.db.prepare("SELECT state FROM workspaces WHERE id='changed-writer'").get().state,'unknown');}finally{fs.unlinkSync(writer);fs.renameSync(moved,writer);}
});

test('Git固定整合后HEAD且逐字节对照提交；脏/未跟踪/忽略文件及assume-unchanged不冒充已测提交',t=>{
 const f=fixture(t),root=f.driver.workspaceRoot;
 const git=(...args)=>execFileSync('git',['-C',root,'-c','core.autocrlf=false','-c','core.hooksPath=',...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
 git('init');git('config','user.name','Synthetic integration test');git('config','user.email','test@example.invalid');fs.writeFileSync(path.join(root,'merged.txt'),'left\n');git('add','merged.txt');git('commit','-m','baseline');const baseline=git('rev-parse','HEAD');
 fs.writeFileSync(path.join(root,'merged.txt'),'left\nright\n');fs.writeFileSync(path.join(root,'.gitignore'),'ignored-output\n');git('add','.');git('commit','-m','integrated bytes');const head=git('rev-parse','HEAD');f.store.db.prepare('UPDATE workspaces SET base_version=?').run(baseline);
 const captured=f.inspect('git',baseline);assert.equal(captured.baseline,baseline);assert.equal(captured.outputVersion,head);assert.equal(captured.repository.commitSha,head);assert.notEqual(head,baseline);assert.equal(captured.files.some(f=>f.path?.startsWith('.git/')),false);
 git('update-index','--assume-unchanged','merged.txt');fs.writeFileSync(path.join(root,'merged.txt'),'semantic-conflict\n');assert.equal(git('status','--porcelain'),'','Git状态自身可被标志掩盖');assert.throws(()=>f.inspect('git',baseline),/WORKTREE_NOT_EXACT/);fs.writeFileSync(path.join(root,'merged.txt'),'left\nright\n');
 for(const name of ['untracked','ignored-output']){fs.writeFileSync(path.join(root,name),'affects-tests');assert.throws(()=>f.inspect('git',baseline),/WORKTREE_NOT_EXACT/);fs.unlinkSync(path.join(root,name));}
 assert.deepEqual(f.inspect('git',baseline),captured);assert.throws(()=>f.inspect('git','main'),/BASELINE_CHANGED/);
});

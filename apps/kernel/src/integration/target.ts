import path from 'node:path';
import {realpathSync,lstatSync,openSync,fstatSync,readSync,closeSync,constants} from 'node:fs';
import {createHash} from 'node:crypto';
import type {Store} from '@projectorch/persistence';
import {canonicalJson} from '@projectorch/persistence/outbox';
import {inspectRepository,inspectCommit,verifyCommitGraph,gitRead,repositoryScope} from '@projectorch/domain/artifacts/git';
import {workspaceContentSnapshot} from '../tools/workspace-fingerprint.js';
import {assertWorkspaceWritersQuiescent} from '../execution/workspace-writers.js';

export type IntegrationTargetKind='files'|'git';
export type TargetAuthorize=(action:string,resource:string)=>void;
const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');

/** 只读固定整合后内容；原请求baseline不重解释为输出版本，不进行合并/checkout/reset。 */
export function inspectIntegrationTarget(store:Store,projectId:string,workspaceId:string,kind:IntegrationTargetKind,baseline:string,authorize:TargetAuthorize,contentPath?:string){
 if(!store.db.isTransaction)throw Error('INTEGRATION_TARGET_TRANSACTION_REQUIRED');
 const db=store.db,workspace=db.prepare('SELECT canonical_path,state,revision,base_version FROM workspaces WHERE project_id=? AND id=?').get(projectId,workspaceId),project=db.prepare('SELECT canonical_root FROM projects WHERE id=?').get(projectId);
 if(!workspace||!project||workspace.state!=='available')throw Error('INTEGRATION_TARGET_NOT_QUIESCENT');
 // 同一目标仍有未决写预约时，不能用独立集成对象绕过原执行。
 assertWorkspaceWritersQuiescent(store,projectId,workspaceId);
 if(workspace.base_version!==baseline)throw Error('INTEGRATION_BASELINE_CHANGED');
 const check=(resource:string)=>authorize(resource.startsWith('workspaces/')?'workspace.read':'artifact.read',resource);
 if(kind==='files'){
  const snapshot=workspaceContentSnapshot(store,projectId,workspaceId,check,contentPath?{contentPath}:{});
  return {kind,workspaceId,workspaceRevision:Number(workspace.revision),contentPath:contentPath??null,baseline,outputVersion:snapshot.contentHash,contentHash:snapshot.contentHash,files:snapshot.records,bytes:snapshot.bytes,repository:null};
 }
 if(kind!=='git')throw Error('INTEGRATION_TARGET_KIND_UNSUPPORTED');
 // 只有明确完整基线SHA才用于祖先关系，分支名不当固定版本。
 if(!/^[a-f0-9]{40}$/.test(baseline))throw Error('INTEGRATION_GIT_BASELINE_SHA_REQUIRED');
 // 先执行相同安全路径/元数据检查，再将明确内容根作为仓库目标。
 const snapshot=workspaceContentSnapshot(store,projectId,workspaceId,check,{gitMetadata:true,...(contentPath?{contentPath}:{})});
 const relative=path.relative(realpathSync(String(project.canonical_root)),realpathSync(path.resolve(String(workspace.canonical_path),contentPath??'.'))).replaceAll('\\','/')||'.';
 const identity=inspectRepository(String(project.canonical_root),relative,p=>authorize('artifact.read',p)),repo=identity.repository.path;
 authorize('artifact.read',repositoryScope(relative));
 const baselineCommit=inspectCommit(repo,baseline),head=inspectCommit(repo,'HEAD');
 if(baselineCommit.commitSha!==baseline)throw Error('INTEGRATION_BASELINE_CHANGED');
 try{gitRead(repo,['merge-base','--is-ancestor',baseline,head.commitSha]);}catch{throw Error('INTEGRATION_GIT_BASELINE_NOT_ANCESTOR');}
 const treeSha=verifyCommitGraph(repo,head.commitSha);
 const source=gitRead(repo,['ls-tree','-r','-z','--full-tree',head.commitSha]).toString('utf8').split('\0').filter(Boolean);
 const tracked=new Map<string,string>();
 for(const line of source){const match=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(line);if(!match||!match[3]||tracked.has(match[3]))throw Error('INTEGRATION_GIT_ENTRY_UNSUPPORTED');tracked.set(match[3],match[2] as string);}
 const files=snapshot.records.filter(record=>record.path!==undefined);
 if(files.length!==tracked.size||files.some(file=>!file.path||tracked.get(file.path)!==file.gitBlobSha1))throw Error('INTEGRATION_GIT_WORKTREE_NOT_EXACT');
 // 原始字节逐文件对照提交，不受assume-unchanged/skip-worktree及过滤器掩盖影响。
 if(inspectCommit(repo,'HEAD').commitSha!==head.commitSha||JSON.stringify(identity)!==JSON.stringify(inspectRepository(String(project.canonical_root),relative,p=>authorize('artifact.read',p))))throw Error('INTEGRATION_TARGET_CHANGED');
 return {kind,workspaceId,workspaceRevision:Number(workspace.revision),contentPath:contentPath??null,baseline,outputVersion:head.commitSha,contentHash:snapshot.contentHash,files:snapshot.records,bytes:snapshot.bytes,repository:{identity,treeSha,commitSha:head.commitSha,baselineSha:baseline}};
}
export type IntegrationTarget=ReturnType<typeof inspectIntegrationTarget>;
export const integrationTargetFingerprint=(target:IntegrationTarget)=>digest(target);

/** 内置验证器仅取得这些经指纹核对的内存字节，不获得目录句柄、环境或任意文件读取能力。 */
export function integrationTargetBytes(store:Store,projectId:string,target:IntegrationTarget,files:readonly string[],authorize:TargetAuthorize){
 if(!store.db.isTransaction)throw Error('INTEGRATION_TARGET_TRANSACTION_REQUIRED');
 const project=store.db.prepare('SELECT canonical_root FROM projects WHERE id=?').get(projectId),workspace=store.db.prepare('SELECT canonical_path FROM workspaces WHERE project_id=? AND id=?').get(projectId,target.workspaceId);if(!project||!workspace)throw Error('INTEGRATION_TARGET_NOT_FOUND');
 const projectRoot=realpathSync.native(String(project.canonical_root)),root=realpathSync.native(path.resolve(String(workspace.canonical_path),target.contentPath??'.')),result=new Map<string,Uint8Array>();
 const within=path.relative(projectRoot,root);if(within==='..'||within.startsWith('..'+path.sep)||path.isAbsolute(within))throw Error('CHECK_TARGET_PATH_CHANGED');
 for(const filename of [...new Set(files)]){
  const expected=target.files.find(f=>f.path===filename);if(!expected||expected.size===undefined||expected.size>1024*1024)throw Error('CHECK_TARGET_FILE_UNAVAILABLE');
  const absolute=path.resolve(root,filename),resource=path.relative(projectRoot,absolute).replaceAll('\\','/');authorize('artifact.read',resource);
  const resolve=()=>{const real=realpathSync.native(absolute),relative=path.relative(root,real);if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('CHECK_TARGET_PATH_CHANGED');authorize('artifact.read',path.relative(projectRoot,real).replaceAll('\\','/'));return real;};
  let fd:number|undefined;
  try{const name=resolve(),before=lstatSync(absolute,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||Number(before.size)!==expected.size)throw Error('CHECK_TARGET_FILE_UNAVAILABLE');fd=openSync(absolute,constants.O_RDONLY|(constants.O_NOFOLLOW??0));const opened=fstatSync(fd,{bigint:true});if(!opened.isFile()||opened.nlink!==1n||opened.ctimeNs!==before.ctimeNs||opened.mtimeNs!==before.mtimeNs||opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)throw Error('CHECK_TARGET_CHANGED');
   const bytes=Buffer.alloc(expected.size);let offset=0;while(offset<bytes.length){const count=readSync(fd,bytes,offset,bytes.length-offset,offset);if(!count)throw Error('CHECK_TARGET_CHANGED');offset+=count;}
   const after=fstatSync(fd,{bigint:true}),named=lstatSync(absolute,{bigint:true});if(!after.isFile()||!named.isFile()||after.nlink!==1n||named.nlink!==1n||named.size!==after.size||named.ctimeNs!==after.ctimeNs||named.mtimeNs!==after.mtimeNs||after.dev!==opened.dev||after.ino!==opened.ino||after.size!==opened.size||after.ctimeNs!==opened.ctimeNs||after.mtimeNs!==opened.mtimeNs||named.dev!==after.dev||named.ino!==after.ino||named.isSymbolicLink()||resolve()!==name||createHash('sha256').update(bytes).digest('hex')!==expected.sha256)throw Error('CHECK_TARGET_CHANGED');result.set(filename,bytes);
  }finally{if(fd!==undefined)closeSync(fd);}
 }
 return result;
}

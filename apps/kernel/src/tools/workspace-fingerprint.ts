import {createHash} from 'node:crypto';
import {lstatSync,readdirSync,realpathSync,openSync,closeSync,fstatSync,readSync,constants} from 'node:fs';
import path from 'node:path';
import type {Store} from '@projectorch/persistence';
import {isWellFormedRelativePath,isRuntimeMetadataPath} from '@projectorch/domain/policy';

/** 有界、只读内容快照；拒绝链接/非普通文件，每个文件读取前检查项目路径授权。 */
export function workspaceFingerprint(store:Store,projectId:string,id:string,authorize:(resource:string)=>void):string{
 return workspaceContentSnapshot(store,projectId,id,authorize).contentHash;
}
export interface WorkspaceContentRecord {readonly path?:string;readonly directory?:string;readonly sha256?:string;readonly size?:number;readonly gitBlobSha1?:string;}
/** 准确内容清单；只有已核对Git来源的调用者可显式排除根.git元数据。 */
export function workspaceContentSnapshot(store:Store,projectId:string,id:string,authorize:(resource:string)=>void,options:{readonly gitMetadata?:boolean;readonly contentPath?:string}={}){
 const db=store.db,workspace=db.prepare('SELECT canonical_path,state FROM workspaces WHERE id=? AND project_id=?').get(id,projectId),project=db.prepare('SELECT canonical_root FROM projects WHERE id=?').get(projectId);
 if(!workspace||!project||workspace.state==='retired')throw Error('WORKSPACE_NOT_AVAILABLE');
 authorize(`workspaces/${id}`);
 const projectRoot=realpathSync(String(project.canonical_root)),workspaceRoot=realpathSync(String(workspace.canonical_path));
 if(options.contentPath!==undefined&&(!isWellFormedRelativePath(options.contentPath)||options.contentPath.split('/').some(part=>['.zcode','.codex','.git'].includes(part.toLowerCase()))))throw Error('WORKSPACE_CONTENT_PATH_INVALID');
 let requestedRoot=String(workspace.canonical_path);
 for(const segment of options.contentPath?.split('/')??[]){requestedRoot=path.join(requestedRoot,segment);const stat=lstatSync(requestedRoot);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('WORKSPACE_CONTENT_PATH_REPARSE_REFUSED');}
 const root=realpathSync(requestedRoot),fromWorkspace=path.relative(workspaceRoot,root),relative=path.relative(projectRoot,root);
 if(isRuntimeMetadataPath(root))throw Error('WORKSPACE_RUNTIME_METADATA_REQUIRES_CONTENT_PATH');
 if(fromWorkspace==='..'||fromWorkspace.startsWith('..'+path.sep)||path.isAbsolute(fromWorkspace))throw Error('WORKSPACE_CONTENT_PATH_INVALID');
 if(relative.startsWith('..')||path.isAbsolute(relative)||lstatSync(String(workspace.canonical_path)).isSymbolicLink())throw Error('WORKSPACE_OUT_OF_PROJECT');
 let entries=0,bytes=0;const records:WorkspaceContentRecord[]=[];const deadline=Date.now()+10000;
 const visit=(directory:string)=>{
  const initial=lstatSync(directory,{bigint:true});if(initial.isSymbolicLink()||!initial.isDirectory())throw Error('WORKSPACE_REPARSE_REFUSED');
  const names=readdirSync(directory).sort();
  for(const name of names){
   if(Date.now()>deadline)throw Error('WORKSPACE_SNAPSHOT_TIMEOUT');
   if(isRuntimeMetadataPath(path.relative(root,path.join(directory,name))))throw Error('WORKSPACE_RUNTIME_METADATA_REQUIRES_CONTENT_PATH');
   if(options.gitMetadata&&directory===root&&name==='.git')continue;
   if(++entries>4096)throw Error('WORKSPACE_SNAPSHOT_TOO_LARGE');
   const file=path.join(directory,name),relativePath=path.relative(projectRoot,file).replaceAll('\\','/');authorize(relativePath);
   const stat=lstatSync(file,{bigint:true});if(stat.isSymbolicLink())throw Error('WORKSPACE_REPARSE_REFUSED');
   if(stat.isDirectory()){records.push({directory:path.relative(root,file).replaceAll('\\','/')});visit(file);continue;}
   if(!stat.isFile())throw Error('WORKSPACE_FILE_REQUIRED');
   if(stat.nlink!==1n)throw Error('WORKSPACE_HARDLINK_UNSUPPORTED');
   bytes+=Number(stat.size);if(bytes>64*1024*1024)throw Error('WORKSPACE_SNAPSHOT_TOO_LARGE');
   const fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));try{
    const before=fstatSync(fd,{bigint:true});if(!before.isFile()||before.nlink!==1n||before.dev!==stat.dev||before.ino!==stat.ino||before.size!==stat.size||before.ctimeNs!==stat.ctimeNs||before.mtimeNs!==stat.mtimeNs)throw Error('WORKSPACE_CONTENT_CHANGED');
    const hash=createHash('sha256'),gitHash=options.gitMetadata?createHash('sha1').update(`blob ${before.size}\0`):null,buffer=Buffer.alloc(65536);
    for(;;){if(Date.now()>deadline)throw Error('WORKSPACE_SNAPSHOT_TIMEOUT');const length=readSync(fd,buffer,0,buffer.length,null);if(length===0)break;const data=buffer.subarray(0,length);hash.update(data);gitHash?.update(data);}
    const after=fstatSync(fd,{bigint:true}),named=lstatSync(file,{bigint:true});
    if(!after.isFile()||!named.isFile()||after.nlink!==1n||named.nlink!==1n||after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||after.mtimeNs!==before.mtimeNs||after.ctimeNs!==before.ctimeNs||named.ino!==before.ino||named.dev!==before.dev||named.size!==after.size||named.mtimeNs!==after.mtimeNs||named.ctimeNs!==after.ctimeNs||named.isSymbolicLink())throw Error('WORKSPACE_CONTENT_CHANGED');
    records.push({path:path.relative(root,file).replaceAll('\\','/'),sha256:hash.digest('hex'),size:Number(before.size),...(gitHash?{gitBlobSha1:gitHash.digest('hex')}:{})});
   }finally{closeSync(fd);}
  }
  const end=lstatSync(directory,{bigint:true});if(initial.ino!==end.ino||initial.dev!==end.dev||initial.mtimeNs!==end.mtimeNs||initial.ctimeNs!==end.ctimeNs||JSON.stringify(names)!==JSON.stringify(readdirSync(directory).sort()))throw Error('WORKSPACE_CONTENT_CHANGED');
 };
 visit(root);if(realpathSync(root)!==root)throw Error('WORKSPACE_CONTENT_CHANGED');
 return {contentHash:createHash('sha256').update(JSON.stringify(records)).digest('hex'),records,bytes};
}

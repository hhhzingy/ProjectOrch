import path from 'node:path';
import {lstatSync, realpathSync} from 'node:fs';
import type {Store} from '@projectorch/persistence';
import {isWellFormedPathTemplate,templateInside} from '@projectorch/domain/policy';
import {readProjectPolicy} from '../auth/project-policy.js';
import {NativeRpcError} from './stdio-peer.js';

export type CodexSandboxPolicy =
 | {readonly type:'readOnly';readonly networkAccess:false}
 | {readonly type:'workspaceWrite';readonly writableRoots:readonly string[];readonly networkAccess:false;readonly excludeTmpdirEnvVar:true;readonly excludeSlashTmp:true};
export const readOnlySandbox = ():CodexSandboxPolicy => ({type:'readOnly',networkAccess:false});

/** 每次读取持久授权；不依赖共享全局开关，不自动迁移或扩大旧路径授权。 */
export function roleCodexSandbox(store:Store, projectId:string, roleId:string, workspaceRoot:string):CodexSandboxPolicy {
 const deny=(code:string):never=>{throw new NativeRpcError(code,'not_sent');};
 const row=store.db.prepare('SELECT p.canonical_root,p.user_paused,r.permission_profile,r.permission_profile_revision,r.scope_paths_json,r.desired_state FROM projects p JOIN roles r ON r.project_id=p.id WHERE p.id=? AND r.id=?').get(projectId,roleId);
 if(!row) return deny('CODEX_SANDBOX_ROLE_NOT_FOUND');
 if(row.user_paused===1||row.desired_state!=='enabled')return deny('CODEX_SANDBOX_ROLE_NOT_ENABLED');
 const policy=readProjectPolicy(store.db,projectId),profile=policy.profiles.find(p=>p.id===row.permission_profile&&p.revision===row.permission_profile_revision);
 if(!profile||profile.roleIds.length&&!profile.roleIds.includes(roleId))return deny('CODEX_SANDBOX_PROFILE_CONFLICT');
 if(policy.writeIsolation==='enforced_paths')return deny('PATH_ENFORCEMENT_UNAVAILABLE');
 let root:string,cwd:string;
 try{
  root=realpathSync.native(String(row.canonical_root));cwd=realpathSync.native(workspaceRoot);
  const relative=path.relative(root,cwd);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))return deny('CODEX_SANDBOX_WORKSPACE_OUTSIDE_PROJECT');
  // 路径中途的 junction/symlink 不能通过 canonicalize 被悄悄转成另一授权目录。
  if(path.relative(path.resolve(workspaceRoot),cwd)!=='')return deny('CODEX_SANDBOX_WORKSPACE_IDENTITY_CHANGED');
  for(let cursor=path.resolve(workspaceRoot);;cursor=path.dirname(cursor)){
   if(lstatSync(cursor).isSymbolicLink())return deny('CODEX_SANDBOX_WORKSPACE_IDENTITY_CHANGED');
   if(path.relative(root,cursor)==='')break;
   if(path.dirname(cursor)===cursor)return deny('CODEX_SANDBOX_WORKSPACE_OUTSIDE_PROJECT');
  }
 }catch(error){if(error instanceof NativeRpcError)throw error;return deny('CODEX_SANDBOX_WORKSPACE_UNAVAILABLE');}
 if(profile.writePaths.length===0)return readOnlySandbox();
 const relative=path.relative(root,cwd).replaceAll('\\','/');
 const subtree=relative?relative+'/**':'**';
 const scopes=JSON.parse(String(row.scope_paths_json)) as string[];
 if(!Array.isArray(scopes)||scopes.some(p=>typeof p!=='string'||!isWellFormedPathTemplate(p)))return deny('CODEX_SANDBOX_SCOPE_INVALID');
 // workspaceWrite 隐含允许 cwd 及递归子目录；只有完整子树授权才能无扩大地映射。
 if(!templateInside(profile.writePaths,[subtree])||scopes.length&&!templateInside(scopes,[subtree]))return deny('CODEX_SANDBOX_RECURSIVE_GRANT_REQUIRED');
 return {type:'workspaceWrite',writableRoots:[cwd],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true};
}

export function bindingCodexSandbox(store:Store,bindingId:string,workspaceRoot:string):CodexSandboxPolicy {
 const row=store.db.prepare('SELECT b.project_id,b.role_id,s.native_workspace_id FROM role_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.id=? AND b.ended_at IS NULL').get(bindingId);
 if(!row||!row.native_workspace_id||path.resolve(String(row.native_workspace_id))!==path.resolve(workspaceRoot))throw new NativeRpcError('CODEX_SANDBOX_BINDING_CHANGED','not_sent');
 return roleCodexSandbox(store,String(row.project_id),String(row.role_id),workspaceRoot);
}

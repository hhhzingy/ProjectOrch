import type {Store} from '@projectorch/persistence';
import {parseContract} from '@projectorch/contracts';
import {canonicalJson} from '@projectorch/persistence/outbox';
import {parsePermissionProfile,templateInside,validateGrant} from '@projectorch/domain/policy';
import {repositoryScope} from '@projectorch/domain/artifacts/git';
import {assertAgentPrincipalCurrent,type AgentPrincipal} from '../auth/agent-credential.js';
import {authorizeAgentAction} from '../auth/policy-check.js';
import {readProjectPolicy} from '../auth/project-policy.js';
import {reserveAgentOperationWithin} from './agent-command-source.js';
import {validateChangesetReferences,applyReservedChangesetWithin} from './user-changesets.js';

interface Services{readonly now:()=>number;readonly profileInput?:unknown;readonly assertTrustedConnection?:()=>void;}

/** 固定变更集逐操作授权；change.apply不能替代各操作权限或变成本机用户。 */
export function applyChangesetForAgent(store:Store,principal:AgentPrincipal,raw:unknown,services:Services){
 const input=parseContract('changeset',JSON.parse(canonicalJson(raw)));
 if(input.projectId!==principal.projectId)throw new Error('FORBIDDEN:PROJECT_ISOLATION');
 return store.transaction(db=>{
  const verified:unknown=services.assertTrustedConnection?.();if(verified&&typeof (verified as {then?:unknown}).then==='function'){void Promise.resolve(verified).catch(()=>undefined);throw new Error('ASYNC_TOOL_CONNECTION_GUARD_FORBIDDEN');}
  const now=services.now();assertAgentPrincipalCurrent(store,principal,now);
  const check=(action:string,path?:string,kind:'read'|'write'='write')=>{
   const decision=authorizeAgentAction(store,principal,services.profileInput,{action,targetProjectId:principal.projectId,kind,...(path?{path}:{})},now);
   if(!decision.allowed)throw new Error(`FORBIDDEN:${decision.reason}`);
  };
  check('change.apply');
  const policy=readProjectPolicy(db,principal.projectId);
  const caller=db.prepare('SELECT permission_profile,permission_profile_revision,scope_paths_json FROM roles WHERE id=? AND project_id=?').get(principal.roleId,principal.projectId);
  const parent=policy.profiles.find(p=>p.id===caller?.permission_profile&&p.revision===caller?.permission_profile_revision);
  if(!parent)throw new Error('POLICY_PROFILE_REVISION_CONFLICT');
  const parentProfile=parsePermissionProfile(parent),parentScopes=JSON.parse(String(caller?.scope_paths_json)) as string[];
  if(input.caseId){const issue=db.prepare('SELECT owner_role_id,state FROM cases WHERE id=? AND project_id=?').get(input.caseId,principal.projectId);if(!issue||issue.owner_role_id!==principal.roleId||!['open','assigned','investigating'].includes(String(issue.state)))throw new Error('CASE_NOT_ASSIGNED_TO_CALLER');}
  for(const operation of input.operations){
   if(operation.type==='plan.revise')throw new Error('CAPABILITY_UNSUPPORTED:plan.revise');
   const target=operation.type.startsWith('role.')?`roles/${'localRef' in operation?operation.localRef:'roleId' in operation?operation.roleId:''}`:operation.type.startsWith('task.')?`tasks/${'localRef' in operation?operation.localRef:'taskId' in operation?operation.taskId:''}`:`cases/${'caseId' in operation?operation.caseId:''}`;
   check(operation.type,target);
   if(operation.type==='role.create'||(operation.type==='role.update'&&operation.permissionProfileId!==undefined)){
    if(operation.type==='role.create'&&operation.parentRoleId!==principal.roleId)throw new Error('DELEGATION_PARENT_REQUIRED');
    if(operation.type==='role.update'&&db.prepare('SELECT parent_id FROM roles WHERE id=? AND project_id=?').get(operation.roleId,principal.projectId)?.parent_id!==principal.roleId)throw new Error('DELEGATION_TARGET_NOT_CHILD');
    const child=policy.profiles.find(p=>p.id===operation.permissionProfileId&&p.revision===operation.permissionProfileRevision);
    if(!child)throw new Error('POLICY_PROFILE_REVISION_CONFLICT');
    const grant=validateGrant(parentProfile,parsePermissionProfile(child),1);if(!grant.valid)throw new Error(`DELEGATION_FORBIDDEN:${grant.reason}`);
    const scopes=operation.type==='role.create'?operation.scopePaths:JSON.parse(String(db.prepare('SELECT scope_paths_json FROM roles WHERE id=? AND project_id=?').get(operation.roleId,principal.projectId)?.scope_paths_json??'[]')) as string[];
    if(parentScopes.length&&!templateInside(parentScopes,scopes.length?scopes:[...child.readPaths,...child.writePaths]))throw new Error('DELEGATION_FORBIDDEN:PATH_OUT_OF_SCOPE');
   }
   if(operation.type==='task.create'||operation.type==='task.spec.revise'){
    for(const artifact of operation.spec.inputArtifacts){const a=db.prepare('SELECT a.path_ref,g.repository_path FROM artifacts a LEFT JOIN artifact_git_sources g ON g.artifact_id=a.id AND g.project_id=a.project_id WHERE a.id=? AND a.project_id=? AND a.version=?').get(artifact.artifactId,principal.projectId,artifact.version);if(!a)throw new Error('INPUT_ARTIFACT_NOT_FOUND');check('artifact.read',a.repository_path?repositoryScope(String(a.repository_path)):String(a.path_ref),'read');}
   }
   if(operation.type==='task.create'||operation.type==='task.spec.revise'||operation.type==='task.dependencies.replace'){
    const dependencies=operation.type==='task.dependencies.replace'?operation.dependencies:operation.spec.dependencies;
    for(const dependency of dependencies??[])check('task.read',`tasks/${dependency.taskId}`,'read');
   }
   if(operation.type==='task.spec.revise'||operation.type==='task.dependencies.replace'){
    const impacted=db.prepare('WITH RECURSIVE affected(id) AS (SELECT ? UNION SELECT d.task_id FROM task_dependencies d JOIN affected a ON a.id=d.prerequisite_id WHERE d.project_id=?) SELECT id FROM affected').all(operation.taskId,principal.projectId);
    for(const task of impacted)check(operation.type,`tasks/${String(task.id)}`);
    for(const id of operation.affectedTaskIds)check(operation.type,`tasks/${id}`);
    if(operation.type==='task.spec.revise'){
     const old=db.prepare('SELECT acceptance_json,outputs_json FROM tasks WHERE id=? AND project_id=?').get(operation.taskId,principal.projectId);
     if(old){for(const [previous,next] of [[JSON.parse(String(old.acceptance_json)),operation.spec.acceptance],[JSON.parse(String(old.outputs_json)),operation.spec.outputRequirements]] as [unknown[],readonly unknown[]][]){if(previous.some(p=>!next.some(n=>canonicalJson(n)===canonicalJson(p))))throw new Error('AGENT_CANNOT_WEAKEN_ACCEPTANCE');}}
    }
   }
  }
  const {reservation,sourcePrincipalId}=reserveAgentOperationWithin(store,principal,'management.apply_changes',input,now);
  if(reservation.replay)return reservation.receipt;
  const rounds=Number(db.prepare("SELECT COUNT(*) AS n FROM commands c JOIN agent_command_scopes s ON s.command_id=c.id WHERE s.project_id=? AND s.role_id=? AND c.type='management.apply_changes' AND c.id<>? AND json_extract(c.payload_json,'$.caseId') IS ?").get(principal.projectId,principal.roleId,reservation.commandId,input.caseId??null)?.n);
  if(rounds>=policy.limits.maxManagementRounds)throw new Error('MANAGEMENT_ROUNDS_EXCEEDED');
  const roles=new Map(db.prepare("SELECT r.id,r.desired_state FROM roles r WHERE r.project_id=? AND NOT EXISTS(SELECT 1 FROM project_bootstrap b WHERE b.project_id=r.project_id AND b.role_id=r.id)").all(principal.projectId).map(r=>[String(r.id),String(r.desired_state)]));
  for(const operation of input.operations){if(operation.type==='role.create')roles.set(operation.localRef,'enabled');if(operation.type==='role.enable')roles.set(operation.roleId,'enabled');if(operation.type==='role.disable')roles.set(operation.roleId,'disabled');}
  if([...roles.values()].filter(v=>v!=='disabled').length>policy.limits.maxDynamicRoles)throw new Error('DYNAMIC_ROLE_LIMIT_EXCEEDED');
  validateChangesetReferences(db,input);
  return applyReservedChangesetWithin(db,sourcePrincipalId,reservation.commandId,input,now);
 });
}

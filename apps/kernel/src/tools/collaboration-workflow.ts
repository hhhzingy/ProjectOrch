import {randomUUID} from 'node:crypto';
import type {Store} from '@projectorch/persistence';
import {parseContract,type ContractRegistry} from '@projectorch/contracts';
import {canonicalJson} from '@projectorch/persistence/outbox';
import {readArtifactChunk} from '@projectorch/domain/artifacts/content';
import {workspaceFingerprint} from './workspace-fingerprint.js';
import {settleCompletedOrchestrationsWithin} from './orchestration-tools.js';
import {assertNativeWriteWithin,type NativeWriteProof} from '@projectorch/domain/workspaces';

type Payload<K>=Extract<ContractRegistry['command'],{type:K}>['payload'];
export type Authorize=(action:string,resource:string,kind?:'read'|'write')=>void;
const equal=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
function artifact(store:Store,projectId:string,ref:{artifactId:string;version:string},check:Authorize){
 return readArtifactChunk(store,projectId,ref.artifactId,ref.version,0,path=>check('artifact.read',path,'read'));
}
function exactSet(actual:unknown[],expected:unknown[],code:string){if(!equal([...actual].map(canonicalJson).sort(),[...expected].map(canonicalJson).sort()))throw Error(code);}
function pendingEffects(store:Store,projectId:string,roleId:string,excludedOperationId?:string,ownedWrite?:NativeWriteProof){
 const db=store.db;
 settleCompletedOrchestrationsWithin(store,projectId,Date.now());
 return [
  ...db.prepare("SELECT a.id FROM attempts a JOIN role_bindings b ON b.id=a.binding_id WHERE a.project_id=? AND b.role_id=? AND a.state IN ('dispatching','running','waiting_input','unknown')").all(projectId,roleId).map(r=>'attempt:'+r.id),
  ...db.prepare("SELECT m.id FROM messages m LEFT JOIN agent_command_scopes s ON s.command_id=m.command_id WHERE m.project_id=? AND (m.to_role_id=? OR s.role_id=?) AND m.state IN ('stored','queued','sending','uncertain','delivered')").all(projectId,roleId,roleId).map(r=>'message:'+r.id),
  // 未归属角色的工厂操作也不能忽略；保守记录项目未决外部动作。
  ...db.prepare("SELECT id FROM durable_operations WHERE project_id=? AND state IN ('pending','running','unknown')").all(projectId).filter(r=>r.id!==excludedOperationId).map(r=>'operation:'+r.id),
  ...db.prepare("SELECT id,role_id,operation_id,purpose,state,evidence_json FROM native_write_effects WHERE project_id=? AND state IN ('reserved','active','unknown')").all(projectId).filter(row=>{
   if(!ownedWrite||row.id!==ownedWrite.id||row.role_id!==roleId||row.operation_id!==excludedOperationId||row.purpose!=='factory'||!['reserved','active'].includes(String(row.state)))return true;
   if(row.evidence_json&&JSON.parse(String(row.evidence_json)).localWriteStarted===true)return true;
   assertNativeWriteWithin(store,ownedWrite);return false;
  }).map(row=>'native-write:'+row.id),
 ].sort();
}

export function handoverContract(store:Store,projectId:string,id:string){
 const row=store.db.prepare('SELECT * FROM handovers WHERE id=? AND project_id=?').get(id,projectId);if(!row)throw Error('HANDOVER_NOT_FOUND');
 const pkg=JSON.parse(String(row.package_json));if(!pkg.contract)throw Error('HANDOVER_LEGACY_REQUIRES_REPAIR');
 return parseContract('handover',{...pkg.contract,revision:row.revision,state:row.state});
}

/** 核验和消费共用同一事实检查；只排除本次明确换绑操作，不排除其他未知效果。 */
export function assertHandoverCurrent(store:Store,projectId:string,current:ContractRegistry['handover'],check:Authorize,excludedOperationId?:string,ownedWrite?:NativeWriteProof){
 const db=store.db;
 const epoch=db.prepare('SELECT epoch FROM role_bindings WHERE project_id=? AND role_id=? AND ended_at IS NULL').get(projectId,current.roleId)?.epoch,plan=db.prepare('SELECT plan_revision FROM projects WHERE id=?').get(projectId)?.plan_revision;
 if(epoch!==current.fromBindingEpoch||plan!==current.planRevision)throw Error('HANDOVER_STALE');
 if(pendingEffects(store,projectId,current.roleId,excludedOperationId,ownedWrite).length)throw Error('HANDOVER_PENDING_EFFECTS');
 const tasks=db.prepare("SELECT id AS taskId,spec_revision AS specRevision FROM tasks WHERE project_id=? AND role_id=? AND state NOT IN ('accepted','cancelled') ORDER BY id").all(projectId,current.roleId);
 exactSet(tasks,current.taskSpecRevisions,'HANDOVER_STALE');
 const issues=db.prepare("SELECT id FROM cases WHERE project_id=? AND owner_role_id=? AND state NOT IN ('resolved','closed') ORDER BY id").all(projectId,current.roleId).map(r=>String(r.id));exactSet(issues,current.unresolvedIssueIds,'HANDOVER_STALE');
 for(const task of current.taskSpecRevisions)check('task.read',`tasks/${task.taskId}`,'read');
 artifact(store,projectId,current.artifact,check);
 for(const workspace of current.workspaceVersions)if(workspaceFingerprint(store,projectId,workspace.workspaceId,path=>check(path.startsWith('workspaces/')?'workspace.read':'artifact.read',path,'read'))!==workspace.contentHash)throw Error('HANDOVER_WORKSPACE_CHANGED');
}

export function consumableHandover(store:Store,projectId:string,roleId:string,id:string,check:Authorize,excludedOperationId?:string,ownedWrite?:NativeWriteProof){
 check('handover.read',`handovers/${id}`,'read');const current=handoverContract(store,projectId,id);
 if(current.roleId!==roleId||current.state!=='verified'||current.verifierRoleId===roleId)throw Error('HANDOVER_NOT_VERIFIED_FOR_ROLE');
 if(!store.db.prepare("SELECT 1 FROM roles WHERE id=? AND project_id=? AND desired_state='enabled'").get(current.verifierRoleId,projectId))throw Error('HANDOVER_VERIFIER_INVALID');
 if(store.db.prepare("SELECT 1 FROM handovers WHERE project_id=? AND role_id=? AND id<>? AND state IN ('prepared','verified')").get(projectId,roleId,id))throw Error('HANDOVER_OTHER_PACKAGE_PENDING');
 assertHandoverCurrent(store,projectId,current,check,excludedOperationId,ownedWrite);return current;
}
export function prepareHandoverWithin(store:Store,projectId:string,roleId:string,payload:Payload<'handover.prepare'>,commandId:string,check:Authorize){
 const db=store.db;if(!db.isTransaction)throw Error('COLLABORATION_TRANSACTION_REQUIRED');
 if(payload.roleId!==roleId)throw Error('HANDOVER_ROLE_NOT_OWNED');
 const binding=db.prepare('SELECT id,epoch FROM role_bindings WHERE project_id=? AND role_id=? AND ended_at IS NULL').get(projectId,roleId);
 if(!binding||binding.epoch!==payload.expectedBindingEpoch)throw Error('HANDOVER_BINDING_NOT_CURRENT');
 if(payload.verifierRoleId===roleId||!db.prepare("SELECT 1 FROM roles WHERE id=? AND project_id=? AND desired_state='enabled'").get(payload.verifierRoleId,projectId))throw Error('HANDOVER_VERIFIER_INVALID');
 const tasks=db.prepare("SELECT id AS taskId,spec_revision AS specRevision FROM tasks WHERE project_id=? AND role_id=? AND state NOT IN ('accepted','cancelled') ORDER BY id").all(projectId,roleId);
 for(const task of tasks)check('task.read',`tasks/${task.taskId}`,'read');
 exactSet(payload.taskSpecRevisions,tasks,'HANDOVER_TASK_SNAPSHOT_INCOMPLETE');
 const issues=db.prepare("SELECT id FROM cases WHERE project_id=? AND owner_role_id=? AND state NOT IN ('resolved','closed') ORDER BY id").all(projectId,roleId).map(r=>String(r.id));
 exactSet(payload.unresolvedIssueIds,issues,'HANDOVER_ISSUE_SNAPSHOT_INCOMPLETE');
 const pending=pendingEffects(store,projectId,roleId);
 // 不猜测进行中/unknown副作用。当前原生轮通常仍运行，必须在结束后重核再消费。
 exactSet(payload.pendingEffects,pending,'HANDOVER_PENDING_EFFECTS_INCOMPLETE');
 for(const version of payload.workspaceVersions)if(workspaceFingerprint(store,projectId,version.workspaceId,path=>check(path.startsWith('workspaces/')?'workspace.read':'artifact.read',path,'read'))!==version.contentHash)throw Error('HANDOVER_WORKSPACE_CHANGED');
 const content=artifact(store,projectId,payload.artifact,check);if(content.encoding!=='utf8'||content.nextOffset!==null)throw Error('HANDOVER_ARTIFACT_JSON_REQUIRED');
 const document=JSON.parse(content.content);if(document.projectId!==projectId||document.roleId!==roleId||document.fromBindingEpoch!==binding.epoch)throw Error('HANDOVER_ARTIFACT_IDENTITY_MISMATCH');
 const id='handover-'+randomUUID(),planRevision=Number(db.prepare('SELECT plan_revision FROM projects WHERE id=?').get(projectId)?.plan_revision);
 const contract=parseContract('handover',{id,projectId,roleId,revision:1,fromBindingEpoch:binding.epoch,planRevision,artifact:payload.artifact,taskSpecRevisions:payload.taskSpecRevisions,workspaceVersions:payload.workspaceVersions,unresolvedIssueIds:payload.unresolvedIssueIds,pendingEffects:payload.pendingEffects,verifierRoleId:payload.verifierRoleId,state:'prepared'});
 const watermark=Number(db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM events WHERE project_id=?').get(projectId)?.n);
 db.prepare("INSERT INTO handovers(id,project_id,role_id,revision,from_binding_epoch,plan_revision,package_json,verifier_role_id,state) VALUES(?,?,?,1,?,?,?,?,'prepared')").run(id,projectId,roleId,binding.epoch,planRevision,JSON.stringify({contract,bindingId:binding.id,commandId,eventWatermark:watermark,document}),payload.verifierRoleId);
 return contract;
}
export function verifyHandoverWithin(store:Store,projectId:string,verifierRoleId:string,payload:Payload<'handover.verify'>,check:Authorize){
 const db=store.db;if(!db.isTransaction)throw Error('COLLABORATION_TRANSACTION_REQUIRED');const current=handoverContract(store,projectId,payload.handoverId);
 if(current.verifierRoleId!==verifierRoleId)throw Error('HANDOVER_NOT_VERIFIER');
 if(current.revision!==payload.expectedRevision||current.state!=='prepared')throw Error('HANDOVER_REVISION_CONFLICT');
 for(const ref of payload.evidence)artifact(store,projectId,ref,check);
 if(payload.decision==='verified'){
  assertHandoverCurrent(store,projectId,current,check);
 }
 db.prepare('UPDATE handovers SET state=?,revision=revision+1 WHERE id=? AND project_id=? AND revision=?').run(payload.decision, current.id,projectId,current.revision);
 return handoverContract(store,projectId,current.id);
}

export function integrationContract(store:Store,projectId:string,id:string){
 const row=store.db.prepare('SELECT * FROM integrations WHERE id=? AND project_id=?').get(id,projectId);if(!row)throw Error('INTEGRATION_NOT_FOUND');
 const stored=JSON.parse(String(row.checks_json));if(!stored.contract)throw Error('INTEGRATION_LEGACY_REQUIRES_REPAIR');
 return parseContract('integration',{...stored.contract,state:row.state});
}
export function requestIntegrationWithin(store:Store,projectId:string,roleId:string,payload:Payload<'integration.request'>,commandId:string,check:Authorize){
 const db=store.db;if(!db.isTransaction)throw Error('COLLABORATION_TRANSACTION_REQUIRED');
 const task=db.prepare('SELECT role_id,spec_revision FROM tasks WHERE id=? AND project_id=?').get(payload.taskId,projectId);
 if(!task||task.role_id!==roleId||task.spec_revision!==payload.taskRevision)throw Error('INTEGRATION_TASK_NOT_CURRENT');
 check('task.read',`tasks/${payload.taskId}`,'read');check('workspace.read',`workspaces/${payload.targetWorkspaceId}`,'read');
 const workspace=db.prepare('SELECT base_version,state FROM workspaces WHERE id=? AND project_id=?').get(payload.targetWorkspaceId,projectId);
 if(!workspace||workspace.state!=='available'||workspace.base_version!==payload.targetVersion)throw Error('INTEGRATION_TARGET_VERSION_CONFLICT');
 for(const ref of payload.artifacts)artifact(store,projectId,ref,check);
 for(const ref of payload.checkRefs){check('check.read',`checks/${ref.id}`,'read');if(!db.prepare('SELECT 1 FROM check_definitions WHERE project_id=? AND id=? AND version=? AND enabled=1').get(projectId,ref.id,ref.version))throw Error('INTEGRATION_CHECK_UNAVAILABLE');}
 const id='integration-'+randomUUID(),contract=parseContract('integration',{id,projectId,revision:1,taskId:payload.taskId,targetWorkspaceId:payload.targetWorkspaceId,targetVersion:payload.targetVersion,artifacts:payload.artifacts,checkRefs:payload.checkRefs,state:'pending',evidence:[]});
 db.prepare("INSERT INTO integrations(id,project_id,task_id,target_version,artifacts_json,checks_json,state) VALUES(?,?,?,?,?,?,'pending')").run(id,projectId,payload.taskId,payload.targetVersion,JSON.stringify(payload.artifacts),JSON.stringify({contract,commandId,taskSpecRevision:payload.taskRevision}));
 // 请求不执行合并，也不把声明检查写成通过；集成执行及成果复核仍由任务和受信检查链完成。
 return contract;
}

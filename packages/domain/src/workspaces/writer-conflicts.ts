import path from 'node:path';
import {createHash} from 'node:crypto';
import {realpathSync,statSync} from 'node:fs';
import type {Store} from '@projectorch/persistence';
import {isWellFormedPathTemplate} from '../policy/index.js';

export interface OwnedWriterReservation {
 readonly dispatchId:string;readonly dispatchOwnerKey:string;readonly dispatchFence:number;
 readonly attemptId:string;readonly projectId:string;readonly workspaceId:string;
 readonly taskId:string;readonly taskRevision:number;readonly workspaceFence:number;
 readonly bindingId:string;readonly bindingEpoch:number;readonly driverOwnerKey:string;
}
export type WriterConflict='identity'|'overlap'|'reservation';
export interface NativeWriteProof {readonly id:string;readonly ownerKey:string;readonly fence:number;readonly proofSha256:string;}
const normalize=(value:string)=>{const result=path.resolve(value);return process.platform==='win32'?result.toLowerCase():result;};
const contains=(parent:string,child:string)=>{const relative=path.relative(parent,child);return relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
const overlaps=(left:string,right:string)=>contains(left,right)||contains(right,left);
function actualRoot(value:string){const actual=normalize(realpathSync.native(value));if(actual!==normalize(value)||!statSync(value).isDirectory())throw Error('WRITER_IDENTITY_CHANGED');return actual;}
function declaredRoot(value:string){
 let cursor=path.resolve(value);const tails:string[]=[];
 for(;;){try{const actual=normalize(realpathSync.native(cursor));if(actual!==normalize(cursor))throw Error('WRITER_IDENTITY_CHANGED');return normalize(path.resolve(actual,...tails));}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))throw error;const parent=path.dirname(cursor);if(parent===cursor)throw error;tails.unshift(path.basename(cursor));cursor=parent;}}
}
function roots(row:Record<string,unknown>){
 const workspace=actualRoot(String(row.canonical_path)),project=actualRoot(String(row.canonical_root)),result=[workspace];
 const writes:unknown=JSON.parse(String(row.write_paths_json));
 if(!Array.isArray(writes)||writes.some(p=>typeof p!=='string'||!isWellFormedPathTemplate(p)))return [...result,project];
 for(const template of writes as string[]){const parts=template.split('/'),wildcard=parts.indexOf('*'),literal=parts.slice(0,wildcard<0?undefined:wildcard).join('/');result.push(declaredRoot(path.resolve(project,literal||'.')));}
 return result;
}

/** 同库真实物理写范围。只允许精确生产预约排除自身，unknown从不豁免或释放。 */
export function workspaceWriterConflict(store:Store,projectId:string,workspaceId:string,self?:OwnedWriterReservation):WriterConflict|null{
 const db=store.db;
 const target=db.prepare('SELECT w.*,p.canonical_root FROM workspaces w JOIN projects p ON p.id=w.project_id WHERE w.id=? AND w.project_id=?').get(workspaceId,projectId);
 if(!target)return 'identity';
 let targetRoots:string[];try{targetRoots=roots(target);}catch{return 'identity';}
 let ownId:string|null=null;
 if(self){
  if(!db.isTransaction||self.projectId!==projectId||self.workspaceId!==workspaceId)return 'reservation';
  const own=db.prepare(`SELECT r.id FROM workspace_reservations r
   JOIN attempts a ON a.id=? AND a.project_id=r.project_id AND a.workspace_id=r.workspace_id AND a.task_id=r.task_id AND a.task_revision=r.task_revision
   JOIN execution_dispatches d ON d.id=? AND d.attempt_id=a.id AND d.project_id=a.project_id AND d.workspace_id=a.workspace_id AND d.task_id=a.task_id AND d.task_revision=a.task_revision AND d.binding_id=a.binding_id AND d.binding_epoch=a.binding_epoch
   WHERE r.id=? AND r.project_id=? AND r.workspace_id=? AND r.task_id=? AND r.task_revision=? AND r.fence=? AND r.state='reserved'
   AND d.workspace_fence=r.fence AND d.owner_key=? AND d.fence=? AND d.driver_owner_key=?
   AND a.binding_id=? AND a.binding_epoch=? AND a.state IN ('dispatching','running') AND d.phase IN ('reserved','sending','running')`)
   .get(self.attemptId,self.dispatchId,`res-${self.attemptId}`,projectId,workspaceId,self.taskId,self.taskRevision,self.workspaceFence,self.dispatchOwnerKey,self.dispatchFence,self.driverOwnerKey,self.bindingId,self.bindingEpoch);
  if(!own)return 'reservation';ownId=String(own.id);
 }
 return physicalWriterConflict(store,projectId,targetRoots,ownId&&self?{workspaceId,reservationId:ownId,taskId:self.taskId}:undefined);
}

/** planned目录使用真实项目祖先校验；不存在不会回退当前工作目录。 */
export function nativeWriteScope(store:Store,projectId:string,targetRoot:string,writes:readonly string[]=[]){
 const project=store.db.prepare('SELECT canonical_root FROM projects WHERE id=?').get(projectId);
 if(!project||!path.isAbsolute(targetRoot))throw Error('NATIVE_WRITE_SCOPE_REQUIRED');
 const projectRoot=actualRoot(String(project.canonical_root)),root=declaredRoot(targetRoot);
 if(!contains(projectRoot,root))throw Error('NATIVE_WRITE_SCOPE_OUTSIDE_PROJECT');
 const result=[root];
 for(const template of writes){if(!isWellFormedPathTemplate(template))throw Error('NATIVE_WRITE_SCOPE_INVALID');const parts=template.split('/'),wildcard=parts.indexOf('*');result.push(declaredRoot(path.resolve(projectRoot,parts.slice(0,wildcard<0?undefined:wildcard).join('/')||'.')));}
 return {root,roots:result};
}

export function readOwnedNativeWrite(store:Store,proof:NativeWriteProof){
 if(!store.db.isTransaction)throw Error('NATIVE_WRITE_TRANSACTION_REQUIRED');
 const row=store.db.prepare("SELECT * FROM native_write_effects WHERE id=? AND owner_key=? AND fence=? AND proof_sha256=? AND state IN ('reserved','active')").get(proof.id,proof.ownerKey,proof.fence,proof.proofSha256);
 if(!row)throw Error('NATIVE_WRITE_OWNER_OR_FENCE_LOST');
 if(nativeWriteSourceDigest(store,String(row.source_kind),String(row.source_id),String(row.project_id))!==row.source_sha256)throw Error('NATIVE_WRITE_SOURCE_CHANGED');
 if(row.binding_id!==null){
  const binding=store.db.prepare('SELECT s.harness_id,s.host_id,s.profile_id,s.native_conversation_id,s.native_workspace_id FROM role_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.id=? AND b.project_id=? AND b.role_id=? AND b.epoch=? AND b.ended_at IS NULL').get(String(row.binding_id),String(row.project_id),String(row.role_id),Number(row.binding_epoch));
  if(!binding)throw Error('NATIVE_WRITE_BINDING_CHANGED');
  const session=JSON.parse(String(row.session_json));
  if(session.harnessId!==binding.harness_id||session.hostId!==binding.host_id||session.profileId!==binding.profile_id||session.nativeConversationId!==binding.native_conversation_id||(session.nativeWorkspaceId??null)!==(binding.native_workspace_id??null))throw Error('NATIVE_WRITE_SESSION_CHANGED');
 }
 if(row.source_kind==='message'){
  if(!store.db.prepare("SELECT 1 FROM messages WHERE id=? AND project_id=? AND to_role_id=? AND state IN ('queued','sending')").get(String(row.source_id),String(row.project_id),String(row.role_id)))throw Error('NATIVE_WRITE_SOURCE_CHANGED');
 }else{
  const operation=store.db.prepare('SELECT state FROM durable_operations WHERE id=? AND project_id=?').get(String(row.source_id),String(row.project_id));
  if(!operation||(row.purpose!=='binding-tools'&&!factoryWriteSourceAvailable(store,String(row.project_id),String(row.source_id),String(row.role_id))))throw Error('NATIVE_WRITE_SOURCE_CHANGED');
 }
 return row;
}

/** bootstrap是多角色父意图：其他角色失败不能把独立且未发出的本角色伪装成unknown。 */
export function factoryWriteSourceAvailable(store:Store,projectId:string,sourceId:string,roleId:string){
 const operation=store.db.prepare('SELECT kind,state,steps_json FROM durable_operations WHERE id=? AND project_id=?').get(sourceId,projectId);if(!operation)return false;
 if(['pending','running'].includes(String(operation.state)))return true;
 const prior=store.db.prepare("SELECT source_sha256,evidence_json FROM native_write_effects WHERE project_id=? AND source_kind='factory' AND source_id=? AND role_id=? AND state='settled' AND phase='not_sent' ORDER BY fence DESC LIMIT 1").get(projectId,sourceId,roleId);
 const notSent=prior?.evidence_json&&JSON.parse(String(prior.evidence_json)).notSent===true&&prior.source_sha256===nativeWriteSourceDigest(store,'factory',sourceId,projectId);
 if(operation.kind!=='project.bootstrap')return operation.state==='failed'&&!!notSent;
 const steps=(JSON.parse(String(operation.steps_json)) as {step:string;state:string}[]).filter(s=>s.step.startsWith(`role:${roleId}:`)),prefix=`role:${roleId}:`,index=steps.findLastIndex(s=>s.step===prefix+'factory-call'||s.step===prefix+'session-not-sent');
 if(index<0)return !steps.some(s=>s.state==='unknown'||s.state==='failed'||['create-thread','create-session','session-identity'].some(name=>s.step===prefix+name));
 if(steps[index]?.step===prefix+'session-not-sent')return !!notSent&&!steps.slice(index+1).some(s=>s.state==='unknown');
 return !steps.slice(index+1).some(s=>s.state==='unknown'||s.state==='failed')&&!!store.db.prepare("SELECT 1 FROM native_write_effects WHERE project_id=? AND source_kind='factory' AND source_id=? AND role_id=? AND state IN ('reserved','active')").get(projectId,sourceId,roleId);
}

export function nativeWriteSourceDigest(store:Store,kind:string,id:string,projectId:string){
 const source=kind==='factory'?store.db.prepare('SELECT operation_key,kind,payload_json,created_at FROM durable_operations WHERE id=? AND project_id=?').get(id,projectId):store.db.prepare('SELECT m.command_id,m.to_role_id,m.task_id,m.kind,m.body,m.created_at,c.source_principal_id,c.request_id,c.request_hash,c.payload_json FROM messages m JOIN commands c ON c.id=m.command_id AND c.project_id=m.project_id WHERE m.id=? AND m.project_id=?').get(id,projectId);
 if(!source)throw Error('NATIVE_WRITE_SOURCE_REQUIRED');return createHash('sha256').update(JSON.stringify(source)).digest('hex');
}

export function nativeWriteConflict(store:Store,projectId:string,targetRoot:string,writes:readonly string[]=[],self?:NativeWriteProof):WriterConflict|null{
 let targetRoots:string[];try{targetRoots=nativeWriteScope(store,projectId,targetRoot,writes).roots;}catch{return 'identity';}
 if(self){try{const row=readOwnedNativeWrite(store,self);if(row.project_id!==projectId||row.target_root!==nativeWriteScope(store,projectId,targetRoot,writes).root)return 'reservation';}catch{return 'reservation';}}
 return physicalWriterConflict(store,projectId,targetRoots,undefined,self?.id);
}

function physicalWriterConflict(store:Store,projectId:string,targetRoots:readonly string[],ownTask?:{workspaceId:string;reservationId:string;taskId:string},ownEffectId?:string):WriterConflict|null{
 const db=store.db;
 const writers=db.prepare("SELECT w.*,p.canonical_root FROM workspaces w JOIN projects p ON p.id=w.project_id WHERE w.state IN ('reserved','unknown') OR EXISTS(SELECT 1 FROM workspace_reservations r WHERE r.workspace_id=w.id AND r.project_id=w.project_id AND r.state IN ('reserved','unknown'))").all();
 for(const writer of writers){
  const reservations=db.prepare("SELECT id FROM workspace_reservations WHERE project_id=? AND workspace_id=? AND state IN ('reserved','unknown')").all(String(writer.project_id),String(writer.id));
  const isOwn=ownTask!==undefined&&writer.id===ownTask.workspaceId&&writer.project_id===projectId;
  if(isOwn&&writer.state!=='unknown'&&reservations.length===1&&reservations[0]?.id===ownTask?.reservationId&&(writer.owner_task_id===null||writer.owner_task_id===ownTask?.taskId))continue;
  let writerRoots:string[];try{writerRoots=roots(writer);}catch{return 'identity';}
  if(writerRoots.some(a=>targetRoots.some(b=>overlaps(a,b))))return 'overlap';
 }
 for(const effect of db.prepare("SELECT id,target_root,scope_json,project_id,evidence_json FROM native_write_effects WHERE state IN ('reserved','active','unknown')").all()){
  if(effect.id===ownEffectId)continue;
  if(effect.evidence_json&&JSON.parse(String(effect.evidence_json)).unattributed===true&&effect.project_id===projectId)return 'reservation';
  let effectRoots:string[];try{effectRoots=nativeWriteScope(store,String(effect.project_id),String(effect.target_root),JSON.parse(String(effect.scope_json))).roots;}catch{return 'identity';}
  if(effectRoots.some(a=>targetRoots.some(b=>overlaps(a,b))))return 'overlap';
 }
 // 升级前无新预约来源的旧未知不能被忽略，也不补造owned。
 const legacyProjects=new Set<string>();
 for(const message of db.prepare("SELECT project_id FROM messages m WHERE state IN ('sending','uncertain') AND NOT EXISTS(SELECT 1 FROM native_write_effects n WHERE n.source_kind='message' AND n.source_id=m.id AND n.project_id=m.project_id)").all())legacyProjects.add(String(message.project_id));
 for(const operation of db.prepare("SELECT id,kind,project_id,payload_json,steps_json,state FROM durable_operations WHERE kind IN ('project.bootstrap','role.provision','message.send')").all()){
  const payload=JSON.parse(String(operation.payload_json)),steps=JSON.parse(String(operation.steps_json)) as {step:string;state:string}[];
  const roles:unknown[]=Array.isArray(payload.roles)?payload.roles.map((r:{roleId?:unknown})=>r.roleId):[payload.roleId??payload.toRoleId];
  for(const role of roles){
   if(typeof role!=='string'||db.prepare("SELECT 1 FROM native_write_effects WHERE source_kind='factory' AND source_id=? AND project_id=? AND role_id=?").get(String(operation.id),String(operation.project_id),role))continue;
   const prefix=operation.kind==='message.send'?'':`role:${role}:`;
   const boundary=[...steps].reverse().find(s=>s.step===prefix+'factory-call'||s.step===prefix+'session-not-sent');
   const boundaryIndex=steps.findLastIndex(s=>s.step===prefix+'factory-call'||s.step===prefix+'session-not-sent');
   const created=steps.some(s=>s.state==='observed'&&['create-thread','create-session','session-identity'].some(name=>s.step===prefix+name));
   if(boundary?.step===prefix+'session-not-sent'&&!created&&!steps.slice(boundaryIndex+1).some(s=>s.state==='unknown'&&s.step.startsWith(prefix)))continue;
   const unknown=steps.some(s=>s.state==='unknown'&&s.step.startsWith(prefix)&&/factory-call|create-thread|create-session|session-unknown|blocked/.test(s.step));
   if(unknown||(boundary?.step===prefix+'factory-call'&&operation.state!=='observed'))legacyProjects.add(String(operation.project_id));
  }
 }
 for(const legacy of legacyProjects){
  if(legacy===projectId)return 'reservation';
  const project=db.prepare('SELECT canonical_root FROM projects WHERE id=?').get(legacy);if(!project)return 'identity';
  let projectRoot:string;try{projectRoot=actualRoot(String(project.canonical_root));}catch{return 'identity';}
  if(targetRoots.some(root=>overlaps(root,projectRoot)))return 'overlap';
 }
 return null;
}

import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import type {Store} from '@projectorch/persistence';
import type {AgentPrincipal} from '../auth/agent-credential.js';
import {canonicalJson} from '@projectorch/persistence/outbox';
import {readArtifactRecord} from '@projectorch/domain/artifacts';
import {readArtifactChunk} from '@projectorch/domain/artifacts/content';
import {assertGitArtifactSource} from '@projectorch/domain/artifacts/git';
import {integrationContract,type Authorize} from '../tools/collaboration-workflow.js';
import {settleCompletedOrchestrationsWithin} from '../tools/orchestration-tools.js';
import {inspectIntegrationTarget,integrationTargetFingerprint,integrationTargetBytes,type IntegrationTargetKind,type IntegrationTarget} from './target.js';
import {trustedCheckDefinitionForRun} from '../checks/registry.js';
import {jsonAssertionParameters,runJsonAssertions} from '../checks/validators.js';
import {pathMatches} from '@projectorch/domain/policy';

type Ref={artifactId:string;version:string};
export interface IntegrationEvaluation {integrationId:string;expectedRevision:number;resultId:string;targetKind:IntegrationTargetKind;contentPath?:string;checkParameters:readonly {checkId:string;checkVersion:string;parameters:unknown}[];}
export interface IntegrationReview {integrationId:string;expectedRevision:number;targetId:string;runIds:readonly string[];decision:'accept'|'reject';reason:string;evidence:readonly Ref[];repairTaskId?:string;}
const sha=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const sessionKey=(row:Record<string,unknown>)=>canonicalJson([row.harness_id,row.host_id,row.profile_id,row.native_conversation_id]);
function bindingSession(store:Store,projectId:string,bindingId:string){const r=store.db.prepare('SELECT s.harness_id,s.host_id,s.profile_id,s.native_conversation_id FROM role_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.id=? AND b.project_id=?').get(bindingId,projectId);if(!r)throw Error('INTEGRATION_SOURCE_BINDING_MISSING');return sessionKey(r);}
function artifact(store:Store,projectId:string,ref:Ref,check:Authorize){return readArtifactChunk(store,projectId,ref.artifactId,ref.version,0,p=>check('artifact.read',p,'read'));}

/** 仅以指定独立主体和真实终态/当前规格处理，不以执行者文字或状态标签代替来源。 */
function context(store:Store,principal:AgentPrincipal,integrationId:string,resultId:string,check:Authorize){
 const db=store.db;if(!db.isTransaction)throw Error('INTEGRATION_TRANSACTION_REQUIRED');const projectId=principal.projectId,current=integrationContract(store,projectId,integrationId),row=db.prepare('SELECT checks_json FROM integrations WHERE id=? AND project_id=?').get(integrationId,projectId),stored=JSON.parse(String(row?.checks_json));
 check('task.read',`tasks/${current.taskId}`,'read');check('task.accept_assigned',`tasks/${current.taskId}`,'write');
 const task=db.prepare('SELECT role_id,spec_revision,acceptance_json,state FROM tasks WHERE project_id=? AND id=?').get(projectId,current.taskId);
 if(!task||task.spec_revision!==stored.taskSpecRevision||task.state==='cancelled')throw Error('INTEGRATION_TASK_STALE');
 const rules=JSON.parse(String(task.acceptance_json)) as {mode:string;reviewerRoleId?:string;independent?:boolean}[];
 if(!rules.some(r=>r.mode==='designated_reviewer'&&r.independent===true&&r.reviewerRoleId===principal.roleId)||task.role_id===principal.roleId)throw Error('INTEGRATION_INDEPENDENT_REVIEWER_REQUIRED');
 const result=db.prepare("SELECT r.*,a.state AS attempt_state,a.binding_id,a.binding_epoch,b.role_id AS source_role,b.ended_at,d.id AS dispatch_id,d.phase,d.native_execution_id,d.workspace_id,d.ended_at AS dispatch_ended_at FROM results r JOIN attempts a ON a.id=r.attempt_id AND a.project_id=r.project_id JOIN role_bindings b ON b.id=a.binding_id AND b.project_id=a.project_id LEFT JOIN execution_dispatches d ON d.attempt_id=a.id AND d.project_id=a.project_id WHERE r.id=? AND r.project_id=? AND r.task_id=? AND r.task_revision=?").get(resultId,projectId,current.taskId,Number(task.spec_revision));
 if(!result||result.outcome!=='succeeded'||result.eligibility!=='current'||result.attempt_state!=='succeeded'||result.source_role!==task.role_id||result.ended_at!==null||result.phase!=='succeeded'||!result.native_execution_id||result.dispatch_ended_at===null||result.workspace_id!==current.targetWorkspaceId)throw Error('INTEGRATION_EXECUTION_NOT_CONFIRMED');
 const native=bindingSession(store,projectId,principal.bindingId);if(native===bindingSession(store,projectId,String(result.binding_id)))throw Error('INTEGRATION_SAME_NATIVE_SELF_REVIEW');
 if(db.prepare("SELECT 1 FROM attempts WHERE project_id=? AND task_id=? AND state IN ('dispatching','running','waiting_input','unknown')").get(projectId,current.taskId))throw Error('INTEGRATION_EXECUTION_UNRESOLVED');
 settleCompletedOrchestrationsWithin(store,projectId,Date.now());
 if(db.prepare("SELECT 1 FROM durable_operations WHERE project_id=? AND state IN ('pending','running','unknown')").get(projectId)||db.prepare("SELECT 1 FROM messages WHERE project_id=? AND to_role_id=? AND state IN ('stored','queued','sending','delivered','uncertain')").get(projectId,String(task.role_id)))throw Error('INTEGRATION_PENDING_EFFECTS');
 if(db.prepare("SELECT 1 FROM goal_holds WHERE project_id=? AND state IN ('pending','awaiting_user')").get(projectId))throw Error('INTEGRATION_GOAL_HELD');
 for(const ref of current.artifacts){
  artifact(store,projectId,ref,check);const input=readArtifactRecord(store,projectId,ref.artifactId);if(!input.taskId||input.taskRevision===null)throw Error('INTEGRATION_ACCEPTED_INPUT_REQUIRED');
  const inputTask=db.prepare("SELECT spec_revision,state FROM tasks WHERE id=? AND project_id=?").get(input.taskId,projectId);if(!inputTask||inputTask.state!=='accepted'||inputTask.spec_revision!==input.taskRevision)throw Error('INTEGRATION_ACCEPTED_INPUT_REQUIRED');
  const candidates=db.prepare("SELECT r.outputs_json,a.binding_id FROM results r JOIN attempts a ON a.id=r.attempt_id AND a.project_id=r.project_id WHERE r.project_id=? AND r.task_id=? AND r.task_revision=? AND r.outcome='succeeded' AND r.eligibility='current' AND a.state='succeeded' AND EXISTS(SELECT 1 FROM acceptances ac WHERE ac.project_id=r.project_id AND ac.result_id=r.id AND ac.decision='accept')").all(projectId,input.taskId,input.taskRevision).filter(r=>(JSON.parse(String(r.outputs_json)) as Ref[]).some(output=>output.artifactId===ref.artifactId&&output.version===ref.version));
  if(candidates.length!==1)throw Error('INTEGRATION_ACCEPTED_INPUT_REQUIRED');if(native===bindingSession(store,projectId,String(candidates[0]?.binding_id)))throw Error('INTEGRATION_SAME_NATIVE_SELF_REVIEW');
 }
 return {current,result,taskSpecRevision:Number(task.spec_revision)};
}

function assertIntegratedOutput(store:Store,projectId:string,taskId:string,spec:number,result:Record<string,unknown>,target:IntegrationTarget,check:Authorize){
 const outputs=JSON.parse(String(result.outputs_json)) as Ref[];let matched=false;
 const project=store.db.prepare('SELECT canonical_root FROM projects WHERE id=?').get(projectId),workspace=store.db.prepare('SELECT canonical_path FROM workspaces WHERE id=? AND project_id=?').get(target.workspaceId,projectId);
 for(const ref of outputs){const record=readArtifactRecord(store,projectId,ref.artifactId);if(record.taskId!==taskId||record.taskRevision!==spec||record.version!==ref.version)throw Error('INTEGRATION_OUTPUT_SOURCE_MISMATCH');artifact(store,projectId,ref,check);
  if(target.kind==='git'&&record.pathRef.startsWith('git:')){const source=assertGitArtifactSource(store,projectId,record.id,p=>check('artifact.read',p,'read'));if(record.version===target.outputVersion&&canonicalJson(source.identity)===canonicalJson(target.repository?.identity))matched=true;}
  else if(target.kind==='files'&&!record.pathRef.startsWith('git:')){const relative=path.relative(path.resolve(String(workspace?.canonical_path),target.contentPath??'.'),path.resolve(String(project?.canonical_root),record.pathRef)).replaceAll('\\','/'),file=target.files.find(f=>f.path===relative);if(file&&file.sha256===record.sha256)matched=true;}
 }
 if(!matched)throw Error('INTEGRATION_ACTUAL_OUTPUT_REQUIRED');
}

/** 固定内置只读验证器在同一事务内运行；无子进程、网络、外部写副作用或继承环境。 */
export function evaluateIntegrationWithin(store:Store,principal:AgentPrincipal,payload:IntegrationEvaluation,commandId:string,check:Authorize,now:number){
 const {current,taskSpecRevision,result}=context(store,principal,payload.integrationId,payload.resultId,check),projectId=principal.projectId,db=store.db;
 if(current.revision!==payload.expectedRevision||!['pending','failed'].includes(current.state))throw Error('INTEGRATION_REVISION_CONFLICT');
 if(current.checkRefs.length>16||payload.checkParameters.length!==current.checkRefs.length||new Set(payload.checkParameters.map(p=>p.checkId+'\0'+p.checkVersion)).size!==payload.checkParameters.length)throw Error('INTEGRATION_CHECK_PARAMETERS_INCOMPLETE');
 const prepared=current.checkRefs.map(ref=>{
  check('check.read',`checks/${ref.id}`,'read');const request=payload.checkParameters.find(p=>p.checkId===ref.id&&p.checkVersion===ref.version);if(!request)throw Error('INTEGRATION_CHECK_PARAMETERS_INCOMPLETE');
  const trusted=trustedCheckDefinitionForRun(store,projectId,ref.id,ref.version),parameters=jsonAssertionParameters(request.parameters);return{ref,trusted,parameters};
 });
 const target=inspectIntegrationTarget(store,projectId,current.targetWorkspaceId,payload.targetKind,current.targetVersion,(action,p)=>check(action,p,'read'),payload.contentPath),targetId='integration-target-'+randomUUID(),revision=current.revision+1;
 assertIntegratedOutput(store,projectId,current.taskId,taskSpecRevision,result,target,check);
 db.prepare('INSERT INTO integration_targets(id,project_id,integration_id,integration_revision,task_id,task_revision,result_id,command_id,actor_binding_id,actor_binding_epoch,target_json,parameters_json,content_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(targetId,projectId,current.id,revision,current.taskId,taskSpecRevision,payload.resultId,commandId,principal.bindingId,principal.bindingEpoch,canonicalJson(target),canonicalJson(payload.checkParameters),target.contentHash,now);
 const runs=[];const commandDeadline=Date.now()+10000;
 for(const {ref,trusted,parameters} of prepared){
  const started=Date.now(),runId='integration-run-'+randomUUID();let outcome:'passed'|'failed'='failed',detail:unknown;
  try{
   for(const file of parameters.files){const workspace=store.db.prepare('SELECT canonical_path FROM workspaces WHERE project_id=? AND id=?').get(projectId,target.workspaceId),project=store.db.prepare('SELECT canonical_root FROM projects WHERE id=?').get(projectId);const resource=path.relative(String(project?.canonical_root),path.resolve(String(workspace?.canonical_path),target.contentPath??'.',file.path)).replaceAll('\\','/');if(!pathMatches(trusted.definition.scopePaths,resource))throw Error('CHECK_DEFINITION_PATH_OUT_OF_SCOPE');}
   const bytes=integrationTargetBytes(store,projectId,target,parameters.files.map(p=>p.path),(a,p)=>check(a,p,'read'));
   const observed=runJsonAssertions(bytes,parameters,Math.min(commandDeadline,started+Number(trusted.definition.timeoutMs)));outcome=observed.outcome;detail=observed.results;
  }catch(error){const message=String((error as Error).message);detail={code:/^(CHECK_|FORBIDDEN)[A-Z_]*$/.test(message)?message:'CHECK_EXECUTION_FAILED'};}
  const ended=Date.now(),evidence={runId,targetId,targetFingerprint:integrationTargetFingerprint(target),baseline:target.baseline,outputVersion:target.outputVersion,contentHash:target.contentHash,taskId:current.taskId,taskSpecRevision,resultId:payload.resultId,checkId:ref.id,checkVersion:ref.version,authorizationId:trusted.authorizationId,entrySha256:trusted.entry.entrySha256,entryManifest:trusted.entry.entryManifest,parametersSha256:sha(parameters),runner:trusted.entry.runner,isolation:trusted.entry.isolation,node:process.version,platform:process.platform,architecture:process.arch,startedAt:started,endedAt:ended,outcome,detail},evidenceSha256=sha(evidence);
  db.prepare('INSERT INTO integration_check_runs(id,project_id,integration_id,target_id,check_id,check_version,authorization_id,command_id,parameters_sha256,outcome,evidence_json,evidence_sha256,started_at,ended_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(runId,projectId,current.id,targetId,ref.id,ref.version,trusted.authorizationId,commandId,sha(parameters),outcome,canonicalJson(evidence),evidenceSha256,started,ended);runs.push({id:runId,checkId:ref.id,checkVersion:ref.version,outcome,evidenceSha256});
 }
 const after=inspectIntegrationTarget(store,projectId,current.targetWorkspaceId,payload.targetKind,current.targetVersion,(a,p)=>check(a,p,'read'),target.contentPath??undefined);if(integrationTargetFingerprint(after)!==integrationTargetFingerprint(target))throw Error('INTEGRATION_TARGET_CHANGED_DURING_CHECK');
 const next={...current,revision,state:'integrating' as const,outputTarget:{id:targetId,kind:target.kind,contentPath:target.contentPath,outputVersion:target.outputVersion,contentHash:target.contentHash,resultId:payload.resultId},checkRuns:runs};
 const stored=JSON.parse(String(db.prepare('SELECT checks_json FROM integrations WHERE id=? AND project_id=?').get(current.id,projectId)?.checks_json));stored.contract=next;
 const changed=db.prepare("UPDATE integrations SET state='integrating',checks_json=? WHERE id=? AND project_id=? AND state=?").run(canonicalJson(stored),current.id,projectId,current.state);if(changed.changes!==1)throw Error('INTEGRATION_REVISION_CONFLICT');return integrationContract(store,projectId,current.id);
}

export function reviewIntegrationWithin(store:Store,principal:AgentPrincipal,payload:IntegrationReview,commandId:string,check:Authorize,now:number){
 const projectId=principal.projectId,db=store.db,targetRow=db.prepare('SELECT * FROM integration_targets WHERE id=? AND project_id=? AND integration_id=?').get(payload.targetId,projectId,payload.integrationId);if(!targetRow)throw Error('INTEGRATION_TARGET_NOT_FOUND');
 const {current,result,taskSpecRevision}=context(store,principal,payload.integrationId,String(targetRow.result_id),check);
 if(current.revision!==payload.expectedRevision||current.state!=='integrating'||current.outputTarget?.id!==payload.targetId)throw Error('INTEGRATION_REVISION_CONFLICT');
 const exactRuns=current.checkRuns??[];if(!exactRuns.length||new Set(payload.runIds).size!==payload.runIds.length||canonicalJson([...payload.runIds].sort())!==canonicalJson(exactRuns.map(r=>r.id).sort()))throw Error('INTEGRATION_EXACT_RUNS_REQUIRED');
 for(const run of exactRuns){check('check.read',`checks/${run.checkId}`,'read');const record=db.prepare('SELECT * FROM integration_check_runs WHERE id=? AND project_id=? AND integration_id=? AND target_id=?').get(run.id,projectId,current.id,payload.targetId);if(!record||record.evidence_sha256!==run.evidenceSha256||sha(JSON.parse(String(record.evidence_json)))!==record.evidence_sha256)throw Error('INTEGRATION_EXACT_RUNS_REQUIRED');if(payload.decision==='accept'){const trusted=trustedCheckDefinitionForRun(store,projectId,run.checkId,run.checkVersion);if(record.authorization_id!==trusted.authorizationId||record.outcome!=='passed')throw Error('INTEGRATION_CHECK_NOT_PASSED');}}
 const frozen=JSON.parse(String(targetRow.target_json)) as IntegrationTarget,actual=inspectIntegrationTarget(store,projectId,current.targetWorkspaceId,frozen.kind,current.targetVersion,(a,p)=>check(a,p,'read'),frozen.contentPath??undefined),targetChanged=integrationTargetFingerprint(actual)!==integrationTargetFingerprint(frozen);if(targetChanged&&payload.decision==='accept')throw Error('INTEGRATION_TARGET_CHANGED_BEFORE_REVIEW');
 if(payload.decision==='accept')assertIntegratedOutput(store,projectId,current.taskId,taskSpecRevision,result,actual,check);
 if(!payload.evidence.length)throw Error('INTEGRATION_REVIEW_EVIDENCE_REQUIRED');for(const ref of payload.evidence){artifact(store,projectId,ref,check);const evidence=readArtifactRecord(store,projectId,ref.artifactId),owner=evidence.taskId?db.prepare('SELECT role_id,spec_revision FROM tasks WHERE id=? AND project_id=?').get(evidence.taskId,projectId):null;if(!owner||owner.role_id!==principal.roleId||owner.spec_revision!==evidence.taskRevision)throw Error('INTEGRATION_INDEPENDENT_EVIDENCE_REQUIRED');}
 let repairTaskRevision:number|null=null;
 if(payload.decision==='reject'){
  if(!payload.repairTaskId)throw Error('INTEGRATION_REPAIR_TASK_REQUIRED');check('task.read',`tasks/${payload.repairTaskId}`,'read');const repair=db.prepare("SELECT t.role_id,t.state,t.spec_revision,r.desired_state FROM tasks t JOIN roles r ON r.id=t.role_id AND r.project_id=t.project_id WHERE t.project_id=? AND t.id=?").get(projectId,payload.repairTaskId);if(!repair||!repair.role_id||repair.desired_state!=='enabled'||!['draft','ready','active','waiting','blocked'].includes(String(repair.state))||payload.repairTaskId===current.taskId)throw Error('INTEGRATION_REPAIR_TASK_REQUIRED');repairTaskRevision=Number(repair.spec_revision);
 }else if(payload.repairTaskId)throw Error('INTEGRATION_ACCEPT_REPAIR_TASK_NOT_ALLOWED');
 const reviewId='integration-review-'+randomUUID();db.prepare('INSERT INTO integration_reviews(id,project_id,integration_id,target_id,command_id,reviewer_binding_id,reviewer_binding_epoch,decision,run_ids_json,evidence_json,repair_task_id,repair_task_revision,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(reviewId,projectId,current.id,payload.targetId,commandId,principal.bindingId,principal.bindingEpoch,payload.decision,canonicalJson(payload.runIds),canonicalJson(payload.evidence),payload.repairTaskId??null,repairTaskRevision,payload.reason,now);
 const next={...current,revision:current.revision+1,state:payload.decision==='accept'?'verified' as const:'failed' as const,evidence:payload.evidence,review:{id:reviewId,decision:payload.decision,reviewerRoleId:principal.roleId,repairTaskId:payload.repairTaskId??null,targetChanged}},stored=JSON.parse(String(db.prepare('SELECT checks_json FROM integrations WHERE id=? AND project_id=?').get(current.id,projectId)?.checks_json));stored.contract=next;
 const changed=db.prepare("UPDATE integrations SET state=?,checks_json=? WHERE id=? AND project_id=? AND state='integrating'").run(next.state,canonicalJson(stored),current.id,projectId);if(changed.changes!==1)throw Error('INTEGRATION_REVISION_CONFLICT');
 if(payload.decision==='accept')db.prepare("INSERT INTO events(id,project_id,type,entity_id,entity_revision,causation_id,body_json,occurred_at) VALUES(?,?,'internal.integration_completed',?,?,?,?,?)").run(randomUUID(),projectId,current.id,next.revision,commandId,canonicalJson({targetId:payload.targetId,outputVersion:frozen.outputVersion,contentHash:frozen.contentHash,runIds:payload.runIds,reviewId}),now);
 return integrationContract(store,projectId,current.id);
}

/** 历史run只读证据；不需要重跑或通过状态，但每次按当前权限核对原目标所有可见路径。 */
export function readIntegrationRunWithin(store:Store,projectId:string,integrationId:string,runId:string,check:Authorize){
 const db=store.db;if(!db.isTransaction)throw Error('INTEGRATION_TRANSACTION_REQUIRED');check('integration.read',`integrations/${integrationId}`,'read');const integration=integrationContract(store,projectId,integrationId);check('task.read',`tasks/${integration.taskId}`,'read');
 const row=db.prepare('SELECT r.*,t.target_json,t.task_revision,t.result_id FROM integration_check_runs r JOIN integration_targets t ON t.id=r.target_id AND t.project_id=r.project_id AND t.integration_id=r.integration_id WHERE r.id=? AND r.project_id=? AND r.integration_id=?').get(runId,projectId,integrationId);if(!row)throw Error('INTEGRATION_RUN_NOT_FOUND');
 check('check.read',`checks/${row.check_id}`,'read');const target=JSON.parse(String(row.target_json)) as IntegrationTarget;check('workspace.read',`workspaces/${target.workspaceId}`,'read');
 const workspace=db.prepare('SELECT canonical_path FROM workspaces WHERE id=? AND project_id=?').get(target.workspaceId,projectId),project=db.prepare('SELECT canonical_root FROM projects WHERE id=?').get(projectId);if(!workspace||!project)throw Error('INTEGRATION_TARGET_NOT_FOUND');
 for(const file of target.files){const relative=file.path??file.directory;if(!relative)throw Error('INTEGRATION_TARGET_RECORD_INVALID');const resource=path.relative(String(project.canonical_root),path.resolve(String(workspace.canonical_path),target.contentPath??'.',relative)).replaceAll('\\','/');check('artifact.read',resource,'read');}
 const evidence=JSON.parse(String(row.evidence_json));if(sha(evidence)!==row.evidence_sha256||evidence.targetFingerprint!==integrationTargetFingerprint(target)||evidence.runId!==runId||evidence.targetId!==row.target_id||evidence.resultId!==row.result_id||evidence.taskSpecRevision!==row.task_revision)throw Error('INTEGRATION_RUN_EVIDENCE_MISMATCH');
 return {id:runId,integrationId,targetId:String(row.target_id),evidenceSha256:String(row.evidence_sha256),evidence,target};
}

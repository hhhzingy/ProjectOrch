import { createHash } from "node:crypto";
import type { Store } from "@projectorch/persistence";
import { canonicalJson } from "@projectorch/persistence/outbox";
import { parseContract } from "@projectorch/contracts";
import { assertAgentPrincipalCurrent, type AgentPrincipal } from "../auth/agent-credential.js";
import { authorizeAgentAction } from "../auth/policy-check.js";
import { readProjectPolicy } from "../auth/project-policy.js";
import { readTaskDetail } from "../http/task-queries.js";
import { readRole } from "@projectorch/domain/roles";
import { repositoryScope } from '@projectorch/domain/artifacts/git';
import {questionContract} from './question-workflow.js';

type AgentQuery = "task.read" | "task.list" | "result.read" | "policy.read" | "role.read" | "role.list" | "inbox.read"|'question.read'|'question.list';

/** result.read的只读增量视图；主体来自服务器裁决，不开放命令回执。 */
export interface ResultDecisionView {
 readonly decisionId:string;readonly resultId:string;readonly taskRevision:number;readonly ruleId:string;
 readonly decision:string;readonly reviewer:{readonly kind:'bound_agent'|'unresolved';readonly roleId:string|null};readonly createdAt:number;
 readonly evidenceArtifactIds:readonly string[];readonly evidenceRestricted:boolean;readonly reason:string|null;
}

function snapshotPage<T extends { readonly id: string }>(store: Store, principal: AgentPrincipal, type: AgentQuery, items: readonly T[], cursor: string | undefined, limit: number): unknown {
  const role = store.db.prepare("SELECT revision,scope_paths_json,permission_profile,permission_profile_revision FROM roles WHERE id=? AND project_id=?").get(principal.roleId, principal.projectId);
  const policy = readProjectPolicy(store.db, principal.projectId);
  const signature = createHash("sha256").update(canonicalJson({ type, projectId: principal.projectId, roleId: principal.roleId, bindingId: principal.bindingId, bindingEpoch: principal.bindingEpoch, role, policy, items })).digest("hex");
  let offset = 0;
  if (cursor !== undefined) {
    if (cursor.length > 2048) throw new Error("INVALID_PAGE_CURSOR");
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw new Error("INVALID_PAGE_CURSOR"); }
    if (!parsed || typeof parsed !== "object" || !("signature" in parsed) || !("after" in parsed) || parsed.signature !== signature || typeof parsed.after !== "string") throw new Error("PAGE_CURSOR_STALE");
    const after = parsed.after;
    const found = items.findIndex(item => item.id === after);
    if (found < 0) throw new Error("PAGE_CURSOR_STALE");
    offset = found + 1;
  }
  const selected = items.slice(offset, offset + limit);
  return { items: selected, nextCursor: offset + selected.length < items.length ? Buffer.from(JSON.stringify({ signature, after: selected.at(-1)?.id })).toString("base64url") : null, snapshotRevision: Number(store.db.prepare("SELECT COALESCE(MAX(sequence),0) AS n FROM events WHERE project_id=?").get(principal.projectId)?.n) };
}

/** 只读也用一致快照；对象授权在查详情前执行，不暴露跨项目存在性。 */
export function queryForAgent(store: Store, principal: AgentPrincipal, type: AgentQuery, args: unknown, now: number, assertConnection?: () => void): unknown {
  return store.transaction(db => {
    assertConnection?.();
    assertAgentPrincipalCurrent(store, principal, now);
    const query = parseContract("query", { schemaVersion: 2, type, payload: args });
    if(query.type==='question.read'||query.type==='question.list'){
      const allowed=(id:string)=>authorizeAgentAction(store,principal,undefined,{action:'question.read',targetProjectId:principal.projectId,kind:'read',path:`questions/${id}`},now).allowed;
      if(query.type==='question.read'){if(!allowed(query.payload.questionId)||!db.prepare('SELECT 1 FROM questions WHERE id=? AND project_id=?').get(query.payload.questionId,principal.projectId))throw Error('FORBIDDEN');return questionContract(db,principal.projectId,query.payload.questionId);}
      if(query.payload.projectId!==principal.projectId)throw Error('FORBIDDEN');
      const questions=db.prepare('SELECT id FROM questions WHERE project_id=? ORDER BY id').all(principal.projectId).filter(q=>allowed(String(q.id))).map(q=>questionContract(db,principal.projectId,String(q.id)));
      return snapshotPage(store,principal,type,questions,query.payload.cursor,query.payload.limit??50);
    }
    if (query.type === "role.read" || query.type === "role.list") {
      const allowed = (id: string) => authorizeAgentAction(store, principal, undefined, { action: "role.read", targetProjectId: principal.projectId, kind: "read", path: `roles/${id}` }, now).allowed;
      if (query.type === "role.read") {
        if (!allowed(query.payload.roleId)) throw new Error("FORBIDDEN");
        // 与越权相同的错误，不用目标ID探测其他项目角色是否存在。
        if (!db.prepare("SELECT 1 FROM roles WHERE id=? AND project_id=?").get(query.payload.roleId, principal.projectId)) throw new Error("FORBIDDEN");
        const role=readRole(store, principal.projectId, query.payload.roleId),context=db.prepare('SELECT h.handover_id,h.old_binding_epoch,h.new_binding_epoch FROM handover_consumptions h JOIN role_bindings b ON b.id=h.new_binding_id AND b.project_id=h.project_id AND b.epoch=h.new_binding_epoch AND b.ended_at IS NULL WHERE h.project_id=? AND h.role_id=?').get(principal.projectId,query.payload.roleId);
        if(context&&authorizeAgentAction(store,principal,undefined,{action:'handover.read',targetProjectId:principal.projectId,kind:'read',path:`handovers/${context.handover_id}`},now).allowed)return {...role,contextHandover:{handoverId:context.handover_id,fromBindingEpoch:context.old_binding_epoch,bindingEpoch:context.new_binding_epoch}};
        return role;
      }
      if (query.payload.projectId !== principal.projectId) throw new Error("FORBIDDEN");
      const roles = db.prepare("SELECT id FROM roles WHERE project_id=? ORDER BY id").all(principal.projectId).filter(row => allowed(String(row.id))).map(row => readRole(store, principal.projectId, String(row.id)));
      return snapshotPage(store, principal, type, roles, query.payload.cursor, query.payload.limit ?? 50);
    }
    if (query.type === "inbox.read") {
      if (query.payload.roleId !== principal.roleId) throw new Error("FORBIDDEN");
      const messages = db.prepare("SELECT id,project_id,to_role_id,task_id,kind,body,state,created_at FROM messages WHERE project_id=? AND to_role_id=? ORDER BY created_at,id").all(principal.projectId, principal.roleId)
        .filter(row => authorizeAgentAction(store, principal, undefined, { action: "message.read_own", targetProjectId: principal.projectId, kind: "read", path: `messages/${String(row.id)}` }, now).allowed)
        .map(row => ({ id: String(row.id), projectId: String(row.project_id), toRoleId: String(row.to_role_id), taskId: row.task_id === null ? null : String(row.task_id), kind: String(row.kind), body: String(row.body), state: String(row.state), createdAt: Number(row.created_at) }));
      return snapshotPage(store, principal, type, messages, query.payload.cursor, query.payload.limit ?? 50);
    }
    if (query.type === "policy.read") {
      if (query.payload.projectId !== principal.projectId || !authorizeAgentAction(store, principal, undefined, { action: "policy.read", targetProjectId: principal.projectId, kind: "read" }, now).allowed) throw new Error("FORBIDDEN");
      return readProjectPolicy(db, principal.projectId);
    }
    const allowed = (id: string) => authorizeAgentAction(store, principal, undefined, { action: "task.read", targetProjectId: principal.projectId, kind: "read", path: `tasks/${id}` }, now).allowed;
    if(query.type==='result.read'){
      const result=db.prepare('SELECT r.*,a.state AS execution_state FROM results r JOIN attempts a ON a.id=r.attempt_id AND a.project_id=r.project_id WHERE r.id=? AND r.project_id=?').get(query.payload.resultId,principal.projectId);
      if(!result||!allowed(String(result.task_id)))throw new Error('FORBIDDEN');
      const taskId=String(result.task_id);
      const raw:unknown=JSON.parse(String(result.outputs_json));
      if(!Array.isArray(raw)||raw.length>128)throw new Error('RESULT_DETAILS_REQUIRES_REPAIR');
      const outputs:{artifactId:string;version:string;outputName:string}[]=[];
      const unavailableOutputNames:string[]=[];
      for(const entry of raw){
        if(!entry||typeof entry!=='object'||typeof entry.artifactId!=='string'||typeof entry.version!=='string'||typeof entry.outputName!=='string')throw new Error('RESULT_DETAILS_REQUIRES_REPAIR');
        const artifact=db.prepare('SELECT a.path_ref,g.repository_path FROM artifacts a LEFT JOIN artifact_git_sources g ON g.artifact_id=a.id AND g.project_id=a.project_id WHERE a.id=? AND a.project_id=? AND a.task_id=? AND a.task_revision=? AND a.version=?').get(entry.artifactId,principal.projectId,taskId,Number(result.task_revision),entry.version);
        const scope=artifact?.repository_path?repositoryScope(String(artifact.repository_path)):String(artifact?.path_ref??'');
        if(!artifact||!scope||scope.startsWith('git:')||!authorizeAgentAction(store,principal,undefined,{action:'artifact.read',targetProjectId:principal.projectId,kind:'read',path:scope},now).allowed){unavailableOutputNames.push(entry.outputName);continue;}
        outputs.push({artifactId:entry.artifactId,version:entry.version,outputName:entry.outputName});
      }
      const decisions:ResultDecisionView[]=db.prepare('SELECT * FROM result_rule_decisions WHERE project_id=? AND result_id=? ORDER BY rowid').all(principal.projectId,String(result.id)).map(row=>{
        const evidence=JSON.parse(String(row.evidence_json)) as {reason?:unknown;artifactIds?:unknown};
        if(!Array.isArray(evidence.artifactIds)||evidence.artifactIds.some(id=>typeof id!=='string'))throw Error('RESULT_DETAILS_REQUIRES_REPAIR');
        const visible=evidence.artifactIds.filter(id=>{
          const artifact=db.prepare('SELECT a.task_id,a.path_ref,g.repository_path FROM artifacts a LEFT JOIN artifact_git_sources g ON g.artifact_id=a.id AND g.project_id=a.project_id WHERE a.id=? AND a.project_id=?').get(id,principal.projectId);
          if(!artifact||(artifact.task_id!==null&&!allowed(String(artifact.task_id))))return false;
          const scope=artifact.repository_path?repositoryScope(String(artifact.repository_path)):String(artifact.path_ref);
          return !scope.startsWith('git:')&&authorizeAgentAction(store,principal,undefined,{action:'artifact.read',targetProjectId:principal.projectId,kind:'read',path:scope},now).allowed;
        });
        const restricted=visible.length!==evidence.artifactIds.length;
        const actor=db.prepare('SELECT b.role_id FROM agent_credentials c JOIN role_bindings b ON b.id=c.binding_id AND b.project_id=c.project_id AND b.epoch=c.binding_epoch WHERE c.id=? AND c.project_id=?').get(String(row.reviewer_principal_id),principal.projectId);
        return {decisionId:String(row.id),resultId:String(row.result_id),taskRevision:Number(row.task_revision),ruleId:String(row.rule_id),decision:String(row.decision),reviewer:actor?{kind:'bound_agent',roleId:String(actor.role_id)}:{kind:'unresolved',roleId:null},createdAt:Number(row.created_at),evidenceArtifactIds:visible,evidenceRestricted:restricted,reason:restricted?null:typeof evidence.reason==='string'?evidence.reason:null};
      });
      return {id:String(result.id),projectId:principal.projectId,taskId,taskRevision:Number(result.task_revision),attemptId:String(result.attempt_id),outcome:String(result.outcome),eligibility:String(result.eligibility),executionState:String(result.execution_state),summary:String(result.summary),outputs,unavailableOutputNames,decisions};
    }
    if (query.type === "task.read") {
      if (!allowed(query.payload.taskId)) throw new Error("FORBIDDEN");
      return readTaskDetail(db, query.payload.taskId, principal.projectId);
    }
    if (query.type !== "task.list" || query.payload.projectId !== principal.projectId) throw new Error("FORBIDDEN");
    const details = db.prepare("SELECT id FROM tasks WHERE project_id=? ORDER BY id").all(principal.projectId).filter(row => allowed(String(row.id))).map(row => readTaskDetail(db, String(row.id), principal.projectId));
    const policy = readProjectPolicy(db, principal.projectId);
    const role = db.prepare("SELECT revision,scope_paths_json,permission_profile,permission_profile_revision FROM roles WHERE id=? AND project_id=?").get(principal.roleId, principal.projectId);
    const signature = createHash("sha256").update(canonicalJson({ projectId: principal.projectId, bindingId: principal.bindingId, bindingEpoch: principal.bindingEpoch, role, policy, details })).digest("hex");
    let after = "";
    if (query.payload.cursor !== undefined) {
      if (query.payload.cursor.length > 2048) throw new Error("INVALID_PAGE_CURSOR");
      let parsed: { signature?: unknown; after?: unknown };
      try { parsed = JSON.parse(Buffer.from(query.payload.cursor, "base64url").toString("utf8")); } catch { throw new Error("INVALID_PAGE_CURSOR"); }
      if (!parsed || typeof parsed !== "object" || parsed.signature !== signature || typeof parsed.after !== "string" || !details.some(task => task.id === parsed.after)) throw new Error("PAGE_CURSOR_STALE");
      after = parsed.after;
    }
    const limit = query.payload.limit ?? 50;
    const remaining = details.filter(task => task.id > after); const items = remaining.slice(0, limit);
    return { items, nextCursor: remaining.length > limit ? Buffer.from(JSON.stringify({ signature, after: items.at(-1)?.id })).toString("base64url") : null, snapshotRevision: details.reduce((max, task) => Math.max(max, task.revision), 0) };
  });
}

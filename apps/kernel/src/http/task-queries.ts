import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { parseContract, type ContractRegistry } from "@projectorch/contracts";
import type { Store } from "@projectorch/persistence";
import { evaluateStartConditions } from "@projectorch/domain/tasks";

/** 用户只读快照；依赖满足不代表预算、原生驱动、角色或完整派发准入已通过。 */
export function readTaskReadiness(store: Store, taskId: string): ContractRegistry["task-readiness"] {
  const db = store.db;
  if (!db.isTransaction) throw new Error("TASK_READ_TRANSACTION_REQUIRED");
  const task = db.prepare("SELECT t.id,t.project_id,t.revision,t.spec_revision,p.plan_revision,p.user_paused FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?").get(taskId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  const evaluation = evaluateStartConditions(store, String(task.project_id), taskId);
  return parseContract("task-readiness", { schemaVersion: 2, taskId, projectId: task.project_id, revision: task.revision, specRevision: task.spec_revision, planRevision: task.plan_revision, userPaused: task.user_paused === 1, dependencyReady: evaluation.ready,
    blocks: evaluation.unmet.map(block => ({ taskId: block.prerequisiteId, requiredRevision: block.requiredRevision, currentRevision: db.prepare("SELECT spec_revision FROM tasks WHERE id=? AND project_id=?").get(block.prerequisiteId, String(task.project_id))?.spec_revision ?? null, reason: block.reason })),
    unresolvedAttempts: db.prepare("SELECT id AS attemptId,task_revision AS specRevision,state FROM attempts WHERE project_id=? AND task_id=? AND state IN ('dispatching','running','waiting_input','unknown') ORDER BY id").all(String(task.project_id), taskId),
  });
}

/** 已配对本地用户的验收资料；元数据不代表证据内容已经核验。 */
export function readTaskReview(db: DatabaseSync, taskId: string) {
  const task = readTaskDetail(db, taskId);
  const results = db.prepare("SELECT r.*,a.state AS execution_state FROM results r JOIN attempts a ON a.id=r.attempt_id AND a.project_id=r.project_id WHERE r.task_id=? AND r.project_id=? ORDER BY r.rowid DESC").all(taskId, task.projectId).map(row => ({ id: String(row.id), taskRevision: Number(row.task_revision), outcome: String(row.outcome), eligibility: String(row.eligibility), summary: String(row.summary), outputs: JSON.parse(String(row.outputs_json)) as unknown, executionState: String(row.execution_state) }));
  const decisions = db.prepare("SELECT d.* FROM result_rule_decisions d JOIN results r ON r.id=d.result_id AND r.project_id=d.project_id WHERE r.task_id=? AND r.project_id=? ORDER BY d.rowid").all(taskId, task.projectId).map(row => ({ id: String(row.id), resultId: String(row.result_id), ruleId: String(row.rule_id), decision: String(row.decision), reviewerPrincipalId: String(row.reviewer_principal_id), evidence: JSON.parse(String(row.evidence_json)) as unknown }));
  const artifacts = db.prepare("SELECT a.id,a.path_ref,a.sha256,a.byte_size,a.version,g.repository_path FROM artifacts a LEFT JOIN artifact_git_sources g ON g.artifact_id=a.id AND g.project_id=a.project_id WHERE a.project_id=? ORDER BY a.id").all(task.projectId).map(row => ({ id: String(row.id), path: String(row.path_ref), sha256: row.sha256 === null ? null : String(row.sha256), byteSize: row.byte_size === null ? null : Number(row.byte_size), version: String(row.version), repositoryPath: row.repository_path === null ? null : String(row.repository_path) }));
  return { task, results, decisions, artifacts };
}

/** 公共任务详情遵循固定合同；旧数据不完整时报告需诊断，不能用空对象伪装完整规格/等待。 */
export function readTaskDetail(db: DatabaseSync, taskId: string, projectId?: string): ContractRegistry["task-detail"] {
  const task = projectId === undefined ? db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId) : db.prepare("SELECT * FROM tasks WHERE id=? AND project_id=?").get(taskId, projectId);
  if (!task) throw new Error("TASK_NOT_FOUND");
  const ownerProject = String(task.project_id);
  const dependencies = db.prepare("SELECT prerequisite_id,required_revision,condition,output_name FROM task_dependencies WHERE task_id=? AND project_id=? ORDER BY prerequisite_id").all(taskId, ownerProject);
  const attempt = db.prepare("SELECT id,task_id,task_revision,binding_epoch,workspace_id,state,native_execution_id FROM attempts WHERE task_id=? AND project_id=? ORDER BY rowid DESC LIMIT 1").get(taskId, ownerProject);
  const wait = db.prepare("SELECT * FROM waits WHERE task_id=? AND project_id=? AND state='waiting' ORDER BY rowid DESC LIMIT 1").get(taskId, ownerProject);
  const detail = {
    id: taskId, projectId: task.project_id, revision: task.revision, specRevision: task.spec_revision, planRevision: task.plan_revision, roleId: task.role_id, state: task.state,
    spec: { goal: task.goal, inputArtifacts: JSON.parse(String(task.inputs_json)), outputRequirements: JSON.parse(String(task.outputs_json)), acceptance: JSON.parse(String(task.acceptance_json)), dependencies: dependencies.map(d => ({ taskId: d.prerequisite_id, requiredTaskRevision: d.required_revision, condition: d.condition, ...(d.output_name === null ? {} : { outputName: d.output_name }) })) },
    currentAttempt: attempt ? { id: attempt.id, taskId, taskRevision: attempt.task_revision, bindingEpoch: attempt.binding_epoch, workspaceId: attempt.workspace_id, state: attempt.state, nativeExecutionId: attempt.native_execution_id } : null,
    wait: wait ? { target: JSON.parse(String(wait.target_json)), deadline: new Date(Number(wait.deadline)).toISOString(), onTimeout: wait.on_timeout, taskRevision: wait.task_revision, attemptId: wait.attempt_id, bindingEpoch: wait.binding_epoch } : null,
    resultIds: db.prepare("SELECT id FROM results WHERE task_id=? AND project_id=? ORDER BY id").all(taskId, ownerProject).map(row => row.id),
    integrationIds: db.prepare("SELECT id FROM integrations WHERE task_id=? AND project_id=? ORDER BY id").all(taskId, ownerProject).map(row => row.id),
  };
  try { return parseContract("task-detail", detail); }
  catch { throw new Error("TASK_DETAIL_REQUIRES_REPAIR"); }
}

export function taskDetailPage(db: DatabaseSync, projectId: string, limit: number, cursor: string | null): { items: readonly ContractRegistry["task-detail"][]; nextCursor: string | null; snapshotRevision: number } {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("INVALID_PAGE_LIMIT");
  const project = db.prepare("SELECT plan_revision FROM projects WHERE id=?").get(projectId);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  const rows = db.prepare("SELECT id,revision,spec_revision,state FROM tasks WHERE project_id=? ORDER BY id").all(projectId);
  const watermark = Number(db.prepare("SELECT COALESCE(MAX(sequence),0) AS n FROM events WHERE project_id=?").get(projectId)?.n);
  const signature = createHash("sha256").update(JSON.stringify([projectId, project.plan_revision, watermark, rows])).digest("hex");
  let after = "";
  if (cursor !== null) {
    if (cursor.length > 2048) throw new Error("INVALID_PAGE_CURSOR");
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw new Error("INVALID_PAGE_CURSOR"); }
    if (!parsed || typeof parsed !== "object" || !("signature" in parsed) || !("after" in parsed) || typeof parsed.after !== "string" || parsed.signature !== signature || !rows.some(row => row.id === parsed.after)) throw new Error("PAGE_CURSOR_STALE");
    after = parsed.after;
  }
  const remaining = rows.filter(row => String(row.id) > after);
  const selected = remaining.slice(0, limit);
  const items = selected.map(row => readTaskDetail(db, String(row.id), projectId));
  return { items, nextCursor: remaining.length > limit ? Buffer.from(JSON.stringify({ signature, after: selected.at(-1)?.id })).toString("base64url") : null, snapshotRevision: watermark };
}

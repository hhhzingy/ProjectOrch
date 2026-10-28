import { randomUUID } from "node:crypto";
import type { Store } from "@projectorch/persistence";
import { parseContract, type ContractRegistry } from "@projectorch/contracts";
import { evaluateStartConditions } from "@projectorch/domain/tasks";
import { decideAcceptanceWithin, evaluateAcceptanceAuthorization, type AcceptancePrincipal, type ControlledCheck } from "@projectorch/domain/results";
import type { AgentPrincipal } from "../auth/agent-credential.js";
import { readProjectPolicy } from "../auth/project-policy.js";

type Db = Store["db"];
type Command = ContractRegistry["command"];
type Payload<K> = Extract<Command, { type: K }>["payload"];
const unresolved = "('dispatching','running','waiting_input','unknown')";

function task(db: Db, principal: AgentPrincipal, taskId: string) {
  const row = db.prepare("SELECT * FROM tasks WHERE id=? AND project_id=?").get(taskId, principal.projectId);
  if (!row) throw new Error("TASK_NOT_FOUND");
  if (row.role_id !== principal.roleId) throw new Error("TASK_NOT_OWNED");
  return row;
}
function runningAttempt(db: Db, principal: AgentPrincipal, taskId: string, attemptId: string | null, executionId: string | undefined) {
  if (!executionId) throw new Error("CALLER_EXECUTION_REQUIRED");
  const row = attemptId === null
    ? db.prepare("SELECT * FROM attempts WHERE project_id=? AND task_id=? AND binding_id=? AND binding_epoch=? AND native_execution_id=? AND state='running'").get(principal.projectId, taskId, principal.bindingId, principal.bindingEpoch, executionId)
    : db.prepare("SELECT * FROM attempts WHERE id=? AND project_id=? AND task_id=? AND binding_id=? AND binding_epoch=? AND native_execution_id=? AND state='running'").get(attemptId, principal.projectId, taskId, principal.bindingId, principal.bindingEpoch, executionId);
  if (!row) throw new Error("TASK_EXECUTION_NOT_CURRENT");
  return row;
}

/** claim只承接Supervisor已占位并确认运行的同一执行；不能在模型工具里另建执行或夺取目录。 */
export function claimTaskWithin(store: Store, principal: AgentPrincipal, payload: Payload<"task.claim">, executionId: string | undefined, now: number): { taskId: string; revision: number; attemptId: string } {
  const db = store.db;
  if (!db.isTransaction || !Number.isSafeInteger(now) || now < 0) throw new Error("TASK_TRANSACTION_REQUIRED");
  const row = task(db, principal, payload.taskId);
  if (row.revision !== payload.expectedRevision || row.spec_revision !== payload.expectedSpecRevision) throw new Error("TASK_REVISION_CONFLICT");
  if (!["draft", "ready"].includes(String(row.state))) throw new Error("TASK_ALREADY_CLAIMED_OR_FINISHED");
  const project = db.prepare("SELECT user_paused,policy_revision,plan_revision FROM projects WHERE id=?").get(principal.projectId);
  const role = db.prepare("SELECT revision,binding_state,startup_protocol_version FROM roles WHERE id=? AND project_id=?").get(principal.roleId, principal.projectId);
  const ack = db.prepare("SELECT * FROM role_startup_acks WHERE binding_id=? AND project_id=? AND binding_epoch=?").get(principal.bindingId, principal.projectId, principal.bindingEpoch);
  if (!project || project.user_paused === 1 || db.prepare("SELECT 1 FROM goal_holds WHERE project_id=? AND state IN ('pending','awaiting_user')").get(principal.projectId)) throw new Error("DISPATCH_HELD");
  if (!role || role.binding_state !== "ready" || role.startup_protocol_version !== 2 || !ack || ack.role_revision !== role.revision || ack.policy_revision !== project.policy_revision || ack.plan_revision !== project.plan_revision || Number(ack.acknowledged_at) > now) throw new Error("STARTUP_REQUIRED");
  const specs: unknown = JSON.parse(String(ack.task_specs_json));
  if (!Array.isArray(specs) || !specs.some(entry => entry?.taskId === payload.taskId && entry.specRevision === row.spec_revision)) throw new Error("STARTUP_TASK_SPEC_REQUIRED");
  if (!evaluateStartConditions(store, principal.projectId, payload.taskId).ready) throw new Error("TASK_START_CONDITIONS_UNMET");
  const attempt = runningAttempt(db, principal, payload.taskId, null, executionId);
  if (attempt.task_revision !== row.spec_revision || attempt.workspace_id === null || Number(attempt.started_at) > now) throw new Error("TASK_EXECUTION_NOT_CURRENT");
  const workspace = db.prepare("SELECT 1 FROM workspace_reservations r JOIN workspaces w ON w.id=r.workspace_id AND w.project_id=r.project_id WHERE r.id=? AND r.project_id=? AND r.task_id=? AND r.task_revision=? AND r.workspace_id=? AND r.state='reserved' AND w.state NOT IN ('unknown','retired') AND w.enforcement<>'unknown'").get(`res-${String(attempt.id)}`, principal.projectId, payload.taskId, row.spec_revision as number, attempt.workspace_id as string);
  if (!workspace) throw new Error("WORKSPACE_RESERVATION_REQUIRED");
  const policy = readProjectPolicy(db, principal.projectId);
  if (policy.nativeMode !== "verified_only") throw new Error("CAPABILITY_UNSUPPORTED");
  const active = Number(db.prepare(`SELECT COUNT(*) AS n FROM attempts WHERE project_id=? AND state IN ${unresolved}`).get(principal.projectId)?.n);
  const perRole = Number(db.prepare(`SELECT COUNT(*) AS n FROM attempts WHERE binding_id=? AND state IN ${unresolved}`).get(principal.bindingId)?.n);
  const attempts = Number(db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE project_id=? AND task_id=?").get(principal.projectId, payload.taskId)?.n);
  if (active > policy.limits.totalConcurrency || perRole > policy.limits.roleConcurrency || attempts > policy.limits.maxAttempts) throw new Error("BUDGET_EXCEEDED");
  db.prepare("UPDATE tasks SET state='active',revision=revision+1 WHERE id=? AND project_id=?").run(payload.taskId, principal.projectId);
  return { taskId: payload.taskId, revision: Number(row.revision) + 1, attemptId: String(attempt.id) };
}

type Wait = NonNullable<Payload<"task.report">["wait"]>;
function waitTargetSatisfied(db: Db, projectId: string, target: Wait["target"], principal: AgentPrincipal): boolean {
  if (!target || !["message", "question", "task", "external"].includes(target.kind)) throw new Error("WAIT_LEGACY_TARGET_REQUIRES_REPAIR");
  if (target.kind === "message") {
    const message = db.prepare("SELECT state FROM messages WHERE id=? AND project_id=? AND to_role_id=?").get(target.messageId, projectId, principal.roleId);
    if (!message) throw new Error("WAIT_TARGET_NOT_FOUND");
    return ["acknowledged", "resolved"].includes(String(message.state));
  }
  if (target.kind === "question") {
    const question = db.prepare("SELECT revision,state,binding_id FROM questions WHERE id=? AND project_id=?").get(target.questionId, projectId);
    if (!question || question.binding_id !== principal.bindingId) throw new Error("WAIT_TARGET_NOT_FOUND");
    // 回答使问题revision递增一次；只有该具体问题版本的回答能解阻。
    if (question.revision !== target.questionRevision && !(question.state === "answered" && question.revision === target.questionRevision + 1)) throw new Error("STALE_WAIT");
    return question.state === "answered";
  }
  if (target.kind === "task") {
    const dependency = db.prepare("SELECT spec_revision,state FROM tasks WHERE id=? AND project_id=?").get(target.taskId, projectId);
    if (!dependency || dependency.spec_revision !== target.taskRevision) throw new Error("STALE_WAIT");
    if (dependency.state === "cancelled") throw new Error("STALE_WAIT");
    return !!db.prepare("SELECT 1 FROM results r JOIN acceptances c ON c.result_id=r.id AND c.project_id=r.project_id JOIN attempts a ON a.id=r.attempt_id AND a.project_id=r.project_id WHERE r.project_id=? AND r.task_id=? AND r.task_revision=? AND r.eligibility='current' AND r.outcome='succeeded' AND c.decision='accept' AND a.state='succeeded'").get(projectId, target.taskId, target.taskRevision);
  }
  const condition = db.prepare("SELECT revision,state,verifier_role_id FROM external_conditions WHERE id=? AND project_id=?").get(target.conditionId, projectId);
  if (!condition || condition.revision !== target.conditionRevision || condition.verifier_role_id !== target.verifierRoleId) throw new Error("STALE_WAIT");
  return condition.state === "verified";
}
function assertNoWaitCycle(db: Db, projectId: string, taskId: string, target: Wait["target"]): void {
  if (target.kind !== "task") return;
  const stack = [target.taskId]; const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop() as string;
    if (id === taskId) throw new Error("WAIT_DEADLOCK");
    if (seen.has(id)) continue; seen.add(id);
    for (const dependency of db.prepare("SELECT prerequisite_id FROM task_dependencies WHERE project_id=? AND task_id=?").all(projectId, id)) stack.push(String(dependency.prerequisite_id));
    for (const row of db.prepare("SELECT target_json FROM waits WHERE project_id=? AND task_id=? AND state='waiting'").all(projectId, id)) {
      const next = JSON.parse(String(row.target_json)) as Record<string, unknown>;
      if (next.kind === "task" && typeof next.taskId === "string") stack.push(next.taskId);
    }
  }
}

/** 进展和业务等待不改原生attempt.state，不把模型文字当作原生终态。 */
export function reportTaskWithin(store: Store, principal: AgentPrincipal, payload: Payload<"task.report">, executionId: string | undefined, commandId: string, now: number): { taskId: string; revision: number; reportId: string; waitId: string | null } {
  const db = store.db;
  if (!db.isTransaction || !Number.isSafeInteger(now) || now < 0) throw new Error("TASK_TRANSACTION_REQUIRED");
  const row = task(db, principal, payload.taskId);
  const attempt = runningAttempt(db, principal, payload.taskId, payload.attemptId, executionId);
  if (payload.bindingEpoch !== principal.bindingEpoch || row.spec_revision !== attempt.task_revision || !["active", "waiting"].includes(String(row.state))) throw new Error("STALE_TASK_REPORT");
  const existing = db.prepare("SELECT id,target_json FROM waits WHERE project_id=? AND attempt_id=? AND state='waiting'").get(principal.projectId, payload.attemptId);
  let waitId: string | null = null;
  if (payload.wait !== null) {
    const wait = payload.wait;
    if (wait.attemptId !== payload.attemptId || wait.taskRevision !== row.spec_revision || wait.bindingEpoch !== principal.bindingEpoch) throw new Error("STALE_WAIT");
    const deadline = Date.parse(wait.deadline);
    if (!Number.isSafeInteger(deadline) || deadline <= now) throw new Error("INVALID_WAIT_DEADLINE");
    if (existing) throw new Error("WAIT_ALREADY_EXISTS");
    if (waitTargetSatisfied(db, principal.projectId, wait.target, principal)) throw new Error("WAIT_TARGET_ALREADY_SATISFIED");
    assertNoWaitCycle(db, principal.projectId, payload.taskId, wait.target);
    waitId = randomUUID();
    db.prepare("INSERT INTO waits(id,project_id,task_id,task_revision,attempt_id,binding_id,binding_epoch,target_json,deadline,on_timeout,state) VALUES(?,?,?,?,?,?,?,?,?,?,'waiting')").run(waitId, principal.projectId, payload.taskId, Number(row.spec_revision), payload.attemptId, principal.bindingId, principal.bindingEpoch, JSON.stringify(wait.target), deadline, wait.onTimeout);
  } else if (existing) {
    if (!waitTargetSatisfied(db, principal.projectId, JSON.parse(String(existing.target_json)) as Wait["target"], principal)) throw new Error("WAIT_UNRESOLVED");
    db.prepare("UPDATE waits SET state='resolved' WHERE id=?").run(String(existing.id));
  }
  const reportId = randomUUID();
  db.prepare("INSERT INTO task_reports(id,command_id,project_id,task_id,attempt_id,task_revision,binding_epoch,report,wait_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(reportId, commandId, principal.projectId, payload.taskId, payload.attemptId, Number(row.spec_revision), principal.bindingEpoch, payload.report, waitId, now);
  db.prepare("UPDATE tasks SET state=?,revision=revision+1 WHERE id=? AND project_id=?").run(waitId ? "waiting" : "active", payload.taskId, principal.projectId);
  return { taskId: payload.taskId, revision: Number(row.revision) + 1, reportId, waitId };
}

/** 多规则中间裁决不写最终acceptance；所有要求针对同一结果满足后才允许后继。 */
export function acceptTaskWithin(store: Store, principal: AcceptancePrincipal, projectId: string, payload: Payload<"task.accept">, now: number): { taskId: string; revision: number; accepted: boolean; decisionId: string } {
  const db = store.db;
  if (!db.isTransaction || !Number.isSafeInteger(now) || now < 0) throw new Error("TASK_TRANSACTION_REQUIRED");
  const row = db.prepare("SELECT * FROM tasks WHERE id=? AND project_id=?").get(payload.taskId, projectId);
  if (!row) throw new Error("TASK_NOT_FOUND");
  if (row.spec_revision !== payload.taskRevision || row.state === "cancelled") throw new Error("STALE_SPEC");
  const spec = parseContract("task-spec", { goal: row.goal, inputArtifacts: JSON.parse(String(row.inputs_json)), outputRequirements: JSON.parse(String(row.outputs_json)), acceptance: JSON.parse(String(row.acceptance_json)), dependencies: [] });
  if (new Set(spec.acceptance.map(rule => rule.ruleId)).size !== spec.acceptance.length) throw new Error("TASK_RULE_IDS_AMBIGUOUS");
  const rule = spec.acceptance.find(entry => entry.ruleId === payload.ruleId);
  if (!rule) throw new Error("ACCEPTANCE_RULE_NOT_FOUND");
  const result = db.prepare("SELECT attempt_id,eligibility,outcome FROM results WHERE id=? AND project_id=? AND task_id=? AND task_revision=?").get(payload.resultId, projectId, payload.taskId, payload.taskRevision);
  if (!result || result.eligibility !== "current") throw new Error("RESULT_NOT_CURRENT");
  if (db.prepare("SELECT 1 FROM acceptances WHERE project_id=? AND result_id=? AND decision='accept'").get(projectId, payload.resultId)) throw new Error("ACCEPTANCE_ALREADY_ACCEPTED");
  const check: ControlledCheck | undefined = rule.mode === "automated_check" ? { resultId: payload.resultId, definitionId: rule.checkDefinitionId, version: rule.checkVersion, targetSpecRevision: payload.taskRevision } : undefined;
  evaluateAcceptanceAuthorization(store, { projectId, resultId: payload.resultId, rule, principal, ...(check ? { check } : {}) });
  for (const id of payload.evidenceArtifactIds) if (!db.prepare("SELECT 1 FROM artifacts WHERE id=? AND project_id=?").get(id, projectId)) throw new Error("ACCEPTANCE_EVIDENCE_NOT_FOUND");
  if (payload.decision === "accept") {
    if (payload.evidenceArtifactIds.length === 0) throw new Error("ACCEPTANCE_EVIDENCE_REQUIRED");
    if (result.outcome !== "succeeded" || db.prepare("SELECT state FROM attempts WHERE id=? AND project_id=?").get(String(result.attempt_id), projectId)?.state !== "succeeded") throw new Error("RESULT_EXECUTION_NOT_CONFIRMED");
    if (db.prepare(`SELECT 1 FROM attempts WHERE project_id=? AND task_id=? AND state IN ${unresolved}`).get(projectId, payload.taskId)) throw new Error("RESULT_EXECUTION_NOT_CONFIRMED");
    const previous = db.prepare("SELECT decision FROM result_rule_decisions WHERE result_id=? AND project_id=? AND rule_id=? ORDER BY rowid DESC LIMIT 1").get(payload.resultId, projectId, payload.ruleId);
    if (previous?.decision === "accept") throw new Error("RULE_ALREADY_ACCEPTED");
  }
  const decisionId = randomUUID();
  const evidence = { reason: payload.reason, artifactIds: payload.evidenceArtifactIds };
  db.prepare("INSERT INTO result_rule_decisions(id,project_id,result_id,task_revision,rule_id,decision,reviewer_principal_id,evidence_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(decisionId, projectId, payload.resultId, payload.taskRevision, payload.ruleId, payload.decision, principal.id, JSON.stringify(evidence), now);
  const accepted = payload.decision === "accept" && spec.acceptance.every(entry => db.prepare("SELECT decision FROM result_rule_decisions WHERE project_id=? AND result_id=? AND rule_id=? ORDER BY rowid DESC LIMIT 1").get(projectId, payload.resultId, entry.ruleId)?.decision === "accept");
  if (accepted) for (const required of spec.acceptance) if (required.mode === "automated_check") evaluateAcceptanceAuthorization(store, { projectId, resultId: payload.resultId, rule: required, principal, check: { resultId: payload.resultId, definitionId: required.checkDefinitionId, version: required.checkVersion, targetSpecRevision: payload.taskRevision } });
  if (accepted || payload.decision !== "accept") decideAcceptanceWithin(store, { id: randomUUID(), projectId, resultId: payload.resultId, decision: accepted ? "accept" : payload.decision, reviewerPrincipalId: principal.id, evidence, rule, principal, ...(check ? { check } : {}) }, now);
  db.prepare("UPDATE tasks SET state=?,revision=revision+1 WHERE id=? AND project_id=?").run(accepted ? "accepted" : payload.decision === "reject" ? "blocked" : "review", payload.taskId, projectId);
  return { taskId: payload.taskId, revision: Number(row.revision) + 1, accepted, decisionId };
}

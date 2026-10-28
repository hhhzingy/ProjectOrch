/** T030准备切片：结果提交与验收规则。结果=任务版本绑定（task_revision唯一）+outcome（succeeded/failed/inconclusive）+输出清单+摘要；
 * eligibility=stale（任务版本推进后旧结果显式过期，仅保留历史）与disputed（复核退回）；
 * 验收=accept/reject/needs_evidence裁决——**缺证据不accept**（A044），**重复验收幂等拒绝、旧版本结果不激活后继**（A045）。
 * attempts表依赖T028链，本切片以合成attempt行模拟（正式任务接入真实attempts）。 */
import type { Store } from "@projectorch/persistence";
import type { DatabaseSync } from "node:sqlite";

export interface ResultView {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly outcome: "succeeded" | "failed" | "inconclusive";
  readonly outputs: readonly unknown[];
  readonly summary: string;
  readonly eligibility: "current" | "stale" | "disputed";
}

const text = (value: unknown, label: string, max: number): string => {
  if (typeof value !== "string" || !value || value.length > max || /[\r\n\0]/.test(value)) throw new Error(`INVALID_RESULT_${label}`);
  return value;
};
const clock = (now: number): void => { if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_RESULT_TIME"); };

function viewOf(row: Record<string, unknown>): ResultView {
  return Object.freeze({ id: String(row.id), projectId: String(row.project_id), taskId: String(row.task_id), taskRevision: Number(row.task_revision), outcome: String(row.outcome) as ResultView["outcome"], outputs: JSON.parse(String(row.outputs_json)) as readonly unknown[], summary: String(row.summary), eligibility: String(row.eligibility) as ResultView["eligibility"] });
}

/** 提交结果：任务版本必须存在； UNIQUE(task_revision)由库约束强制（A045旧结果覆盖新版本被拒）。 */
export function submitResult(store: Store, input: { readonly id: unknown; readonly projectId: unknown; readonly taskId: unknown; readonly taskRevision: unknown; readonly attemptId: unknown; readonly outcome: unknown; readonly outputs?: unknown; readonly summary: unknown }, now: number): ResultView {
  return store.transaction(db => submitResultWithin(db, input, now));
}

/** 供受信命令管线使用；同事务先完成主体、任务和尝试归属校验。 */
export function submitResultWithin(db: DatabaseSync, input: Parameters<typeof submitResult>[1], now: number): ResultView {
  if (!db.isTransaction) throw new Error("RESULT_TRANSACTION_REQUIRED");
  clock(now);
  const id = text(input.id, "ID", 128);
  const projectId = text(input.projectId, "PROJECT", 128);
  const taskId = text(input.taskId, "TASK", 128);
  const rawTaskRevision = input.taskRevision;
  if (typeof rawTaskRevision !== "number" || !Number.isSafeInteger(rawTaskRevision) || rawTaskRevision < 0) throw new Error("INVALID_RESULT_REVISION");
  const taskRevision: number = rawTaskRevision;
  const attemptId = text(input.attemptId, "ATTEMPT", 128);
  const outcome = input.outcome;
  if (outcome !== "succeeded" && outcome !== "failed" && outcome !== "inconclusive") throw new Error("INVALID_RESULT_OUTCOME");
  const outputs = input.outputs === undefined ? [] : input.outputs;
  if (!Array.isArray(outputs) || outputs.length > 128) throw new Error("INVALID_RESULT_OUTPUTS");
  const summary = text(input.summary, "SUMMARY", 16384);
    if (!db.prepare("SELECT 1 FROM tasks WHERE id=? AND project_id=?").get(taskId, projectId)) throw new Error("RESULT_TASK_NOT_FOUND");
    if (!db.prepare("SELECT 1 FROM task_revisions WHERE task_id=? AND project_id=? AND revision=?").get(taskId, projectId, taskRevision)) throw new Error("RESULT_REVISION_NOT_FOUND");
    if (!db.prepare("SELECT 1 FROM attempts WHERE id=? AND project_id=? AND task_id=? AND task_revision=?").get(attemptId, projectId, taskId, taskRevision)) throw new Error("RESULT_ATTEMPT_NOT_FOUND");
    db.prepare("INSERT INTO results(id,project_id,task_id,task_revision,attempt_id,outcome,outputs_json,summary,eligibility) VALUES(?,?,?,?,?,?,?,?,'current')").run(id, projectId, taskId, taskRevision, attemptId, outcome, JSON.stringify(outputs), summary);
    const row = db.prepare("SELECT id,project_id,task_id,task_revision,outcome,outputs_json,summary,eligibility FROM results WHERE id=? AND project_id=?").get(id, projectId) as Record<string, unknown>;
    return viewOf(row);
}

// 注：eligibility由库触发器治理（spec_revision推进时旧结果自动stale；accept要求task_revision==spec_revision且current）。
// 域层不重复实现——submitResult后的eligibility应读回触发器结果为准。

export interface AcceptanceDecision {
  readonly acceptanceId: string;
  readonly decision: "accept" | "reject" | "needs_evidence";
}

/** 验收裁决：succeeded且current且证据非空才可accept（A044：缺证据不accepted）；accept幂等拒绝（A045重复验收不重复激活）；disputed结果拒绝验收。
 * 提供rule时先做裁决授权核验（A088：指定裁决者/独立性/受控检查版本），执行者自报不构成授权。 */
export function decideAcceptance(store: Store, input: { readonly id: unknown; readonly projectId: unknown; readonly resultId: unknown; readonly decision: unknown; readonly reviewerPrincipalId: unknown; readonly evidence: unknown; readonly rule?: AcceptanceRule; readonly principal?: AcceptancePrincipal; readonly check?: ControlledCheck }, now: number): AcceptanceDecision {
  return store.transaction(() => decideAcceptanceWithin(store, input, now));
}

/** 由已持有写事务的命令管线调用；授权/资格/裁决与外层回执共同提交或回滚。 */
export function decideAcceptanceWithin(store: Store, input: Parameters<typeof decideAcceptance>[1], now: number): AcceptanceDecision {
  if (!store.db.isTransaction) throw new Error("ACCEPTANCE_TRANSACTION_REQUIRED");
  const db = store.db;
  clock(now);
  const id = text(input.id, "ID", 128);
  const projectId = text(input.projectId, "PROJECT", 128);
  const resultId = text(input.resultId, "RESULT", 128);
  const decision = input.decision;
  if (decision !== "accept" && decision !== "reject" && decision !== "needs_evidence") throw new Error("INVALID_ACCEPTANCE_DECISION");
  const reviewerPrincipalId = text(input.reviewerPrincipalId, "REVIEWER", 128);
  const evidence = input.evidence;
  const hasEvidence = evidence !== undefined && evidence !== null && (!Array.isArray(evidence) || evidence.length > 0) && (Array.isArray(evidence) || typeof evidence === "object");
  if (decision === "accept" && !hasEvidence) throw new Error("ACCEPTANCE_EVIDENCE_REQUIRED");
  // 授权、结果资格、检查版本和裁决写入必须处于同一写事务。
  if (input.rule !== undefined) {
    if (input.principal === undefined) throw new Error("FORBIDDEN");
    evaluateAcceptanceAuthorization(store, input.check === undefined ? { projectId, resultId, rule: input.rule, principal: input.principal } : { projectId, resultId, rule: input.rule, principal: input.principal, check: input.check });
  }
  const resultRow = store.db.prepare("SELECT id,task_id,task_revision,outcome,eligibility FROM results WHERE id=? AND project_id=?").get(resultId, projectId) as Record<string, unknown> | undefined;
  if (!resultRow) throw new Error("RESULT_NOT_FOUND");
  if (resultRow.eligibility === "disputed") throw new Error("RESULT_DISPUTED");
  if (decision === "accept" && resultRow.outcome !== "succeeded") throw new Error("ACCEPTANCE_REQUIRES_SUCCEEDED");
  if (decision === "accept" && resultRow.eligibility !== "current") throw new Error("ACCEPTANCE_REQUIRES_CURRENT");
  const duplicate = store.db.prepare("SELECT 1 FROM acceptances WHERE result_id=? AND project_id=? AND decision='accept'").get(resultId, projectId);
  if (decision === "accept" && duplicate) throw new Error("ACCEPTANCE_ALREADY_ACCEPTED");
    db.prepare("INSERT INTO acceptances(id,project_id,result_id,task_revision,decision,reviewer_principal_id,evidence_json,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, projectId, resultId, Number(resultRow.task_revision), decision, reviewerPrincipalId, JSON.stringify(evidence ?? null), now);
    if (decision === "reject") db.prepare("UPDATE results SET eligibility='disputed' WHERE id=? AND project_id=?").run(resultId, projectId);
    return { acceptanceId: id, decision };
}

export function readResult(store: Store, projectId: string, resultId: string): ResultView {
  const row = store.db.prepare("SELECT id,project_id,task_id,task_revision,outcome,outputs_json,summary,eligibility FROM results WHERE id=? AND project_id=?").get(resultId, projectId);
  if (!row) throw new Error("RESULT_NOT_FOUND");
  return viewOf(row as Record<string, unknown>);
}

/** A088：验收规则与受控检查。裁决者必须由规则指定（designated_reviewer指定角色+可选独立性；automated_check绑定启用中的检查定义版本；
 * user仅限已认证用户）。失败路径显式拒绝：WRONG_REVIEWER/SELF_REVIEW/CHECK_NOT_PASSED/UNTRUSTED_USER/FORBIDDEN——执行者自报不能替代要求的复核。 */
export interface AcceptanceRule {
  readonly mode: "designated_reviewer" | "automated_check" | "user";
  readonly reviewerRoleId?: string;
  readonly independent?: boolean;
  readonly checkDefinitionId?: string;
  readonly checkVersion?: string;
}

export interface AcceptancePrincipal {
  readonly id: string;
  readonly kind: "bound_agent" | "authenticated_user";
  readonly roleId?: string;
}

export interface ControlledCheck {
  readonly resultId: string;
  readonly definitionId: string;
  readonly version: string;
  readonly targetSpecRevision: number;
}

export function registerCheckDefinition(store: Store, input: { readonly projectId: string; readonly id: string; readonly version: string; readonly definition: unknown; readonly enabled?: boolean }, now: number): void {
  clock(now);
  const id = text(input.id, "CHECK_ID", 128);
  const version = text(input.version, "CHECK_VERSION", 64);
  if (input.definition === undefined || typeof input.definition !== "object" || Array.isArray(input.definition)) throw new Error("INVALID_CHECK_DEFINITION");
  store.transaction(db => {
    db.prepare("INSERT INTO check_definitions(project_id,id,version,definition_json,enabled) VALUES(?,?,?,?,?)").run(input.projectId, id, version, JSON.stringify(input.definition), input.enabled === false ? 0 : 1);
  });
}

export function recordCheckRun(store: Store, input: { readonly id: string; readonly projectId: string; readonly resultId: string; readonly checkId: string; readonly checkVersion: string; readonly targetSpecRevision: number; readonly outcome: "passed" | "failed" | "not_run"; readonly evidence: unknown }, now: number): void {
  clock(now);
  const id = text(input.id, "RUN_ID", 128);
  if (!["passed", "failed", "not_run"].includes(input.outcome)) throw new Error("INVALID_CHECK_OUTCOME");
  if (input.evidence === undefined || typeof input.evidence !== "object" || Array.isArray(input.evidence)) throw new Error("INVALID_CHECK_EVIDENCE");
  store.transaction(db => {
    if (!db.prepare("SELECT 1 FROM check_definitions WHERE project_id=? AND id=? AND version=? AND enabled=1").get(input.projectId, input.checkId, input.checkVersion)) throw new Error("CHECK_DEFINITION_NOT_ENABLED");
    if (!db.prepare("SELECT 1 FROM results WHERE id=? AND project_id=?").get(input.resultId, input.projectId)) throw new Error("RESULT_NOT_FOUND");
    db.prepare("INSERT INTO check_runs(id,project_id,result_id,check_id,check_version,target_spec_revision,outcome,evidence_json) VALUES(?,?,?,?,?,?,?,?)").run(id, input.projectId, input.resultId, input.checkId, input.checkVersion, input.targetSpecRevision, input.outcome, JSON.stringify(input.evidence));
  });
}

/** 裁决授权核验：不满足即抛错（accept前必须通过）。执行者自报（成功文字）不进入判定输入。 */
export function evaluateAcceptanceAuthorization(store: Store, input: { readonly projectId: string; readonly resultId: string; readonly rule: AcceptanceRule; readonly principal: AcceptancePrincipal; readonly check?: ControlledCheck }): void {
  const { rule, principal } = input;
  if (rule.mode === "user") {
    if (principal.kind !== "authenticated_user") throw new Error("UNTRUSTED_USER");
    return;
  }
  if (principal.kind !== "bound_agent" && rule.mode === "designated_reviewer") throw new Error("WRONG_REVIEWER");
  if (rule.mode === "designated_reviewer") {
    if (!rule.reviewerRoleId || principal.roleId !== rule.reviewerRoleId) throw new Error("WRONG_REVIEWER");
    if (rule.independent === true) {
      const attemptRole = store.db.prepare("SELECT b.role_id AS role FROM results r JOIN attempts a ON a.id=r.attempt_id AND a.project_id=r.project_id JOIN role_bindings b ON b.id=a.binding_id WHERE r.id=? AND r.project_id=?").get(input.resultId, input.projectId) as { role: string } | undefined;
      if (attemptRole && String(attemptRole.role) === principal.roleId) throw new Error("SELF_REVIEW");
    }
    return;
  }
  // automated_check：受控检查权威——启用中的定义版本+针对本结果+规格匹配+outcome=passed
  const check = input.check;
  if (!check || rule.checkDefinitionId === undefined || rule.checkVersion === undefined) throw new Error("CHECK_NOT_PASSED");
  if (check.definitionId !== rule.checkDefinitionId || check.version !== rule.checkVersion || check.resultId !== input.resultId) throw new Error("CHECK_NOT_PASSED");
  const run = store.db.prepare("SELECT outcome,target_spec_revision FROM check_runs WHERE project_id=? AND result_id=? AND check_id=? AND check_version=? ORDER BY rowid DESC LIMIT 1").get(input.projectId, input.resultId, check.definitionId, check.version) as { outcome: string; target_spec_revision: number } | undefined;
  if (!run || run.outcome !== "passed") throw new Error("CHECK_NOT_PASSED");
  const specRevision = Number(store.db.prepare("SELECT t.spec_revision AS spec FROM results r JOIN tasks t ON t.id=r.task_id AND t.project_id=r.project_id WHERE r.id=? AND r.project_id=?").get(input.resultId, input.projectId)?.spec ?? -1);
  if (specRevision >= 0 && Number(run.target_spec_revision) !== specRevision) throw new Error("CHECK_NOT_PASSED");
}

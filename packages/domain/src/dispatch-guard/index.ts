/** T066：最小统一执行准入（DispatchGuard）。所有真实启动入口共用：同事务收集全部拒绝原因（不fail-fast），
 * 通过后才登记执行尝试与工作目录独占。高级调度（优先级/依赖驱动派发）属T039/T040，不在此实现。
 * 拒绝码与参考谓词一致：USER_PAUSED/DISPATCH_HELD/FORBIDDEN/CAPABILITY_UNSUPPORTED/STALE_BINDING/
 * STARTUP_REQUIRED/UNKNOWN_EXECUTION/WORKSPACE_CONFLICT/BUDGET_EXCEEDED。 */
import type { Store } from "@projectorch/persistence";
import { budgetView, type BudgetLimits } from "../budget/index.js";
import {workspaceWriterConflict} from '../workspaces/writer-conflicts.js';

export interface DispatchRequest {
  readonly projectId: string;
  readonly roleId: string;
  readonly bindingEpoch: number;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly workspaceId?: string;
  readonly budgetLimits?: BudgetLimits;
  /** 动态角色并发上限（活动尝试涉及的不同角色数）；未设不限制。 */
  readonly maxDynamicRoles?: number;
}

export interface DispatchDenial {
  readonly code: "USER_PAUSED" | "DISPATCH_HELD" | "FORBIDDEN" | "CAPABILITY_UNSUPPORTED" | "STALE_BINDING" | "STARTUP_REQUIRED" | "UNKNOWN_EXECUTION" | "WORKSPACE_CONFLICT" | "BUDGET_EXCEEDED";
  readonly detail: string;
}

export interface DispatchDecision {
  readonly allowed: boolean;
  readonly denials: readonly DispatchDenial[];
}

type Db = Store["db"];

/** 只读评估：收集全部拒绝原因。 */
export function evaluateDispatch(store: Store, request: DispatchRequest): DispatchDecision {
  const denials: DispatchDenial[] = [];
  const db = store.db;
  const project = db.prepare("SELECT user_paused,hold_revision FROM projects WHERE id=?").get(request.projectId) as { user_paused: number; hold_revision: number } | undefined;
  if (!project) throw new Error("DISPATCH_PROJECT_NOT_FOUND");
  if (Number(project.user_paused) === 1) denials.push({ code: "USER_PAUSED", detail: "项目处于用户暂停" });
  const hold = db.prepare("SELECT 1 FROM goal_holds WHERE project_id=? AND state IN ('pending','awaiting_user') LIMIT 1").get(request.projectId);
  if (hold) denials.push({ code: "DISPATCH_HELD", detail: "目标hold未解除" });
  const role = db.prepare("SELECT desired_state,binding_state,startup_protocol_version FROM roles WHERE id=? AND project_id=?").get(request.roleId, request.projectId) as { desired_state: string; binding_state: string; startup_protocol_version: number | null } | undefined;
  if (!role) throw new Error("DISPATCH_ROLE_NOT_FOUND");
  if (role.desired_state !== "enabled" || role.binding_state === "error") denials.push({ code: "FORBIDDEN", detail: `角色意图=${role.desired_state} 绑定=${role.binding_state}` });
  const binding = db.prepare("SELECT id,epoch FROM role_bindings WHERE project_id=? AND role_id=? AND ended_at IS NULL ORDER BY epoch DESC LIMIT 1").get(request.projectId, request.roleId) as { id: string; epoch: number } | undefined;
  if (!binding || Number(binding.epoch) !== request.bindingEpoch) denials.push({ code: "STALE_BINDING", detail: `当前epoch=${binding ? binding.epoch : "无"} 请求epoch=${request.bindingEpoch}` });
  if (role.startup_protocol_version === null || role.startup_protocol_version === undefined) denials.push({ code: "STARTUP_REQUIRED", detail: "启动握手未完成" });
  // 同角色同任务的未决执行（含unknown占位）不得重复派发：不确定不视为空闲
  const active = binding ? db.prepare("SELECT 1 FROM attempts WHERE project_id=? AND binding_id=? AND task_id=? AND state IN ('dispatching','running','unknown') LIMIT 1").get(request.projectId, String(binding.id), request.taskId) : undefined;
  if (active) denials.push({ code: "UNKNOWN_EXECUTION", detail: "同任务已有未决执行（含unknown占位）" });
  if (request.workspaceId !== undefined) {
    const workspace = db.prepare("SELECT enforcement,state FROM workspaces WHERE id=? AND project_id=?").get(request.workspaceId, request.projectId) as { enforcement: string; state: string } | undefined;
    if (!workspace) throw new Error("DISPATCH_WORKSPACE_NOT_FOUND");
    if (workspace.enforcement === "unknown") denials.push({ code: "CAPABILITY_UNSUPPORTED", detail: "工作目录强制能力未知，不派发" });
    if (workspace.state === "unknown") denials.push({ code: "WORKSPACE_CONFLICT", detail: "外部修改待基线核对" });
    if(workspaceWriterConflict(store,request.projectId,request.workspaceId))denials.push({code:'WORKSPACE_CONFLICT',detail:'真实目录身份或写范围存在未决冲突'});
    const conflict = db.prepare("SELECT task_id FROM workspace_reservations WHERE workspace_id=? AND state IN ('reserved','unknown')").get(request.workspaceId) as { task_id: string } | undefined;
    if (conflict && String(conflict.task_id) !== request.taskId) denials.push({ code: "WORKSPACE_CONFLICT", detail: `目录被任务${String(conflict.task_id)}独占` });
    else if (conflict && String(conflict.task_id) === request.taskId) denials.push({ code: "UNKNOWN_EXECUTION", detail: "同任务已有未决目录占位（重复认领）" });
  }
  if (request.budgetLimits !== undefined) {
    const budget = budgetView(store, request.projectId, request.roleId);
    const check = budgetViewCheck(budget, request.budgetLimits);
    if (check) denials.push(check);
  }
  if (request.maxDynamicRoles !== undefined) {
    const dynamic = Number(db.prepare("SELECT COUNT(DISTINCT b.role_id) AS n FROM attempts a JOIN role_bindings b ON b.id=a.binding_id WHERE a.project_id=? AND a.state IN ('dispatching','running','unknown')").get(request.projectId)?.n);
    if (dynamic >= request.maxDynamicRoles) denials.push({ code: "BUDGET_EXCEEDED", detail: `动态角色并发${dynamic}>=上限${request.maxDynamicRoles}` });
  }
  return { allowed: denials.length === 0, denials };
}

function budgetViewCheck(budget: ReturnType<typeof budgetView>, limits: BudgetLimits): DispatchDenial | null {
  if (limits.maxAttemptsPerRole !== undefined && budget.attempts >= limits.maxAttemptsPerRole) return { code: "BUDGET_EXCEEDED", detail: `尝试数${budget.attempts}>=上限${limits.maxAttemptsPerRole}` };
  if (limits.maxOutboxRetriesPerRole !== undefined && budget.outboxRetries >= limits.maxOutboxRetriesPerRole) return { code: "BUDGET_EXCEEDED", detail: `Outbox重试${budget.outboxRetries}>=上限${limits.maxOutboxRetriesPerRole}` };
  if (limits.maxAdminCyclesPerRole !== undefined && budget.adminCycles >= limits.maxAdminCyclesPerRole) return { code: "BUDGET_EXCEEDED", detail: `管理循环${budget.adminCycles}>=上限${limits.maxAdminCyclesPerRole}` };
  return null;
}

export interface DispatchReservation {
  readonly attemptId: string;
  readonly reservationFence: number;
  readonly workspaceState: "reserved" | null;
}

/** 准入通过后的占位登记（单事务）：执行尝试（dispatching）+工作目录独占（one-writer索引兜底）。
 * unknown占位由后续不确定结算迁移（T026），不超时自动释放。 */
export function reserveDispatch(store: Store, request: DispatchRequest & { readonly attemptId: string }, now: number): DispatchReservation {
  return store.transaction(() => reserveDispatchWithin(store, request, now));
}

/** 生产协调器在同一事务保存准入快照、尝试和目录占位。 */
export function reserveDispatchWithin(store: Store, request: DispatchRequest & { readonly attemptId: string }, now: number): DispatchReservation {
    const db = store.db;
    if (!db.isTransaction || !Number.isSafeInteger(now) || now < 0) throw new Error("DISPATCH_TRANSACTION_REQUIRED");
    const decision = evaluateDispatchInTransaction(store, request);
    if (!decision.allowed) throw new Error(`DISPATCH_DENIED:${decision.denials.map(d => d.code).join(",")}`);
    let fence = 0;
    let workspaceState: "reserved" | null = null;
    if (request.workspaceId !== undefined) {
      const revisionRow = db.prepare("SELECT task_id FROM task_revisions WHERE task_id=? AND project_id=? AND revision=?").get(request.taskId, request.projectId, request.taskRevision);
      if (!revisionRow) throw new Error("DISPATCH_TASK_REVISION_NOT_FOUND");
      const current = db.prepare("SELECT COALESCE(MAX(fence),0) AS f FROM workspace_reservations WHERE workspace_id=?").get(request.workspaceId) as { f: number };
      fence = Number(current.f) + 1;
      db.prepare("INSERT INTO workspace_reservations(id,project_id,workspace_id,task_id,task_revision,fence,state) VALUES(?,?,?,?,?,?,'reserved')").run(`res-${request.attemptId}`, request.projectId, request.workspaceId, request.taskId, request.taskRevision, fence);
      workspaceState = "reserved";
    }
    const binding = db.prepare("SELECT id,epoch FROM role_bindings WHERE project_id=? AND role_id=? AND ended_at IS NULL ORDER BY epoch DESC LIMIT 1").get(request.projectId, request.roleId) as { id: string; epoch: number };
    db.prepare("INSERT INTO attempts(id,project_id,task_id,task_revision,binding_id,binding_epoch,workspace_id,execution_kind,state,started_at) VALUES(?,?,?,?,?,?,?, 'native','dispatching',?)").run(request.attemptId, request.projectId, request.taskId, request.taskRevision, String(binding.id), Number(binding.epoch), request.workspaceId ?? null, now);
    return { attemptId: request.attemptId, reservationFence: fence, workspaceState };
}

function evaluateDispatchInTransaction(store: Store, request: DispatchRequest): DispatchDecision {
  return evaluateDispatch(store, request);
}

export interface AttemptReconciliation {
  readonly attemptId: string;
  readonly state: "succeeded" | "failed" | "unknown";
}

/** 旧入口只保留unknown读取；任意对象回执不证明原生终态。终态核对由可信执行协调器完成。 */
export function reconcileAttempt(store: Store, input: { readonly projectId: string; readonly attemptId: string; readonly outcome: "succeeded" | "failed" | "unknown"; readonly nativeReceipt: unknown }, now: number): AttemptReconciliation {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_ATTEMPT_TIME");
  if (input.nativeReceipt === undefined || input.nativeReceipt === null || typeof input.nativeReceipt !== "object" || Array.isArray(input.nativeReceipt)) throw new Error("INVALID_ATTEMPT_RECEIPT");
  return store.transaction(db => {
    const row = db.prepare("SELECT state FROM attempts WHERE id=? AND project_id=?").get(input.attemptId, input.projectId) as { state: string } | undefined;
    if (!row) throw new Error("ATTEMPT_NOT_FOUND");
    if (String(row.state) !== "unknown") throw new Error("ATTEMPT_NOT_UNKNOWN");
    if (input.outcome === "unknown") return { attemptId: input.attemptId, state: "unknown" as const };
    throw new Error("TRUSTED_EXECUTION_RECONCILIATION_REQUIRED");
  });
}

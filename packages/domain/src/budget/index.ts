/** R023准备切片：预算与公平性。预算视图=从权威表实时计数（attempts执行次数/outbox重试/changesets管理循环）；
 * 上限判定=超限明确拒绝（LIMIT_EXCEEDED），不可计量费用显式unknown（不伪造数字）；
 * 公平序=轮转交错（管理队列与执行队列交替），管理任务不被执行任务饿死（R023）。 */
import type { Store } from "@projectorch/persistence";

export interface RoleBudget {
  readonly roleId: string;
  readonly attempts: number;
  readonly outboxRetries: number;
  readonly adminCycles: number;
  /** 无法归因的项目用量单列，不能把其他角色/用户用量重复记给本角色。 */
  readonly unattributedProject: {readonly outboxRetries:number;readonly adminCycles:number};
  /** 不可计量项显式unknown：模型服务费用由Harness计量，内核不伪造数字。 */
  readonly unknownCosts: readonly string[];
}

export interface BudgetLimits {
  readonly maxAttemptsPerRole?: number;
  readonly maxOutboxRetriesPerRole?: number;
  readonly maxAdminCyclesPerRole?: number;
}

export type BudgetCheck = { readonly allowed: true } | { readonly allowed: false; readonly reason: string; readonly kind: string; readonly current: number; readonly limit: number };

/** 角色预算视图：全部从权威表实时计数（无缓存账本——计数即真相）。 */
export function budgetView(store: Store, projectId: string, roleId: string): RoleBudget {
  const attempts = Number(store.db.prepare("SELECT COUNT(*) AS n FROM attempts a JOIN role_bindings b ON a.binding_id=b.id AND a.project_id=b.project_id WHERE a.project_id=? AND b.role_id=?").get(projectId, roleId)?.n ?? 0);
  const outboxRetries = Number(store.db.prepare("SELECT COALESCE(SUM(o.attempts),0) AS n FROM outbox o JOIN agent_command_scopes s ON s.command_id=o.command_id WHERE s.project_id=? AND s.role_id=?").get(projectId,roleId)?.n ?? 0);
  const adminCycles = Number(store.db.prepare("SELECT COUNT(*) AS n FROM changesets c JOIN agent_command_scopes s ON s.command_id=c.command_id AND s.project_id=c.project_id WHERE c.project_id=? AND s.role_id=?").get(projectId,roleId)?.n ?? 0);
  const unknownRetries=Number(store.db.prepare('SELECT COALESCE(SUM(o.attempts),0) AS n FROM outbox o JOIN commands c ON c.id=o.command_id WHERE c.project_id=? AND NOT EXISTS(SELECT 1 FROM agent_command_scopes s WHERE s.command_id=c.id AND s.project_id=c.project_id)').get(projectId)?.n??0);
  const unknownCycles=Number(store.db.prepare('SELECT COUNT(*) AS n FROM changesets c WHERE c.project_id=? AND NOT EXISTS(SELECT 1 FROM agent_command_scopes s WHERE s.command_id=c.command_id AND s.project_id=c.project_id)').get(projectId)?.n??0);
  return Object.freeze({ roleId, attempts, outboxRetries, adminCycles,unattributedProject:Object.freeze({outboxRetries:unknownRetries,adminCycles:unknownCycles}), unknownCosts: Object.freeze(["model_usage"]) });
}

/** 上限判定：逐类检查当前计数是否超限；未设上限的类别不限制（显式无上限优于隐式）。 */
export function checkBudget(budget: RoleBudget, limits: BudgetLimits): BudgetCheck {
  if (limits.maxAttemptsPerRole !== undefined && budget.attempts > limits.maxAttemptsPerRole) return { allowed: false, reason: "LIMIT_EXCEEDED", kind: "attempts", current: budget.attempts, limit: limits.maxAttemptsPerRole };
  if (limits.maxOutboxRetriesPerRole !== undefined && budget.outboxRetries > limits.maxOutboxRetriesPerRole) return { allowed: false, reason: "LIMIT_EXCEEDED", kind: "outboxRetries", current: budget.outboxRetries, limit: limits.maxOutboxRetriesPerRole };
  if (limits.maxAdminCyclesPerRole !== undefined && budget.adminCycles > limits.maxAdminCyclesPerRole) return { allowed: false, reason: "LIMIT_EXCEEDED", kind: "adminCycles", current: budget.adminCycles, limit: limits.maxAdminCyclesPerRole };
  return { allowed: true };
}

/** 公平序：管理队列与执行队列严格交替（管理不被饿死）；同队列内保持给定顺序。
 * 返回交错后的角色序列；任一队列为空则另一队列顺序续排。 */
export function fairInterleave<T extends { readonly isManagement: boolean }>(pending: readonly T[]): readonly T[] {
  const management = pending.filter(item => item.isManagement);
  const execution = pending.filter(item => !item.isManagement);
  const out: T[] = [];
  let m = 0;
  let e = 0;
  let turnManagement = true;
  const managementItems = [...management];
  const executionItems = [...execution];
  while (m < managementItems.length || e < executionItems.length) {
    if (turnManagement && m < managementItems.length) { const item = managementItems[m]; if (item) { out.push(item); } m += 1; }
    else if (!turnManagement && e < executionItems.length) { const item = executionItems[e]; if (item) { out.push(item); } e += 1; }
    else if (m < managementItems.length) { const item = managementItems[m]; if (item) { out.push(item); } m += 1; }
    else if (e < executionItems.length) { const item = executionItems[e]; if (item) { out.push(item); } e += 1; }
    turnManagement = !turnManagement;
  }
  return Object.freeze(out);
}

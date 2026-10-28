/** T026：送达核对闭环。uncertain操作→外部探测实际效果→applied结算delivered / not_applied重排pending（由上层决定是否重发）/ unknown保持uncertain。
 * 无法查证时按操作指纹建立/合并异常事项（raiseIssue，同指纹合并不重复建案）。探测以operationKey为身份（仅文本相同不构成同次消息）。
 * 探测函数同步实现，逐条独立结算（单条失败不影响其余）。 */
import { randomUUID } from "node:crypto";
import type { Store } from "@projectorch/persistence";
import { listUncertainOutbox, reconcileUncertainOutbox } from "@projectorch/persistence/outbox";
import { raiseIssue } from "@projectorch/domain/issues";

export interface ReconcileResult {
  readonly delivered: number;
  readonly requeued: number;
  readonly stayedUncertain: number;
  readonly issuesRaised: number;
}

export interface ReconcileServices {
  /** 探测实际效果：applied=外部系统已产生该操作效果；not_applied=确认未产生；unknown=无法判定。 */
  readonly probe: (operation: { readonly id: string; readonly operationKey: string; readonly payload: unknown }) => "applied" | "not_applied" | "unknown";
  /** 无法查证时建立事项的项目归属（未设则不建案，仅保持uncertain）。 */
  readonly issueProjectId?: string;
  readonly issueOwnerRoleId?: string;
}

export function reconcileDelivery(store: Store, services: ReconcileServices, options: { readonly now: number; readonly retryDelayMs: number; readonly maxPerRun?: number }): ReconcileResult {
  if (typeof services.probe !== "function") throw new Error("SYNC_PROBE_REQUIRED");
  const maxPerRun = options.maxPerRun ?? 32;
  const result: { delivered: number; requeued: number; stayedUncertain: number; issuesRaised: number } = { delivered: 0, requeued: 0, stayedUncertain: 0, issuesRaised: 0 };
  const pending = listUncertainOutbox(store, maxPerRun);
  for (const operation of pending) {
    let probe: "applied" | "not_applied" | "unknown";
    try { probe = services.probe(operation); }
    catch { probe = "unknown"; }
    if (probe === "unknown") {
      result.stayedUncertain += 1;
      if (services.issueProjectId !== undefined) {
        try {
          const raised = raiseIssue(store, { id: `case-${randomUUID()}`, projectId: services.issueProjectId, ownerRoleId: services.issueOwnerRoleId, fingerprint: `delivery-unverifiable:${operation.operationKey}`, evidence: { operationKey: operation.operationKey, outboxId: operation.id, attempts: operation.attempts, probedAt: options.now } }, options.now);
          if (!raised.merged) result.issuesRaised += 1;
        } catch { result.stayedUncertain += 1; }
      }
      continue;
    }
    try {
      const outcome = reconcileUncertainOutbox(store, operation.id, probe, { reconciledAt: options.now, operationKey: operation.operationKey }, options.now, options.retryDelayMs);
      if (outcome === "delivered") result.delivered += 1;
      else result.requeued += 1;
    } catch { result.stayedUncertain += 1; }
  }
  return Object.freeze(result);
}

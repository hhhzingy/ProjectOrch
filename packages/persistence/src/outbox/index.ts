import type { DatabaseSync } from "node:sqlite";
import type { Store } from "../index.js";
import { canonicalJson } from "./json.js";

export { canonicalJson } from "./json.js";

function token(value: string): void {
  if (typeof value !== "string" || !value.length || value.length > 512) throw new Error("INVALID_OUTBOX_TOKEN");
}
function timestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("INVALID_OUTBOX_TIME");
}
export interface EnqueueOperation {
  readonly id: string;
  readonly commandId: string;
  readonly operationKey: string;
  readonly payload: unknown;
  readonly nextAttemptAt: number;
}
export interface OutboxLease {
  readonly id: string;
  readonly commandId: string;
  readonly operationKey: string;
  readonly epoch: number;
  readonly expiresAt: number;
  readonly attempts: number;
  readonly payload: unknown;
}

/** 受信领域事务内调用：先完成权限/版本校验，再与状态、事件一同提交。 */
export function enqueueOutbox(db: DatabaseSync, operation: EnqueueOperation): string {
  if (!db.isTransaction) throw new Error("OUTBOX_TRANSACTION_REQUIRED");
  token(operation.id); token(operation.commandId); token(operation.operationKey); timestamp(operation.nextAttemptAt);
  const payload = canonicalJson(operation.payload);
  const previous = db.prepare("SELECT id,command_id,payload_json FROM outbox WHERE operation_key=?").get(operation.operationKey);
  if (previous) {
    if (previous.command_id !== operation.commandId || previous.payload_json !== payload) throw new Error("OUTBOX_IDEMPOTENCY_CONFLICT");
    return String(previous.id);
  }
  db.prepare("INSERT INTO outbox(id,command_id,operation_key,payload_json,state,next_attempt_at) VALUES(?,?,?,?,'pending',?)").run(operation.id, operation.commandId, operation.operationKey, payload, operation.nextAttemptAt);
  return operation.id;
}

/** 仅存储领取，不授权原生派发；外发前仍必须运行 DispatchGuard。 */
export function claimOutbox(store: Store, now: number, leaseMs: number, route: "all" | "external" = "all"): OutboxLease | null {
  timestamp(now);
  if (route !== "all" && route !== "external") throw new Error("INVALID_OUTBOX_ROUTE");
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000 || !Number.isSafeInteger(now + leaseMs)) throw new Error("INVALID_LEASE_DURATION");
  return store.transaction(db => {
    const row = db.prepare("SELECT id FROM outbox WHERE state='pending' AND next_attempt_at<=? AND (?='all' OR json_extract(payload_json,'$.event') IS NOT 'workflow.evaluate') ORDER BY next_attempt_at,id LIMIT 1").get(now, route);
    if (!row) return null;
    const claimed = db.prepare("UPDATE outbox SET state='dispatching',lease_epoch=lease_epoch+1,lease_until=?,attempts=attempts+1 WHERE id=? AND state='pending' RETURNING id,command_id,operation_key,lease_epoch,lease_until,attempts,payload_json").get(now + leaseMs, String(row.id));
    if (!claimed) throw new Error("OUTBOX_CLAIM_CONFLICT");
    return Object.freeze({ id: String(claimed.id), commandId: String(claimed.command_id), operationKey: String(claimed.operation_key), epoch: Number(claimed.lease_epoch), expiresAt: Number(claimed.lease_until), attempts: Number(claimed.attempts), payload: JSON.parse(String(claimed.payload_json)) as unknown });
  });
}

/** 成功必须由受信适配器提供可靠回执；未知结果只能 uncertain，不能自动重发。 */
export function settleOutbox(store: Store, id: string, epoch: number, now: number, outcome: "delivered" | "uncertain", nativeReceipt: unknown): void {
  token(id); timestamp(now);
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("INVALID_LEASE_EPOCH");
  if (outcome !== "delivered" && outcome !== "uncertain") throw new Error("INVALID_OUTBOX_OUTCOME");
  if (!nativeReceipt || typeof nativeReceipt !== "object" || Array.isArray(nativeReceipt)) throw new Error("INVALID_NATIVE_RECEIPT");
  const receipt = canonicalJson(nativeReceipt);
  store.transaction(db => {
    const result = db.prepare("UPDATE outbox SET state=?,lease_until=NULL,native_receipt_json=? WHERE id=? AND state='dispatching' AND lease_epoch=? AND lease_until>?").run(outcome, receipt, id, epoch, now);
    if (Number(result.changes) !== 1) throw new Error("OUTBOX_LEASE_LOST");
  });
}

/** 期限到达不证明外部未执行；撤销旧代次并持久化为 uncertain，保持人工/领域核对。 */
export function recoverExpiredOutbox(store: Store, now: number): number {
  timestamp(now);
  return store.transaction(db => Number(db.prepare("UPDATE outbox SET state='uncertain',lease_epoch=lease_epoch+1,lease_until=NULL WHERE state='dispatching' AND lease_until<=?").run(now).changes));
}

/** 已知失败的重试安排：仅处理自己持有的活跃租约；达到maxAttempts转exhausted（终态，人工核对），否则回pending按backoff重排。 */
export function failOutbox(store: Store, id: string, epoch: number, now: number, retryDelayMs: number, maxAttempts: number): "pending" | "exhausted" {
  token(id); timestamp(now);
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("INVALID_LEASE_EPOCH");
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 24 * 60 * 60 * 1000) throw new Error("INVALID_RETRY_DELAY");
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 64) throw new Error("INVALID_MAX_ATTEMPTS");
  return store.transaction(db => {
    const row = db.prepare("SELECT attempts FROM outbox WHERE id=? AND state='dispatching' AND lease_epoch=? AND lease_until>?").get(id, epoch, now);
    if (!row) throw new Error("OUTBOX_LEASE_LOST");
    const attempts = Number(row.attempts);
    if (attempts >= maxAttempts) {
      db.prepare("UPDATE outbox SET state='exhausted',lease_until=NULL WHERE id=? AND state='dispatching' AND lease_epoch=?").run(id, epoch);
      return "exhausted" as const;
    }
    db.prepare("UPDATE outbox SET state='pending',next_attempt_at=?,lease_until=NULL WHERE id=? AND state='dispatching' AND lease_epoch=?").run(now + retryDelayMs, id, epoch);
    return "pending" as const;
  });
}

/** 送达核对（T026准备）：uncertain操作经外部探测确认实际效果后结算。
 * applied→delivered（附核对回执）；not_applied→pending（backoff重排，重发决策由上层）；
 * unknown→保持uncertain。仅处理uncertain状态，不触碰dispatching租约语义。 */
export function reconcileUncertainOutbox(store: Store, id: string, probe: "applied" | "not_applied", receipt: unknown, now: number, retryDelayMs: number): "delivered" | "pending" {
  token(id); timestamp(now);
  if (probe !== "applied" && probe !== "not_applied") throw new Error("INVALID_PROBE_OUTCOME");
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 24 * 60 * 60 * 1000) throw new Error("INVALID_RETRY_DELAY");
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("INVALID_NATIVE_RECEIPT");
  const receiptJson = canonicalJson({ reconciled: true, probe, ...(receipt as Record<string, unknown>) });
  return store.transaction(db => {
    const row = db.prepare("SELECT state FROM outbox WHERE id=?").get(id);
    if (!row || String(row.state) !== "uncertain") throw new Error("OUTBOX_NOT_UNCERTAIN");
    if (probe === "applied") {
      db.prepare("UPDATE outbox SET state='delivered',native_receipt_json=? WHERE id=? AND state='uncertain'").run(receiptJson, id);
      return "delivered" as const;
    }
    db.prepare("UPDATE outbox SET state='pending',native_receipt_json=NULL,next_attempt_at=? WHERE id=? AND state='uncertain'").run(now + retryDelayMs, id);
    return "pending" as const;
  });
}

/** 列出uncertain操作供探测（分页）。 */
export function listUncertainOutbox(store: Store, limit: number): { readonly id: string; readonly operationKey: string; readonly commandId: string; readonly payload: unknown; readonly attempts: number }[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("INVALID_LIST_LIMIT");
  return (store.db.prepare("SELECT id,operation_key,command_id,payload_json,attempts FROM outbox WHERE state='uncertain' ORDER BY id LIMIT ?").all(limit) as Record<string, unknown>[]).map(row => Object.freeze({ id: String(row.id), operationKey: String(row.operation_key), commandId: String(row.command_id), payload: JSON.parse(String(row.payload_json)), attempts: Number(row.attempts) }));
}

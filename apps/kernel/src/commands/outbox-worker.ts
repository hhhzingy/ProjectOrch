/** T017/T019准备切片：Outbox投递工作器。单次pump有界（防无界循环）；领取→同步投递→delivered/uncertain结算；
 * 只有明确not_delivered允许backoff重排；抛错/无效回执默认uncertain，不能据此推断外部未执行。 */
import type { Store } from "@projectorch/persistence";
import { claimOutbox, settleOutbox, failOutbox, recoverExpiredOutbox, type OutboxLease } from "@projectorch/persistence/outbox";

export type OutboxDelivery = "delivered" | "uncertain" | "not_delivered";
export interface OutboxWorkerServices {
  /** 仅在可靠确认外部未执行时返回not_delivered；发送后异常或未知回执必须uncertain。
   * 外发前DispatchGuard仍由可信集成层执行，状态字符串本身不授予派发权限。 */
  readonly deliver: (lease: OutboxLease) => OutboxDelivery;
}
export interface OutboxWorkerOptions {
  readonly now: () => number;
  readonly leaseMs?: number;
  readonly backoffMs?: number;
  readonly maxAttempts?: number;
  /** 单次pump最多处理的操作数，防慢投递独占。 */
  readonly maxPerPump?: number;
}
export interface OutboxPumpResult {
  readonly delivered: number;
  readonly uncertain: number;
  readonly retried: number;
  readonly exhausted: number;
  readonly recoveredExpired: number;
}

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_BACKOFF_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_MAX_PER_PUMP = 16;

export function pumpOutbox(store: Store, services: OutboxWorkerServices, options: OutboxWorkerOptions): OutboxPumpResult {
  if (typeof services.deliver !== "function" || services.deliver.constructor.name === "AsyncFunction") throw new Error("SYNC_DELIVER_REQUIRED");
  const now = options.now;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxPerPump = options.maxPerPump ?? DEFAULT_MAX_PER_PUMP;
  // 在外发之前拒绝非法策略，避免副作用发生后才因重试参数无效而失去结算。
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) throw new Error("INVALID_LEASE_DURATION");
  if (!Number.isSafeInteger(backoffMs) || backoffMs < 0 || backoffMs > 24 * 60 * 60 * 1000) throw new Error("INVALID_RETRY_DELAY");
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 64) throw new Error("INVALID_MAX_ATTEMPTS");
  if (!Number.isSafeInteger(maxPerPump) || maxPerPump < 1 || maxPerPump > 200) throw new Error("INVALID_MAX_PER_PUMP");
  const result: { delivered: number; uncertain: number; retried: number; exhausted: number; recoveredExpired: number } = { delivered: 0, uncertain: 0, retried: 0, exhausted: 0, recoveredExpired: recoverExpiredOutbox(store, now()) };
  for (let handled = 0; handled < maxPerPump; handled++) {
    // workflow.evaluate 是内部准备意图，不得由外部投递器伪报执行完成。
    const lease = claimOutbox(store, now(), leaseMs, "external");
    if (!lease) break;
    let outcome: OutboxDelivery;
    try {
      outcome = services.deliver(lease);
      if (outcome !== "delivered" && outcome !== "uncertain" && outcome !== "not_delivered") {
        // JS调用方可能误交Promise；外部工作可能已启动，必须占位且吸收拒绝避免未处理异常。
        void Promise.resolve(outcome).catch(() => undefined);
        outcome = "uncertain";
      }
    } catch {
      outcome = "uncertain";
    }
    if (outcome === "not_delivered") {
      const disposition = failOutbox(store, lease.id, lease.epoch, now(), backoffMs, maxAttempts);
      if (disposition === "exhausted") result.exhausted += 1;
      else result.retried += 1;
      continue;
    }
    settleOutbox(store, lease.id, lease.epoch, now(), outcome, { deliveredAt: now(), operationKey: lease.operationKey, epoch: lease.epoch });
    if (outcome === "delivered") result.delivered += 1;
    else result.uncertain += 1;
  }
  return Object.freeze(result);
}

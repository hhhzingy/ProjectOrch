import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Store } from "@projectorch/persistence";
import { canonicalJson } from "@projectorch/persistence/outbox";
import { parseContract } from "@projectorch/contracts";

export const pairingAttemptLimit = 5;
export interface PairingChallenge {
  readonly challengeId: string;
  /** 仅交给受信本地UI一次，不进入日志、URL、报告或项目文件。 */
  readonly oneTimeCode: string;
  readonly expiresAt: number;
}
function time(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("INVALID_PAIRING_TIME");
}
const digest = (value: string) => createHash("sha256").update("projectorch-pairing-v2\0").update(value).digest();

/** 只能由受信本地启动/用户操作触发，不对未认证HTTP请求开放。 */
export function issuePairingChallenge(store: Store, now = Date.now(), ttlMs = 120_000): PairingChallenge {
  time(now);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000 || !Number.isSafeInteger(now + ttlMs)) throw new Error("INVALID_PAIRING_TTL");
  const challengeId = randomUUID(); const oneTimeCode = randomBytes(32).toString("base64url");
  const expiresAt = now + ttlMs;
  store.transaction(db => db.prepare("INSERT INTO pairing_challenges(id,code_hash,expires_at) VALUES(?,?,?)").run(challengeId, digest(oneTimeCode).toString("hex"), expiresAt));
  return Object.freeze({ challengeId, oneTimeCode, expiresAt });
}

/** 同一事务中消费挑战并建立未来浏览器会话；false必须正常提交以保留失败次数。
 * 调用前先核验配对来源。此函数本身不颁发身份/凭据，也不表示浏览器已经配对。
 */
export function consumePairingChallenge(db: DatabaseSync, input: unknown, now = Date.now()): { readonly accepted: boolean; readonly requestId: string } {
  if (!db.isTransaction) throw new Error("PAIRING_TRANSACTION_REQUIRED");
  time(now);
  const request = parseContract("pairing", JSON.parse(canonicalJson(input)));
  const rejected = { accepted: false, requestId: request.requestId } as const;
  const row = db.prepare("SELECT code_hash,expires_at,consumed_at,failed_attempts FROM pairing_challenges WHERE id=?").get(request.challengeId);
  if (!row || row.consumed_at !== null || Number(row.expires_at) <= now || Number(row.failed_attempts) >= pairingAttemptLimit) return rejected;
  const stored = String(row.code_hash);
  const matches = /^[a-f0-9]{64}$/.test(stored) && timingSafeEqual(Buffer.from(stored, "hex"), digest(request.oneTimeCode));
  if (!matches) {
    db.prepare("UPDATE pairing_challenges SET failed_attempts=failed_attempts+1 WHERE id=?").run(request.challengeId);
    return rejected;
  }
  db.prepare("UPDATE pairing_challenges SET consumed_at=? WHERE id=?").run(now, request.challengeId);
  return { accepted: true, requestId: request.requestId };
}

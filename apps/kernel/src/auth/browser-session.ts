import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Store } from "@projectorch/persistence";
import { consumePairingChallenge } from "./pairing.js";
import { assertPairingSource, type LocalOrigin } from "./local-source.js";

export interface BrowserCredentials {
  readonly sessionId: string;
  /** 只交给浏览器的HttpOnly Cookie，禁止日志、URL和项目文件。 */
  readonly cookieValue: string;
  /** 同源配对响应交付客户端，写请求专用；禁止日志和URL。 */
  readonly csrfToken: string;
  readonly expiresAt: number;
}
export interface BrowserPrincipal {
  readonly kind: "authenticated_user";
  readonly principalId: string;
  readonly sessionId: string;
}
const digest = (purpose: string, id: string, value: string): Buffer => createHash("sha256").update(`projectorch-browser-${purpose}-v1\0${id}\0`).update(value).digest();
function clock(now: number): void { if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_BROWSER_TIME"); }
function validToken(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value); }
function matches(stored: unknown, expected: Buffer): boolean { return typeof stored === "string" && /^[a-f0-9]{64}$/.test(stored) && timingSafeEqual(Buffer.from(stored, "hex"), expected); }

/** 内部准备服务。principalId只能来自受信本地启动配置，不能从配对正文取值。 */
export function completeBrowserPairing(store: Store, input: unknown, principalId: string, source: { readonly config: LocalOrigin; readonly peerAddress: string | undefined; readonly rawHeaders: readonly string[] }, now = Date.now(), ttlMs = 8 * 60 * 60 * 1000): { readonly accepted: false } | { readonly accepted: true; readonly credentials: BrowserCredentials } {
  assertPairingSource(source.config, source.peerAddress, source.rawHeaders);
  clock(now);
  if (typeof principalId !== "string" || !principalId || principalId.length > 128) throw new Error("INVALID_LOCAL_USER_ID");
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 24 * 60 * 60 * 1000 || !Number.isSafeInteger(now + ttlMs)) throw new Error("INVALID_BROWSER_TTL");
  return store.transaction(db => {
    const result = consumePairingChallenge(db, input, now);
    if (!result.accepted) return Object.freeze({ accepted: false }); // 正常提交失败次数。
    const id = randomUUID(); const token = randomBytes(32).toString("base64url"); const csrfToken = randomBytes(32).toString("base64url");
    const expiresAt = now + ttlMs;
    db.prepare("INSERT INTO browser_sessions(id,principal_id,token_hash,csrf_hash,created_at,expires_at) VALUES(?,?,?,?,?,?)").run(id, principalId, digest("session", id, token).toString("hex"), digest("csrf", id, csrfToken).toString("hex"), now, expiresAt);
    return Object.freeze({ accepted: true, credentials: Object.freeze({ sessionId: id, cookieValue: `${id}.${token}`, csrfToken, expiresAt }) });
  });
}

/** 调用前仍须校验实际HTTP来源/重复安全头。mode由可信路由确定；此函数不做项目授权。 */
export function authenticateBrowserSession(store: Store, cookieValue: unknown, csrfToken: unknown, mode: "read" | "write" | "events", now = Date.now()): BrowserPrincipal {
  clock(now);
  if (!["read", "write", "events"].includes(mode) || typeof cookieValue !== "string" || !/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(cookieValue)) throw new Error("UNAUTHENTICATED");
  const [id, token] = cookieValue.split(".");
  if (!id || !token) throw new Error("UNAUTHENTICATED");
  const row = store.db.prepare("SELECT principal_id,token_hash,csrf_hash,created_at,expires_at,revoked_at FROM browser_sessions WHERE id=?").get(id);
  if (!row || row.revoked_at !== null || Number(row.created_at) > now || Number(row.expires_at) <= now || !matches(row.token_hash, digest("session", id, token))) throw new Error("UNAUTHENTICATED");
  if (mode === "write" && (!validToken(csrfToken) || !matches(row.csrf_hash, digest("csrf", id, csrfToken)))) throw new Error("CSRF_REJECTED");
  return Object.freeze({ kind: "authenticated_user", principalId: String(row.principal_id), sessionId: id });
}

/** 已认证同源本地页面刷新后的CSRF重领；只供精确Origin+JSON路由，不能通过普通Agent调用。 */
export function rotateBrowserCsrf(store: Store, principal: BrowserPrincipal, now = Date.now()): string {
  clock(now);
  const token = randomBytes(32).toString("base64url");
  store.transaction(db => {
    const changed = db.prepare("UPDATE browser_sessions SET csrf_hash=? WHERE id=? AND principal_id=? AND revoked_at IS NULL AND created_at<=? AND expires_at>?").run(digest("csrf", principal.sessionId, token).toString("hex"), principal.sessionId, principal.principalId, now, now);
    if (Number(changed.changes) !== 1) throw new Error("UNAUTHENTICATED");
  });
  return token;
}

/** 必须传入刚认证得到的当前用户身份；注销只作用其自身会话，不接收请求正文principal。 */
export function revokeBrowserSession(store: Store, principal: BrowserPrincipal, now = Date.now()): void {
  clock(now);
  if (principal.kind !== "authenticated_user") throw new Error("UNAUTHENTICATED");
  store.transaction(db => db.prepare("UPDATE browser_sessions SET revoked_at=? WHERE id=? AND principal_id=? AND revoked_at IS NULL AND created_at<=?").run(now, principal.sessionId, principal.principalId, now));
}

export function browserSessionCookie(credentials: BrowserCredentials, secure: boolean): string {
  if (!/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(credentials.cookieValue)) throw new Error("INVALID_COOKIE_VALUE");
  return `projectorch_session=${credentials.cookieValue}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

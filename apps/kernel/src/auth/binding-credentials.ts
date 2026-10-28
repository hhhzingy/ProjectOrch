/** 受管绑定凭据缓存（第二段5：执行链路鉴权）。
 * issueAgentCredential原文只在签发时返回；协调器principalForBinding每次需要原文认证。
 * 内核为唯一执行者——原文存数据目录受信文件（同control-entry.json模式：0600、不入日志/模型正文），
 * 过期或缺失时重签并写回；绑定结束凭据自然失效（authenticateAgentCredential核对ended_at/epoch）。 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Store } from "@projectorch/persistence";
import type { SessionRef } from "@projectorch/adapter-contract";
import { issueAgentCredential, issueAgentCredentialWithin, authenticateAgentCredential } from "./agent-credential.js";

interface CredentialCache { [bindingId: string]: { readonly credential: string; readonly expiresAt: number } | undefined }

const TTL_MS = 12 * 60 * 60 * 1000;

function loadCache(file: string): CredentialCache {
  try { return JSON.parse(readFileSync(file, "utf8")) as CredentialCache; } catch { return {}; }
}

function saveCache(file: string, cache: CredentialCache): void {
  writeFileSync(file, JSON.stringify(cache, null, 1) + String.fromCharCode(10), { mode: 0o600 });
}

/** 取绑定有效凭据原文（未过期直接用；过期/缺失重签写回）。调用方可能在事务内（协调器消费路径）——按当前事务状态选择签发变体。 */
export function ensureBindingCredential(store: Store, cacheFile: string, bindingId: string, session: SessionRef, epoch: number, now: number): string {
  const cache = loadCache(cacheFile);
  const hit = cache[bindingId];
  if (hit) {
    const row=store.db.prepare('SELECT revoked_at FROM agent_credentials WHERE id=?').get(hit.credential.split('.')[0]??'');
    if (row && row.revoked_at!==null) throw new Error('AGENT_CREDENTIAL_REVOKED');
  }
  if (hit && hit.expiresAt > now + 60_000) return hit.credential;
  const issued = issue(store, cacheFile, cache, bindingId, session, epoch, now);
  return issued;
}

/** 强制重签（忽略缓存）——缓存指向的凭据行已随历史事务回滚等场景的自愈。 */
export function renewBindingCredential(store: Store, cacheFile: string, bindingId: string, session: SessionRef, epoch: number, now: number): string {
  const cache = loadCache(cacheFile);
  delete cache[bindingId];
  return issue(store, cacheFile, cache, bindingId, session, epoch, now);
}

function issue(store: Store, cacheFile: string, cache: CredentialCache, bindingId: string, session: SessionRef, epoch: number, now: number): string {
  // 事务内用Within变体（与外层事务同事务提交，避免嵌套事务被禁）；事务外自管事务
  const issued = store.db.isTransaction
    ? issueAgentCredentialWithin(store, bindingId, epoch, { isolation: "verified_session", session }, now, TTL_MS)
    : issueAgentCredential(store, bindingId, epoch, { isolation: "verified_session", session }, now, TTL_MS);
  cache[bindingId] = { credential: issued.credential, expiresAt: issued.expiresAt };
  saveCache(cacheFile, cache);
  return issued.credential;
}

/** 认证预检：缓存凭据可能指向已随事务回滚消失的行——预检失败即强制重签再验（自愈闭环）。 */
export function verifiedBindingCredential(store: Store, cacheFile: string, bindingId: string, session: SessionRef, epoch: number, now: number): string {
  let credential = ensureBindingCredential(store, cacheFile, bindingId, session, epoch, now);
  try { authenticateAgentCredential(store, credential, now); }
  catch {
    credential = renewBindingCredential(store, cacheFile, bindingId, session, epoch, now);
    authenticateAgentCredential(store, credential, now);
  }
  return credential;
}

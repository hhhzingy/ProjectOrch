import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Store } from "@projectorch/persistence";
import { parseSessionRef, sameSession, sessionKey, type SessionRef } from "@projectorch/adapter-contract";

export interface AgentPrincipal {
  readonly kind: "bound_agent";
  readonly credentialId: string;
  readonly projectId: string;
  readonly roleId: string;
  readonly bindingId: string;
  readonly bindingEpoch: number;
  readonly session: SessionRef;
}
// 认证结果是本进程的能力句柄，复制字段或反序列化不能制造可信主体。
const authenticatedPrincipals = new WeakSet<AgentPrincipal>();
const digest = (id: string, token: string): Buffer => createHash("sha256").update(`projectorch-agent-v1\0${id}\0`).update(token).digest();
const sessionDigest = (session: SessionRef): string => createHash("sha256").update(sessionKey(session)).digest("hex");
function clock(now: number): void { if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_AGENT_TIME"); }
function binding(store: Store, id: string): { projectId: string; roleId: string; epoch: number; session: SessionRef; startedAt: number } | null {
  const row = store.db.prepare(`SELECT b.project_id,b.role_id,b.epoch,b.started_at,s.harness_id,s.host_id,s.profile_id,s.native_conversation_id,s.native_workspace_id
    FROM role_bindings b JOIN roles r ON r.id=b.role_id AND r.project_id=b.project_id JOIN sessions s ON s.id=b.session_id
    WHERE b.id=? AND b.ended_at IS NULL AND r.desired_state='enabled' AND r.binding_state IN ('provisioning','ready')`).get(id);
  if (!row) return null;
  const base = { harnessId: String(row.harness_id), hostId: String(row.host_id), profileId: String(row.profile_id), nativeConversationId: String(row.native_conversation_id) };
  return { projectId: String(row.project_id), roleId: String(row.role_id), epoch: Number(row.epoch), startedAt: Number(row.started_at), session: parseSessionRef(row.native_workspace_id ? { ...base, nativeWorkspaceId: String(row.native_workspace_id) } : base) };
}

/** 内部准备服务，不是HTTP工具。connection必须来自已验证的会话隔离主机，不接受请求正文。
 * 本函数只核验数据库绑定，不能自行证明原生宿主确实隔离了凭据；T007未通过前不得向模型开放。
 */
export function issueAgentCredential(store: Store, bindingId: string, expectedEpoch: number, connection: { readonly isolation: "verified_session"; readonly session: SessionRef }, now = Date.now(), ttlMs = 60 * 60 * 1000): { readonly credential: string; readonly expiresAt: number } {
  return store.transaction(() => issueAgentCredentialWithin(store, bindingId, expectedEpoch, connection, now, ttlMs));
}

/** 受信宿主将颁发和来源审计同事务提交，不把原始凭据交给模型或写入配置。 */
export function issueAgentCredentialWithin(store: Store, bindingId: string, expectedEpoch: number, connection: { readonly isolation: "verified_session"; readonly session: SessionRef }, now: number, ttlMs: number): { readonly credential: string; readonly expiresAt: number } {
  const db = store.db;
  if (!db.isTransaction) throw new Error("AGENT_CREDENTIAL_TRANSACTION_REQUIRED");
  clock(now);
  if (connection?.isolation !== "verified_session" || !Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1 || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 24 * 60 * 60 * 1000 || !Number.isSafeInteger(now + ttlMs)) throw new Error("AGENT_CREDENTIAL_ISSUANCE_REJECTED");
  const session = parseSessionRef(connection.session);
    const current = binding(store, bindingId);
    if (!current || current.epoch !== expectedEpoch || current.startedAt > now || !sameSession(current.session, session)) throw new Error("AGENT_CREDENTIAL_ISSUANCE_REJECTED");
    const id = randomUUID(); const token = randomBytes(32).toString("base64url"); const expiresAt = now + ttlMs;
    db.prepare("INSERT INTO agent_credentials(id,binding_id,project_id,binding_epoch,session_key_hash,token_hash,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)").run(id, bindingId, current.projectId, expectedEpoch, sessionDigest(current.session), digest(id, token).toString("hex"), now, expiresAt);
    return Object.freeze({ credential: `${id}.${token}`, expiresAt });
}

/** 每次请求重新查当前绑定和撤销状态；不接收roleId/projectId等自报权限。
 * 返回身份快照，不授予动作权限；业务命令仍须在同事务重新授权和核验绑定代次。
 */
export function authenticateAgentCredential(store: Store, credential: unknown, now = Date.now()): AgentPrincipal {
  clock(now);
  if (typeof credential !== "string" || !/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(credential)) throw new Error("AGENT_UNAUTHENTICATED");
  const [id, token] = credential.split(".");
  if (!id || !token) throw new Error("AGENT_UNAUTHENTICATED");
  const row = store.db.prepare("SELECT * FROM agent_credentials WHERE id=?").get(id);
  if (!row || row.revoked_at !== null || Number(row.created_at) > now || Number(row.expires_at) <= now || typeof row.token_hash !== "string" || !/^[a-f0-9]{64}$/.test(row.token_hash) || !timingSafeEqual(Buffer.from(row.token_hash, "hex"), digest(id, token))) throw new Error("AGENT_UNAUTHENTICATED");
  const current = binding(store, String(row.binding_id));
  if (!current || current.projectId !== row.project_id || current.epoch !== row.binding_epoch || current.startedAt > now || sessionDigest(current.session) !== row.session_key_hash) throw new Error("AGENT_UNAUTHENTICATED");
  const principal: AgentPrincipal = Object.freeze({ kind: "bound_agent", credentialId: id, projectId: current.projectId, roleId: current.roleId, bindingId: String(row.binding_id), bindingEpoch: current.epoch, session: current.session });
  authenticatedPrincipals.add(principal);
  return principal;
}

/** 每次使用缓存主体时重新核验持久凭据及完整绑定；写动作须在自己的事务内再次调用。
 * 不保留token，不将结构相同的对象视作已认证，不以有效期内的旧快照代替当前撤销状态。
 */
export function assertAgentPrincipalCurrent(store: Store, principal: AgentPrincipal, now = Date.now()): void {
  clock(now);
  if (!authenticatedPrincipals.has(principal)) throw new Error("AGENT_UNAUTHENTICATED");
  const row = store.db.prepare("SELECT binding_id,project_id,binding_epoch,session_key_hash,created_at,expires_at,revoked_at FROM agent_credentials WHERE id=?").get(principal.credentialId);
  if (!row || row.revoked_at !== null || Number(row.created_at) > now || Number(row.expires_at) <= now
    || row.binding_id !== principal.bindingId || row.project_id !== principal.projectId || row.binding_epoch !== principal.bindingEpoch
    || row.session_key_hash !== sessionDigest(principal.session)) throw new Error("AGENT_UNAUTHENTICATED");
  const current = binding(store, principal.bindingId);
  if (!current || current.projectId !== principal.projectId || current.roleId !== principal.roleId || current.epoch !== principal.bindingEpoch
    || current.startedAt > now || !sameSession(current.session, principal.session)) throw new Error("AGENT_UNAUTHENTICATED");
}

/** 仅可信管理事务调用；换绑定即使未显式撤销也会在认证时拒绝旧凭据。 */
export function revokeBindingCredentials(store: Store, bindingId: string, now = Date.now()): void {
  clock(now);
  store.transaction(db => {
    if (db.prepare("SELECT id FROM agent_credentials WHERE binding_id=? AND created_at>?").get(bindingId, now)) throw new Error("INVALID_AGENT_TIME");
    db.prepare("UPDATE agent_credentials SET revoked_at=? WHERE binding_id=? AND revoked_at IS NULL").run(now, bindingId);
  });
}

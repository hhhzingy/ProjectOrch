import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { parseSessionRef, type SessionRef } from "@projectorch/adapter-contract";
import type { Store } from "@projectorch/persistence";
import { canonicalJson } from "@projectorch/persistence/outbox";
import { issueAgentCredentialWithin, authenticateAgentCredential, assertAgentPrincipalCurrent, type AgentPrincipal } from "../auth/agent-credential.js";
import { authorizeAgentAction } from "../auth/policy-check.js";
import { readProjectPolicy } from "../auth/project-policy.js";
import { parsePermissionProfile } from "@projectorch/domain/policy";
import { NativeSessionLease } from "../native/session-lease.js";
import { NativeCompatibilityRegistry, type NativeIdentity } from "../native/compatibility.js";
import { createToolDispatcher, toolAction } from "./gateway-tools.js";
import { McpSession } from "./mcp-session.js";
import { mcpToolEntries, mcpToolDescription, mcpToolArguments } from "./mcp-catalog.js";
import {ContractError} from '@projectorch/contracts';

export interface SessionToolHostOptions {
  readonly bindingId: string;
  readonly bindingEpoch: number;
  readonly session: SessionRef;
  readonly nativeOwner: NativeSessionLease;
  readonly executable: string;
  readonly bundle?: string;
  readonly identity: NativeIdentity;
  readonly registry: NativeCompatibilityRegistry;
  readonly now: () => number;
  readonly isKernelOwner: () => boolean;
  /** 必须来自官方传输的权威观察；未知时null，不能从模型参数取得。 */
  readonly currentExecutionId: () => string | null;
  /** 受信官方桥接逐调用核验隔离、当前策略和档案；本类不自行证明官方隔离已成立。 */
  readonly assertIsolation: (session: SessionRef, policy: ReturnType<typeof readProjectPolicy>, profile: ReturnType<typeof parsePermissionProfile>) => void;
  readonly ttlMs?: number;
}
function sync<T>(fn: () => T): T {
  const value = fn();
  if (value && typeof (value as { then?: unknown }).then === "function") { void Promise.resolve(value).catch(() => undefined); throw new Error("SYNC_TOOL_HOST_GUARD_REQUIRED"); }
  return value;
}
function time(options: SessionToolHostOptions): number { const now = sync(options.now); if (!Number.isSafeInteger(now) || now < 0) throw new Error("TOOL_HOST_TIME_INVALID"); return now; }
function nativeCurrent(store: Store, options: SessionToolHostOptions): void {
  if (sync(options.isKernelOwner) !== true) throw new Error("TOOL_HOST_OWNER_LOST");
  options.nativeOwner.assertCurrent(options.session);
  const hash = (file: string) => { const stat = statSync(file); if (!stat.isFile() || stat.size > 256 * 1024 * 1024) throw new Error("TOOL_HOST_NATIVE_CHANGED"); return createHash("sha256").update(readFileSync(file)).digest("hex"); };
  if (options.identity.harnessId !== options.session.harnessId || hash(options.executable) !== options.identity.executableSha256 || (options.identity.bundleSha256 === null ? options.bundle !== undefined : !options.bundle || hash(options.bundle) !== options.identity.bundleSha256) || !options.registry.decide(options.identity, "roleTools").enabled) throw new Error("TOOL_HOST_NATIVE_UNVERIFIED");
  const role = store.db.prepare("SELECT r.permission_profile,r.permission_profile_revision FROM role_bindings b JOIN roles r ON r.id=b.role_id AND r.project_id=b.project_id WHERE b.id=? AND b.epoch=? AND b.ended_at IS NULL").get(options.bindingId, options.bindingEpoch);
  const binding = store.db.prepare("SELECT project_id FROM role_bindings WHERE id=?").get(options.bindingId);
  if (!role || !binding) throw new Error("TOOL_HOST_BINDING_INACTIVE");
  const policy = readProjectPolicy(store.db, String(binding.project_id));
  const profile = policy.profiles.find(p => p.id === role.permission_profile && p.revision === role.permission_profile_revision);
  if (!profile) throw new Error("TOOL_HOST_PROFILE_INACTIVE");
  sync(() => options.assertIsolation(options.session, policy, parsePermissionProfile(profile)));
}
function audit(store: Store, principal: AgentPrincipal, id: string, type: string, body: unknown, now: number): void {
  store.db.prepare("INSERT INTO events(id,project_id,type,entity_id,entity_revision,causation_id,body_json,occurred_at) VALUES(?,?,?,?,1,?,?,?)")
    .run(randomUUID(), principal.projectId, type, id, id, canonicalJson(body), now);
}
const safeErrors = new Set(["FORBIDDEN", "AGENT_UNAUTHENTICATED", "CAPABILITY_UNSUPPORTED", "TASK_NOT_FOUND", "TASK_NOT_OWNED", "TASK_REVISION_CONFLICT", "TASK_SPEC_REVISION_CONFLICT", "TASK_EXECUTION_NOT_CURRENT", "TASK_NOT_READY", "TASK_WAIT_UNRESOLVED", "WAIT_UNRESOLVED", "WAIT_DEADLOCK", "PAGE_CURSOR_STALE", "INVALID_PAGE_CURSOR", "STARTUP_REQUIRED", "STARTUP_ROLE_REVISION_MISMATCH", "STARTUP_POLICY_REVISION_MISMATCH", "STARTUP_PLAN_REVISION_MISMATCH", "STARTUP_BINDING_EPOCH_MISMATCH", "RESULT_ATTEMPT_NOT_FOUND", "RESULT_ATTEMPT_NOT_OWNED", "RESULT_OUTPUT_NOT_FOUND", "IDEMPOTENCY_CONFLICT"]);
for (const error of ["AGENT_COMMAND_HISTORY_AMBIGUOUS", "COMMAND_INCOMPLETE", "AGENT_COMMAND_SCOPE_MISSING"]) safeErrors.add(error);
for (const error of ["ARTIFACT_NOT_FOUND", "ARTIFACT_VERSION_CONFLICT", "ARTIFACT_CONTENT_CHANGED", "ARTIFACT_HASH_REQUIRED", "ARTIFACT_READ_LIMIT", "INVALID_ARTIFACT_OFFSET"]) safeErrors.add(error);
// 仅固定码，不回传文件路径、底层错误正文或堆栈；让Agent能纠正项目相对路径。
for (const error of ["ARTIFACT_PATH_MUST_BE_PROJECT_RELATIVE", "ARTIFACT_FILE_MISSING_USE_PROJECT_RELATIVE_PATH", "ARTIFACT_FILE_HASH_OR_SIZE_MISMATCH", "RESULT_OUTPUT_FILE_METADATA_REQUIRED"]) safeErrors.add(error);
const ownerHosts = new WeakMap<NativeSessionLease, SessionToolHost>();

/** 每宿主一个固定主体；不接收正文中的caller/session/role作为来源，不向模型交付原始凭据。 */
export class SessionToolHost {
  readonly id: string;
  readonly #options: SessionToolHostOptions;
  readonly #principal: AgentPrincipal;
  #connection: { readonly epoch: string; readonly executionId: string | null; readonly mcp: McpSession } | null = null;
  #closed = false;
  private constructor(readonly store: Store, options: SessionToolHostOptions, principal: AgentPrincipal, id: string) { this.#options = options; this.#principal = principal; this.id = id; }
  static create(store: Store, input: SessionToolHostOptions): SessionToolHost {
    if (!(input.nativeOwner instanceof NativeSessionLease) || !(input.registry instanceof NativeCompatibilityRegistry)) throw new Error("TOOL_HOST_TRUSTED_COMPONENT_REQUIRED");
    const existing = ownerHosts.get(input.nativeOwner);
    if (existing && !existing.#closed) throw new Error("TOOL_HOST_OWNER_OCCUPIED");
    for (const fn of [input.now, input.isKernelOwner, input.currentExecutionId, input.assertIsolation]) if (typeof fn !== "function" || fn.constructor.name === "AsyncFunction") throw new Error("SYNC_TOOL_HOST_GUARD_REQUIRED");
    const options = Object.freeze({ ...input, session: parseSessionRef(input.session), identity: Object.freeze({ ...input.identity }) });
    const id = randomUUID();
    const principal = store.transaction(() => {
      nativeCurrent(store, options); const now = time(options);
      const issued = issueAgentCredentialWithin(store, options.bindingId, options.bindingEpoch, { isolation: "verified_session", session: options.session }, now, options.ttlMs ?? 3600000);
      const subject = authenticateAgentCredential(store, issued.credential, now);
      audit(store, subject, id, "tool_host.opened", { bindingId: subject.bindingId, bindingEpoch: subject.bindingEpoch, session: subject.session, identity: options.identity }, now);
      return subject;
    });
    const host = new SessionToolHost(store, options, principal, id); ownerHosts.set(options.nativeOwner, host); return host;
  }
  #assert(): void {
    if (this.#closed) throw new Error("TOOL_HOST_CLOSED");
    nativeCurrent(this.store, this.#options); assertAgentPrincipalCurrent(this.store, this.#principal, time(this.#options));
  }
  #execution(): string | null {
    const id = sync(this.#options.currentExecutionId);
    if (id === null) return null;
    if (typeof id !== "string" || !id || id.length > 512 || !this.store.db.prepare("SELECT 1 FROM attempts WHERE project_id=? AND binding_id=? AND binding_epoch=? AND native_execution_id=? AND state IN ('running','waiting_input')").get(this.#principal.projectId, this.#principal.bindingId, this.#principal.bindingEpoch, id)) throw new Error("TOOL_HOST_EXECUTION_UNPROVEN");
    return id;
  }
  #assertConnection(epoch: string, executionId: string | null): void { this.#assert(); if (this.#connection?.epoch !== epoch || this.#execution() !== executionId) throw new Error("TOOL_HOST_CONNECTION_STALE"); }
  /** 只供受信桥接持有。每次连接固定当前执行，换轮必须由观察者重新建立连接。 */
  connect(): McpSession {
    this.#assert(); if (this.#connection && !this.#connection.mcp.closed) throw new Error("TOOL_HOST_CONNECTION_OCCUPIED");
    const epoch = randomUUID(), executionId = this.#execution();
    const allowed = (tool: string): boolean => {
      const action = toolAction(tool); if (!action) return false;
      if (action.kind !== "read" && tool !== "role.startup_ack" && (executionId === null || readProjectPolicy(this.store.db, this.#principal.projectId).nativeMode !== "verified_only")) return false;
      return authorizeAgentAction(this.store, this.#principal, undefined, { ...action, targetProjectId: this.#principal.projectId }, time(this.#options)).allowed;
    };
    const mcp = new McpSession({
      list: () => { this.#assertConnection(epoch, executionId); return mcpToolEntries.filter(entry => allowed(entry.tool)).map(mcpToolDescription); },
      call: (name, args) => {
        this.#assertConnection(epoch, executionId);
        const entry = mcpToolEntries.find(item => item.name === name);
        if (!entry || !allowed(entry.tool)) return { ok: false, payload: { error: "FORBIDDEN" } };
        let input: Record<string, unknown>;
        try { input = mcpToolArguments(entry, args); } catch(error) { return { ok: false, payload: { error: "VALIDATION_ERROR",...(error instanceof ContractError?{issues:error.issues}:{}) } }; }
        const dispatcher = createToolDispatcher(this.store, { now: this.#options.now, callerNativeConversationId: this.#principal.session.nativeConversationId, ...(executionId === null ? {} : { callerNativeExecutionId: executionId }), assertTrustedConnection: () => this.#assertConnection(epoch, executionId) });
        const result = dispatcher(this.#principal, entry.tool, input);
        if (result.ok) return result;
        const error = result.payload && typeof result.payload === "object" && "error" in result.payload ? String(result.payload.error) : "";
        return { ok: false, payload: { error: safeErrors.has(error) ? error : "TOOL_REJECTED" } };
      },
      closed: () => { if (this.#connection?.epoch === epoch) this.#connection = null; },
    });
    this.#connection = { epoch, executionId, mcp }; return mcp;
  }
  /** 只撤销自己颁发的凭据和工具连接，不取消原生执行、不释放原生owner。 */
  close(): void {
    if (this.#closed) return; this.#closed = true; this.#connection?.mcp.close(); this.#connection = null;
    if (ownerHosts.get(this.#options.nativeOwner) === this) ownerHosts.delete(this.#options.nativeOwner);
    if (sync(this.#options.isKernelOwner) !== true) return;
    this.store.transaction(db => {
      const now = time(this.#options);
      db.prepare("UPDATE agent_credentials SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(now, this.#principal.credentialId);
      audit(this.store, this.#principal, this.id, "tool_host.closed", { bindingId: this.#principal.bindingId, bindingEpoch: this.#principal.bindingEpoch }, now);
    });
  }
}

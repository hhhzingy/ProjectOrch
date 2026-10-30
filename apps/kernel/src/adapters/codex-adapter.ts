import {safeExecutionDiagnostic, type ExecutionDiagnostic} from '../native/execution-diagnostics.js';
import {executionTimeout, rpcRequestTimeout, type ExecutionTimeoutOptions} from '../native/execution-timeout.js';
/** Codex受管适配器：同会话owner、逐操作兼容门控、unknown占位和精确终态核验。 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseSessionRef } from "@projectorch/adapter-contract";
import { StdioPeer, NativeRpcError } from "../native/stdio-peer.js";
import { NativeSessionLease } from "../native/session-lease.js";
import type { NativeCapability, NativeCompatibilityRegistry, NativeIdentity } from "../native/compatibility.js";
import type { NativeModelSelection } from '../native/model-selection.js';

export const codexAdapterProtocol = "codex-app-server-jsonl-v2";
export interface CodexAdapterOptions extends ExecutionTimeoutOptions {
  readonly rpcTimeoutMs?: number;
  readonly executable: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** 受信启动器的官方 -c 覆盖；凭据只从env引用，不写用户config.toml。 */
  readonly configOverrides?: readonly string[];
  readonly timeoutMs?: number;
  readonly leaseDirectory?: string;
  readonly hostId?: string;
  readonly profileId?: string;
  readonly compatibility?: { readonly registry: NativeCompatibilityRegistry; readonly identity: NativeIdentity };
}
export interface CodexVersion { readonly version: string; readonly executableSha256: string }
export interface TurnReceipt {
  readonly diagnostics?:ExecutionDiagnostic;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly status: "completed" | "failed" | "interrupted" | "unknown";
  readonly markerSeen: boolean;
  readonly textLength: number;
  /** 助手回复原文（状态机判据不依赖它；仅供持久回执"回复可查"）。 */
  readonly text: string;
}
export interface HistoryReceipt { readonly threadId: string; readonly turns: readonly unknown[] }
type Params = Record<string, unknown>;
type Phase = "disconnected" | "connecting" | "idle" | "running" | "unknown" | "closed";
type Terminal = "completed" | "failed" | "interrupted";
interface ActiveTurn {
  diagnosticCode?:string;
  turnId: string | null;
  status: Terminal | "unknown";
  text: string;
  buffered: { method: string; params: Params }[];
  bufferedBytes: number;
  settle: (() => void) | null;
}
const asRecord = (v: unknown): Params => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Params : {};
const token = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;
const terminal = (v: unknown): v is Terminal => v === "completed" || v === "failed" || v === "interrupted";

export class CodexAdapter {
  readonly #options: CodexAdapterOptions;
  #peer: StdioPeer | null = null;
  #threadId: string | null = null;
  #lease: NativeSessionLease | null = null;
  #phase: Phase = "disconnected";
  #active: ActiveTurn | null = null;
  constructor(options: CodexAdapterOptions) {
    if (typeof options.executable !== "string" || !options.executable) throw new Error("ADAPTER_EXECUTABLE_REQUIRED");
    if (typeof options.cwd !== "string" || !options.cwd) throw new Error("ADAPTER_CWD_REQUIRED");
    executionTimeout(options, "INVALID_ADAPTER_TIMEOUT");
    rpcRequestTimeout(options.rpcTimeoutMs);
    this.#options = Object.freeze({ ...options, env: Object.freeze({ ...options.env }), ...(options.compatibility ? { compatibility: Object.freeze({ registry: options.compatibility.registry, identity: Object.freeze({ ...options.compatibility.identity }) }) } : {}) });
  }
  get connected(): boolean { return this.#peer !== null && !this.#peer.diagnostics.closed; }
  get threadId(): string | null { return this.#threadId; }
  get phase(): Phase { return this.#phase; }
  get execution(): Readonly<{ threadId: string | null; turnId: string | null; phase: Phase }> { return Object.freeze({ threadId: this.#threadId, turnId: this.#active?.turnId ?? null, phase: this.#phase }); }
  detectVersion(): CodexVersion {
    const version = execFileSync(this.#options.executable, ["--version"], { cwd: this.#options.cwd, env: this.#options.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000, maxBuffer: 65536, windowsHide: true }).trim();
    if (!version || version.length > 128) throw new Error("CODEX_VERSION_FAILED");
    return { version, executableSha256: createHash("sha256").update(readFileSync(this.#options.executable)).digest("hex") };
  }
  #assertCapability(capability: NativeCapability): void {
    const c = this.#options.compatibility;
    if (!c) throw new Error("NATIVE_COMPATIBILITY_PROBE_REQUIRED");
    if (c.identity.harnessId !== "codex" || c.identity.route !== "official_rpc" || c.identity.adapterProtocol !== codexAdapterProtocol || c.identity.bundleSha256 !== null) throw new Error("UNSUPPORTED_NATIVE_ADAPTER_ROUTE");
    const installed = { ...c.identity, executableSha256: createHash("sha256").update(readFileSync(this.#options.executable)).digest("hex") };
    if (installed.executableSha256 !== c.identity.executableSha256) throw new Error("NATIVE_RUNTIME_CHANGED_RESTART_REQUIRED");
    const decision = c.registry.decide(installed, capability);
    if (!decision.enabled) throw new Error(decision.state === "unsupported" ? "NATIVE_CAPABILITY_UNSUPPORTED" : "NATIVE_COMPATIBILITY_PROBE_REQUIRED");
  }
  #scope(threadId: string) {
    if (!this.#options.leaseDirectory || !this.#options.hostId || !this.#options.profileId) throw new Error("ADAPTER_OWNER_SCOPE_REQUIRED");
    return parseSessionRef({ harnessId: "codex", hostId: this.#options.hostId, profileId: this.#options.profileId, nativeConversationId: threadId });
  }
  #requirePeer(): StdioPeer {
    if (!this.#peer || this.#peer.diagnostics.closed || !this.#threadId) throw new Error("ADAPTER_NOT_CONNECTED");
    return this.#peer;
  }
  #markUnknown(code = "NATIVE_EXECUTION_UNCERTAIN"): void {
    if(this.#active)this.#active.diagnosticCode??=code;
    this.#phase = "unknown";
    this.#active?.settle?.();
  }
  #notification(method: string, params: Params): void {
    const active = this.#active;
    if (!active || params.threadId !== this.#threadId || !["turn/started", "turn/completed", "item/agentMessage/delta"].includes(method)) return;
    if (!active.turnId) {
      active.bufferedBytes += Buffer.byteLength(JSON.stringify(params));
      if (active.buffered.length >= 128 || active.bufferedBytes > 4 * 1024 * 1024) { this.#markUnknown(); return; }
      active.buffered.push({ method, params });
      return;
    }
    if (method === "item/agentMessage/delta") {
      if (params.turnId !== active.turnId || typeof params.delta !== "string") return;
      if (active.text.length + params.delta.length > 4 * 1024 * 1024) { this.#markUnknown(); return; }
      active.text += params.delta;
    }
    if (method === "turn/completed") {
      const turn = asRecord(params.turn);
      if (turn.id !== active.turnId) return;
      if (!terminal(turn.status)) { this.#markUnknown(); return; }
      // 官方app-server TurnError使用camelCase枚举；不解析message或JSONL日志的私有形状。
      if(turn.status==='failed'&&asRecord(turn.error).codexErrorInfo==='usageLimitExceeded')active.diagnosticCode='CODEX_USAGE_LIMIT_EXCEEDED';
      active.status = turn.status;
      active.settle?.();
    }
  }
  async #connect(): Promise<StdioPeer> {
    // 官方CLI参数集随版本演进：0.130+的`app-server`默认stdio（不再接受--stdio）；旧版需要显式--stdio。
    // 版本取自现场探测的compatibility.identity（R043逐次重核——版本漂移自动切换参数集）。
    const versionMatch = /(\d+)\.(\d+)/.exec(this.#options.compatibility?.identity.version ?? "");
    const minor = versionMatch ? Number(versionMatch[1]) * 1000 + Number(versionMatch[2]) : 0;
    const args = [...(this.#options.configOverrides ?? []).flatMap(value => ['-c', value]), ...(minor >= 130 ? ["app-server"] : ["app-server", "--stdio"])];
    const peer = new StdioPeer({ executable: this.#options.executable, args, cwd: this.#options.cwd, env: this.#options.env, timeoutMs: rpcRequestTimeout(this.#options.rpcTimeoutMs), onNotification: (m, p) => this.#notification(m, asRecord(p)) });
    this.#peer = peer;
    void peer.exited.then(() => { if (this.#phase === "running") this.#markUnknown(); });
    await peer.ready;
    await peer.request("initialize", { clientInfo: { name: "projectorch_adapter", version: "2.0.0" } });
    await peer.notify("initialized", {});
    return peer;
  }
  async #open(threadId: string | null, createArgs: Params = {}, assertCanSend?:()=>void): Promise<{ readonly threadId: string }> {
    if (this.#phase !== "disconnected") throw new Error("ADAPTER_OWNER_NOT_IDLE");
    this.#assertCapability(threadId ? "resume" : "textInput");
    this.#scope(threadId ?? "pending-create");
    NativeSessionLease.assertDirectory(this.#options.leaseDirectory as string);
    this.#phase = "connecting";
    try {
      if (threadId) this.#lease = NativeSessionLease.acquire(this.#options.leaseDirectory as string, this.#scope(threadId));
      const peer = await this.#connect();
      const response = asRecord(await peer.request(threadId ? "thread/resume" : "thread/start", threadId ? { threadId, excludeTurns: false } : { cwd: this.#options.cwd, ephemeral: false, sandbox: "read-only", approvalPolicy: "never", ...createArgs },assertCanSend));
      const thread = asRecord(response.thread);
      if (!token(thread.id) || (threadId !== null && thread.id !== threadId)) throw new Error("RESUME_ID_MISMATCH");
      this.#threadId = thread.id;
      this.#lease ??= NativeSessionLease.acquire(this.#options.leaseDirectory as string, this.#scope(thread.id));
      if (threadId) {
        const turns = thread.turns;
        const idle = asRecord(thread.status).type === "idle";
        if ((thread.status !== undefined && !idle) || (!Array.isArray(turns) && !idle) || (Array.isArray(turns) && turns.some(t => !terminal(asRecord(t).status)))) throw new Error("RESUME_EXECUTION_UNPROVEN");
      }
      this.#phase = "idle";
      return { threadId: thread.id };
    } catch (error) {
      this.#phase = this.#peer || this.#lease ? "unknown" : "disconnected";
      if (this.#peer) await this.#peer.close().catch(() => undefined);
      // 已取得的owner不因连接异常自行释放；原生状态仍待核对。
      throw error;
    }
  }
  startThread(createArgs: Params = {},assertCanSend?:()=>void): Promise<{ readonly threadId: string }> { return this.#open(null, createArgs,assertCanSend); }
  resumeThread(threadId: string): Promise<{ readonly threadId: string }> {
    if (!token(threadId)) return Promise.reject(new Error("INVALID_THREAD_ID"));
    return this.#open(threadId);
  }
  async runTurn(input: string, marker: string, timeoutMs = executionTimeout(this.#options), onTurnStarted?: (turnId: string) => void, assertCanSend?: () => void, selection?:NativeModelSelection): Promise<TurnReceipt> {
    const peer = this.#requirePeer();
    if (this.#phase !== "idle") throw new Error("ADAPTER_OWNER_NOT_IDLE");
    if (typeof input !== "string" || !input.trim() || Buffer.byteLength(input) > 65536 || typeof marker !== "string" || marker.length > 65536) throw new Error("INVALID_TURN_INPUT");
    executionTimeout({timeoutMs}, "INVALID_TURN_INPUT");
    this.#assertCapability("textInput");
    const startedAt=Date.now();
    const active: ActiveTurn = { turnId: null, status: "unknown", text: "", buffered: [], bufferedBytes: 0, settle: null };
    this.#active = active;
    this.#phase = "running";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = new Promise<void>(resolve => { active.settle = resolve; timer = setTimeout(() => { this.#markUnknown("EXECUTION_DEADLINE_REACHED"); }, timeoutMs); });
    let boundaryError: unknown = null;
    try {
      const start = peer.request("turn/start", { threadId: this.#threadId, input: [{ type: "text", text: input }],...(selection?.modelId?{model:selection.modelId}:{}),...(selection?.reasoningLevel?{effort:selection.reasoningLevel}:{}) }, () => { try { assertCanSend?.(); } catch (error) { boundaryError=error;throw error; } }).then(raw => {
        const started = asRecord(raw);
        const turn = asRecord(started.turn);
        if (!token(turn.id) || (started.threadId !== undefined && started.threadId !== this.#threadId)) throw new Error("TURN_ID_NOT_PROVEN");
        active.turnId = turn.id;
        onTurnStarted?.(turn.id);
        const buffered = active.buffered.splice(0);
        for (const frame of buffered) this.#notification(frame.method, frame.params);
      });
      // 等待启动回执也受本轮deadline约束；迟到回执只补身份，不触发重发或自行解锁。
      await Promise.race([start, done.then(() => { if (!active.turnId) throw new NativeRpcError("TURN_START_UNCERTAIN", "uncertain"); })]);
      await done;
    } catch (error) {
      if (boundaryError) { this.#active=null;this.#phase='idle';throw boundaryError; }
      if (error instanceof NativeRpcError && (error.delivery === "not_sent" || error.delivery === "rejected") && this.phase !== "unknown") active.status = "failed";
      else this.#markUnknown();
    } finally { clearTimeout(timer); active.settle = null; }
    const status = this.phase === "unknown" ? "unknown" : active.status;
    if (status !== "unknown") { this.#active = null; this.#phase = "idle"; }
    else this.#phase = "unknown";
    return Object.freeze({ threadId: this.#threadId as string, turnId: active.turnId, status, markerSeen: marker === "" || active.text.includes(marker), textLength: active.text.length, text: active.text, ...(status==='unknown'||active.diagnosticCode!==undefined?{diagnostics:safeExecutionDiagnostic({code:active.diagnosticCode,elapsedMs:Date.now()-startedAt})}:{}) });
  }
  async readHistory(): Promise<HistoryReceipt> {
    const peer = this.#requirePeer();
    this.#assertCapability("historyRead");
    const response = asRecord(await peer.request("thread/read", { threadId: this.#threadId, includeTurns: true }));
    const thread = asRecord(response.thread);
    if (thread.id !== this.#threadId || !Array.isArray(thread.turns)) { this.#markUnknown(); throw new Error("HISTORY_TARGET_UNPROVEN"); }
    return { threadId: this.#threadId as string, turns: thread.turns };
  }
  /** unknown只能由同线程同turn的原生历史终态解锁，关闭传输或RPC取消确认不算终态。 */
  async reconcileTurn(): Promise<TurnReceipt> {
    if (this.#phase !== "unknown" || !this.#active?.turnId) throw new Error("EXECUTION_RECONCILIATION_REQUIRED");
    const active = this.#active;
    const history = await this.readHistory();
    const matches = history.turns.filter(t => asRecord(t).id === active.turnId);
    const turn = asRecord(matches[0]);
    if (matches.length !== 1 || !terminal(turn.status)) throw new Error("EXECUTION_TERMINAL_NOT_PROVEN");
    this.#active = null; this.#phase = "idle";
    return { threadId: history.threadId, turnId: active.turnId, status: turn.status, markerSeen: false, textLength: active.text.length, text: active.text };
  }
  /** 本实例核对精确终态并关闭自己持有的传输，再释放自己的租约；不能接管其他活owner。 */
  async recoverOwnedTerminal(turnId: string): Promise<Terminal> {
    const peer=this.#requirePeer();this.#assertCapability('historyRead');
    if(!token(turnId)||!['unknown','idle'].includes(this.#phase)||(this.#active&&this.#active.turnId!==turnId))throw new Error('EXECUTION_RECONCILIATION_REQUIRED');
    const thread=asRecord(asRecord(await peer.request('thread/read',{threadId:this.#threadId,includeTurns:true})).thread);
    const turns=thread.turns;
    if(thread.id!==this.#threadId||asRecord(thread.status).type!=='idle'||!Array.isArray(turns)||turns.some(t=>!terminal(asRecord(t).status)))throw new Error('EXECUTION_TERMINAL_NOT_PROVEN');
    const matches=turns.filter(t=>asRecord(t).id===turnId),status=asRecord(matches[0]).status;
    if(matches.length!==1||!terminal(status))throw new Error('EXECUTION_TERMINAL_NOT_PROVEN');
    this.#lease?.assertCurrent(this.#scope(thread.id as string));
    await peer.close();
    if(!peer.diagnostics.exitConfirmed)throw new Error('LEASE_PROCESS_EXIT_UNCONFIRMED');
    this.#lease?.releaseAfterExit(true);this.#lease=null;this.#peer=null;this.#active=null;this.#phase='closed';
    return status;
  }
  async interrupt(turnId: string): Promise<"requested" | "rejected"> {
    const peer = this.#requirePeer(); this.#assertCapability("nativeCancel");
    if (this.#phase !== "running" || this.#active?.turnId !== turnId) return "rejected";
    try { await peer.request("turn/interrupt", { threadId: this.#threadId, turnId }); return "requested"; }
    catch (error) { if (error instanceof NativeRpcError && error.delivery === "rejected") return "rejected"; this.#markUnknown(); throw error; }
  }
  async steer(turnId: string, input: string): Promise<"accepted" | "rejected"> {
    const peer = this.#requirePeer(); this.#assertCapability("guide");
    if (this.#phase !== "running" || this.#active?.turnId !== turnId) return "rejected";
    if (typeof input !== "string" || !input.trim() || Buffer.byteLength(input) > 65536) throw new Error("INVALID_TURN_INPUT");
    try {
      const response = asRecord(await peer.request("turn/steer", { threadId: this.#threadId, expectedTurnId: turnId, input: [{ type: "text", text: input }] }));
      if (response.turnId !== undefined && response.turnId !== turnId) throw new Error("STEER_TARGET_MISMATCH");
      return "accepted";
    } catch (error) { if (error instanceof NativeRpcError && error.delivery === "rejected") return "rejected"; this.#markUnknown(); throw error; }
  }
  async callIdentityTool(server: string, args: Params = {}): Promise<Record<string, unknown>> {
    const peer = this.#requirePeer(); this.#assertCapability("roleTools");
    const response = asRecord(await peer.request("mcpServer/tool/call", { server, threadId: this.#threadId, tool: "identity", arguments: args }));
    const content = Array.isArray(response.content) ? response.content : [];
    const first = asRecord(content[0]);
    if (response.isError === true || typeof first.text !== "string") throw new Error("IDENTITY_RESULT_NOT_PROVEN");
    const parsed: unknown = JSON.parse(first.text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("IDENTITY_RESULT_NOT_PROVEN");
    return parsed as Params;
  }
  historyAsNativeItems(turns: readonly unknown[], threadId: string): readonly { readonly itemId: string; readonly revision: string; readonly occurredAt: number; readonly kind: string; readonly content: unknown }[] {
    if (!this.#threadId || threadId !== this.#threadId) throw new Error("HISTORY_TARGET_UNPROVEN");
    const seen = new Set<string>();
    return turns.map(turn => {
      const record = asRecord(turn);
      if (!token(record.id) || seen.has(record.id)) throw new Error("HISTORY_ITEM_ID_UNPROVEN");
      seen.add(record.id);
      return { itemId: `${threadId}:${record.id}`, revision: createHash("sha256").update(JSON.stringify(record)).digest("hex"), occurredAt: typeof record.occurredAt === "number" ? record.occurredAt : 0, kind: "turn", content: record };
    });
  }
  async close(): Promise<void> {
    if (this.#phase === "closed") return;
    if (this.#phase === "running" || this.#phase === "connecting") this.#markUnknown();
    if (this.#peer) { await this.#peer.close(); this.#peer = null; }
    if (this.#phase === "unknown") return; // 保留磁盘占位，不允许新实例绕过未知执行。
    this.#lease?.releaseAfterExit(true); this.#lease = null; this.#phase = "closed";
  }
}

import {safeExecutionDiagnostic,type ExecutionDiagnostic} from '../native/execution-diagnostics.js';
import {executionTimeout, type ExecutionTimeoutOptions} from '../native/execution-timeout.js';
import {NativeRpcError} from '../native/stdio-peer.js';
/** T112（PR2-W2）：Codex 线程工厂——复用既有 CodexAdapter（startThread/runTurn/readHistory），不另写较弱驱动。
 * 持久分步操作（同ZcodeSessionFactory模式）：onStep边界（sent→observed/unknown/failed）、幂等、unknown不盲重试。
 * 章程=线程首输入（runTurn）；线程ID为官方观察值；受信环境由适配器选项承载（leaseDirectory/compatibility既有合同）。 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { SessionRef } from "@projectorch/adapter-contract";
import { NativeCompatibilityRegistry, type NativeIdentity } from "../native/compatibility.js";
import { NativeSessionLease } from "../native/session-lease.js";

export interface CodexThreadFactoryOptions extends ExecutionTimeoutOptions {
  readonly executable: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly leaseDirectory: string;
  readonly registry: NativeCompatibilityRegistry;
  readonly timeoutMs?: number;
}

/** R043现场探针：codex --version + 二进制哈希。 */
export function detectCodexIdentity(executable: string): { readonly version: string; readonly executableSha256: string } {
  const out = execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 30_000, windowsHide: true, ...(process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(executable) ? { shell: true } : {}) }).trim();
  if (!out) throw new Error("CODEX_VERSION_FAILED");
  return { version: out, executableSha256: createHash("sha256").update(readFileSync(executable)).digest("hex") };
}

export interface CodexFactoryStep { readonly step: "create-thread" | "deliver-charter"; readonly state: "sent" | "observed" | "unknown" | "failed"; readonly detail: string | null; readonly at: number }

/** 线程工厂产物（官方观察的threadId+turn回执摘要）。 */
export interface CodexFactoryOutcome {
  readonly nativeThreadId: string;
  readonly nativeTurnId: string|null;
  readonly charterMarkerSeen: boolean;
  readonly sessionRef: SessionRef;
}

export class CodexThreadFactory {
  readonly #options: CodexThreadFactoryOptions;

  constructor(options: CodexThreadFactoryOptions) {
    if (!options.executable || !options.cwd || !options.env || !options.leaseDirectory) throw new Error("INVALID_FACTORY_OPTIONS");
    if (!(options.registry instanceof NativeCompatibilityRegistry)) throw new Error("TRUSTED_REGISTRY_REQUIRED");
    executionTimeout(options);
    this.#options = options;
  }

  identity(): NativeIdentity {
    // DR07：逐操作现场重核（构造时缓存的身份在版本更新后失效——R043）
    return this.#detect();
  }
  #detect(): NativeIdentity {
    const detected = detectCodexIdentity(this.#options.executable);
    return Object.freeze({ harnessId: "codex", version: detected.version, executableSha256: detected.executableSha256, bundleSha256: null, adapterProtocol: "codex-app-server-jsonl-v2", route: "official_rpc" });
  }

  assertCapabilities(): void {
    const identity = this.#detect();
    for (const capability of ["textInput", "resume", "historyRead"] as const) {
      if (!this.#options.registry.decide(identity, capability).enabled) throw new NativeRpcError(`NATIVE_CAPABILITY_UNVERIFIED:${capability}`,"not_sent");
    }
  }

  /**
   * 创建线程并下发章程（持久分步：调用方经onStep在每步边界持久化）。
   * adapter由调用方传入（复用其StdioPeer/租约/兼容合同——本工厂只编排，不重建传输）。
   * DR07：runTurn回执的threadId与startThread不符、status非completed、或marker未观察→如实failed/unknown，不产出成功observed。
   */
  async createThreadWithCharter(input: {
    readonly adapter: { startThread(args?: unknown,guard?:()=>void): Promise<{ readonly threadId: string }>; runTurn(text: string, marker: string, timeoutMs?: number,onStarted?:undefined,guard?:()=>void): Promise<{ readonly threadId: string; readonly turnId?:string|null; readonly markerSeen: boolean; readonly status: string;readonly diagnostics?:ExecutionDiagnostic }> ; close(): Promise<void> | void };
    readonly assertCanSend?:()=>void;
    readonly charter: string;
    readonly marker: string;
    readonly hostId: string;
    readonly profileId: string;
    readonly onStep: (step: CodexFactoryStep) => void;
  }): Promise<CodexFactoryOutcome> {
    this.assertCapabilities();
    let creationObserved=false;
    try {
      input.assertCanSend?.();
      input.onStep({ step: "create-thread", state: "sent", detail: null, at: Date.now() });
      const { threadId } = await input.adapter.startThread({},input.assertCanSend);
      input.onStep({ step: "create-thread", state: "observed", detail: threadId, at: Date.now() });
      creationObserved=true;
      input.onStep({ step: "deliver-charter", state: "sent", detail: null, at: Date.now() });
      input.assertCanSend?.();
      const turn = await input.adapter.runTurn(input.charter, input.marker, executionTimeout(this.#options),undefined,input.assertCanSend);
      // DR07：错线程/失败状态/无marker→如实判定，不把错误结果标observed
      if (turn.threadId !== threadId) {
        input.onStep({ step: "deliver-charter", state: "failed", detail: `THREAD_MISMATCH:${turn.threadId}!=${threadId}`, at: Date.now() });
        throw new Error(`FACTORY_THREAD_MISMATCH:${turn.threadId}!=${threadId}`);
      }
      if (turn.status === "failed" || turn.status === "interrupted") {
        const diagnostic=safeExecutionDiagnostic(turn.diagnostics);
        input.onStep({ step: "deliver-charter", state: "failed", detail: turn.status==='failed'&&diagnostic.code==='CODEX_USAGE_LIMIT_EXCEEDED'?JSON.stringify(diagnostic):`TURN_${turn.status.toUpperCase()}`, at: Date.now() });
        throw new Error(`FACTORY_TURN_${turn.status.toUpperCase()}`);
      }
      if (turn.status !== "completed") {
        input.onStep({ step: "deliver-charter", state: "unknown", detail: JSON.stringify(safeExecutionDiagnostic(turn.diagnostics)), at: Date.now() });
        throw new Error(`FACTORY_TURN_UNKNOWN:${turn.status}`);
      }
      if (!turn.markerSeen) {
        input.onStep({ step: "deliver-charter", state: "failed", detail: "MARKER_NOT_OBSERVED", at: Date.now() });
        throw new Error("FACTORY_MARKER_NOT_OBSERVED");
      }
      input.onStep({ step: "deliver-charter", state: "observed", detail: turn.threadId, at: Date.now() });
      // 租约由CodexAdapter在#open内持有（同会话单owner）；工厂不重复acquire（重复会NATIVE_OWNER_OCCUPIED）。
      const sessionRef: SessionRef = { harnessId: "codex", hostId: input.hostId, profileId: input.profileId, nativeConversationId: threadId };
      return { nativeThreadId: threadId, nativeTurnId:turn.turnId??null, charterMarkerSeen: true, sessionRef };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("FACTORY_")) throw error;
      const state = /TIMEOUT|UNKNOWN|UNCONFIRMED/u.test(message) ? "unknown" : "failed";
      input.onStep({ step: creationObserved?'deliver-charter':'create-thread', state, detail: message.slice(0, 200), at: Date.now() });
      throw error;
    }
  }
}

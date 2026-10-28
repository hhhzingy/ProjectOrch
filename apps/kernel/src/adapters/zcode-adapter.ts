import {executionTimeout, type ExecutionTimeoutOptions} from '../native/execution-timeout.js';
/** ZCode生产入口：复用已核验的纯文本owner，不改变官方程序。角色工具传输仍需独立接线验收。 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseSessionRef, type SessionRef } from "@projectorch/adapter-contract";
import type { NativeCompatibilityRegistry, NativeIdentity } from "../native/compatibility.js";
import { VerifiedZCodeTextSession } from "../native/verified-zcode-session.js";

export interface ZcodeAdapterOptions extends ExecutionTimeoutOptions {
  readonly executable: string;
  readonly bundle: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /** 所有生产owner共用固定目录；探测版本不取得owner。 */
  readonly leaseDirectory?: string;
  readonly compatibility?: { readonly registry: NativeCompatibilityRegistry; readonly identity: NativeIdentity };
}
export interface ZcodeVersion { readonly version: string; readonly bundleSha256: string }
export interface ZcodeTurnReceipt {
  readonly session: SessionRef;
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly status: "completed" | "failed" | "unknown";
  readonly markerSeen: boolean;
  readonly responseLength: number;
  readonly pid: number | null;
  readonly exitConfirmed: boolean;
  readonly failureCode?: string;
}
export class ZcodeAdapter {
  readonly #options: ZcodeAdapterOptions;
  readonly #session: SessionRef;
  #owner: VerifiedZCodeTextSession | null = null;
  #closed = false;
  constructor(options: ZcodeAdapterOptions, session: SessionRef) {
    if (typeof options.executable !== "string" || !options.executable) throw new Error("ADAPTER_EXECUTABLE_REQUIRED");
    if (typeof options.bundle !== "string" || !options.bundle) throw new Error("ADAPTER_BUNDLE_REQUIRED");
    if (typeof options.cwd !== "string" || !options.cwd) throw new Error("ADAPTER_CWD_REQUIRED");
    executionTimeout(options, "INVALID_CLI_TIMEOUT");
    this.#options = Object.freeze({ ...options, env: Object.freeze({ ...options.env }), ...(options.compatibility ? { compatibility: Object.freeze({ registry: options.compatibility.registry, identity: Object.freeze({ ...options.compatibility.identity }) }) } : {}) });
    this.#session = parseSessionRef(session);
    if (this.#session.harnessId !== "zcode") throw new Error("ZCODE_SESSION_REQUIRED");
  }
  get session(): SessionRef { return this.#session; }
  get phase(): "closed" | "idle" | "running" | "unknown" { return this.#closed ? "closed" : this.#owner?.phase ?? "idle"; }
  detectVersion(): ZcodeVersion {
    const version = execFileSync(this.#options.executable, [this.#options.bundle, "--version"], { cwd: this.#options.cwd, env: this.#options.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true }).trim();
    if (!version || version.length > 128) throw new Error("ZCODE_VERSION_FAILED");
    return { version, bundleSha256: createHash("sha256").update(readFileSync(this.#options.bundle)).digest("hex") };
  }
  async runTurn(input: string, marker: string, timeoutMs = executionTimeout(this.#options, "INVALID_CLI_TIMEOUT")): Promise<ZcodeTurnReceipt> {
    if (this.#closed) throw new Error("SESSION_OWNER_CLOSED");
    if (this.phase !== "idle") throw new Error("CLI_OWNER_NOT_IDLE");
    if (typeof marker !== "string" || marker.length > 65536) throw new Error("INVALID_CLI_MARKER");
    executionTimeout({timeoutMs}, "INVALID_CLI_TIMEOUT");
    const { compatibility, leaseDirectory } = this.#options;
    if (!compatibility) throw new Error("NATIVE_COMPATIBILITY_PROBE_REQUIRED");
    if (!leaseDirectory) throw new Error("LOCAL_LEASE_DIRECTORY_REQUIRED");
    this.#owner ??= new VerifiedZCodeTextSession(leaseDirectory, this.#session, this.#options, compatibility.registry, compatibility.identity);
    try {
      const receipt = await this.#owner.execute(input, timeoutMs);
      return Object.freeze({ session: this.#session, sessionId: receipt.result.sessionId, turnId: receipt.result.turnId, status: "completed", markerSeen: marker === "" || receipt.result.response.includes(marker), responseLength: receipt.result.response.length, pid: receipt.pid, exitConfirmed: true });
    } catch (error) {
      // 只有runner确认未spawn才可报告failed；可能执行过的异常保留unknown和owner占位。
      if (this.#owner.phase !== "unknown" && (error as Error).message !== "CLI_SPAWN_NOT_SENT") throw error;
      const observer = this.#owner.attachObserver();
      const snapshot = observer.read().process;
      observer.detach();
      return Object.freeze({ session: this.#session, sessionId: this.#session.nativeConversationId, turnId: snapshot.nativeTurnId, status: this.#owner.phase === "unknown" ? "unknown" : "failed", markerSeen: false, responseLength: 0, pid: snapshot.pid, exitConfirmed: snapshot.exitConfirmed, failureCode: (error as Error).message });
    }
  }
  close(): void {
    if (this.#closed) return;
    this.#owner?.close();
    this.#closed = true;
  }
}

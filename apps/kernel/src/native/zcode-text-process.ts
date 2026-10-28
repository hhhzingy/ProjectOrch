import {executionTimeout, type ExecutionTimeoutOptions} from './execution-timeout.js';
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { ZCodeCliResultCollector, ZCodeCliResultError, zcodeTextOnlyArgs, type ZCodeCliResult } from "./zcode-cli-result.js";

export interface ZCodeTextProcessOptions extends ExecutionTimeoutOptions {
  readonly executable: string;
  readonly bundle: string;
  readonly cwd: string;
  /** 受信启动器白名单；不默认继承宿主认证环境。 */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}
export interface ZCodeTextProcessReceipt {
  readonly result: ZCodeCliResult;
  readonly pid: number;
  readonly exitConfirmed: true;
  readonly stderrBytes: number;
  readonly processEpoch: string;
}
export interface ZCodeProcessSnapshot {
  readonly phase: "idle" | "running" | "unknown";
  readonly processEpoch: string | null;
  readonly pid: number | null;
  readonly stdoutBytes: number;
  readonly frames: number;
  readonly lastType: string | null;
  readonly exitConfirmed: boolean;
  readonly nativeTurnId: string | null;
  readonly turnStartedSeen: boolean;
}
export interface OwnedProcessTermination {
  readonly status: "stale_target" | "not_running" | "termination_requested";
  readonly processEpoch: string;
}

/** 纯文本CLI执行切片，不是Supervisor。unknown后实例永久停止准入，需上层原生核对。 */
/** CLI stderr 脱敏摘要：单行、≤120字符、白名单字符；敏感词整条丢弃（负例：tests adapters stdio）。 */
function sanitizeCliStderr(text: string): string | null {
  if (typeof text !== "string" || !text) return null;
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  // 诊断优先：HTTP状态/失败类行（如429限流）优先于末行；仍单行且过敏感词闸
  const pick = lines.find(l => /\b(?:429|5\d{2})\b|failed|error|rate|limit/i.test(l)) ?? lines.at(-1) ?? "";
  if (/secret|token|password|authorization|bearer|api[-_ ]?key/i.test(pick)) return null;
  const allowed = pick.replace(/[^\p{L}\p{N} .:_/-]/gu, "").trim();
  return allowed ? allowed.slice(0, 120) : null;
}

export class ZCodeTextProcess {
  #phase: "idle" | "running" | "unknown" = "idle";
  readonly #options: ZCodeTextProcessOptions;
  #terminateActive: (() => void) | null = null;
  #telemetry = { processEpoch: null as string | null, pid: null as number | null, stdoutBytes: 0, frames: 0, lastType: null as string | null, exitConfirmed: true, nativeTurnId: null as string | null, turnStartedSeen: false };
  constructor(options: ZCodeTextProcessOptions) {
    const timeout = executionTimeout(options, "INVALID_CLI_TIMEOUT");
    this.#options = Object.freeze({ ...options, env: Object.freeze({ ...options.env }), timeoutMs: timeout });
  }
  get phase(): "idle" | "running" | "unknown" { return this.#phase; }
  get snapshot(): ZCodeProcessSnapshot { return Object.freeze({ ...this.#telemetry, phase: this.#phase }); }
  /** 仅终止本实例所拥有的精确进程代次；不等同于原生turn取消确认。 */
  requestOwnedProcessTermination(expectedProcessEpoch: string): OwnedProcessTermination {
    if (typeof expectedProcessEpoch !== "string" || !expectedProcessEpoch || expectedProcessEpoch.length > 128) throw new Error("INVALID_PROCESS_TARGET");
    if (expectedProcessEpoch !== this.#telemetry.processEpoch) return Object.freeze({ status: "stale_target", processEpoch: expectedProcessEpoch });
    if (this.#phase !== "running" || !this.#terminateActive) return Object.freeze({ status: "not_running", processEpoch: expectedProcessEpoch });
    this.#terminateActive();
    return Object.freeze({ status: "termination_requested", processEpoch: expectedProcessEpoch });
  }
  async execute(text: string, sessionId: string | null, timeoutMs = executionTimeout(this.#options, "INVALID_CLI_TIMEOUT"), onTurnStarted?: (sessionId: string, turnId: string) => void): Promise<ZCodeTextProcessReceipt> {
    if (this.#phase !== "idle") throw new Error("CLI_OWNER_NOT_IDLE");
    executionTimeout({timeoutMs}, "INVALID_CLI_TIMEOUT");
    const args = zcodeTextOnlyArgs(this.#options.bundle, text, sessionId);
    const collector = new ZCodeCliResultCollector(sessionId, undefined, (nativeSessionId, nativeTurnId) => { this.#telemetry.nativeTurnId = nativeTurnId; onTurnStarted?.(nativeSessionId, nativeTurnId); });
    const processEpoch = randomUUID();
    this.#telemetry = { processEpoch, pid: null, stdoutBytes: 0, frames: 0, lastType: null, exitConfirmed: false, nativeTurnId: null, turnStartedSeen: false };
    this.#phase = "running";
    return new Promise((resolve, reject) => {
      let child: ChildProcessByStdio<null, Readable, Readable>;
      try { child = spawn(this.#options.executable, [...args], { cwd: this.#options.cwd, env: this.#options.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
      catch { this.#phase = "idle"; this.#telemetry.exitConfirmed = true; reject(new Error("CLI_SPAWN_NOT_SENT")); return; }
      let fault: string | null = null; let stderrBytes = 0; let spawned = false; let settled = false; let stderrTail = "";
      let exitTimer: ReturnType<typeof setTimeout> | undefined;
      const fail = (code: string) => {
        fault ??= code;
        child.kill();
        exitTimer ??= setTimeout(() => {
          if (settled) return;
          settled = true; this.#phase = "unknown"; clearTimeout(timer);
          reject(new ZCodeCliResultError("CLI_CHILD_EXIT_UNCONFIRMED"));
        }, 5000);
      };
      this.#terminateActive = () => fail("CLI_TERMINATED_UNCERTAIN");
      const timer = setTimeout(() => fail("CLI_TIMEOUT"), timeoutMs);
      child.once("spawn", () => { spawned = true; this.#telemetry.pid = child.pid ?? null; });
      child.once("error", () => { fault ??= "CLI_SPAWN_FAILED"; });
      child.stderr.on("data", (bytes: Buffer) => { stderrBytes += bytes.length; stderrTail = (stderrTail + bytes.toString("utf8")).slice(-600); });
      child.stdout.on("data", (bytes: Buffer) => {
        if (fault) return;
        this.#telemetry.stdoutBytes += bytes.length;
        try { collector.push(bytes); Object.assign(this.#telemetry, collector.activity); } catch (error) { fail(error instanceof ZCodeCliResultError ? error.code : "CLI_OUTPUT_FAILED"); }
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer); clearTimeout(exitTimer);
        this.#terminateActive = null;
        if (settled) return;
        settled = true;
        this.#telemetry.exitConfirmed = true;
        if (!spawned) { this.#phase = "idle"; reject(new Error("CLI_SPAWN_NOT_SENT")); return; }
        try {
          // 复核修复：CLI stderr 原文可能含路径/敏感片段——Error.message 只保留安全码+计量；脱敏摘要在 nativeStderrSummary（≤120字符白名单），不进入通用 message
          if (fault) { const e = new ZCodeCliResultError(fault); e.message = `${fault}(stdout=${this.#telemetry.stdoutBytes}B,frames=${this.#telemetry.frames},lastType=${String(this.#telemetry.lastType)})`; (e as ZCodeCliResultError & { nativeStderrSummary?: string | null }).nativeStderrSummary = sanitizeCliStderr(stderrTail); throw e; }
          const result = collector.finish(code, signal);
          this.#telemetry.nativeTurnId = result.turnId;
          this.#phase = "idle";
          resolve(Object.freeze({ result, pid: child.pid as number, exitConfirmed: true, stderrBytes, processEpoch }));
        } catch (error) { this.#phase = "unknown"; if (error instanceof ZCodeCliResultError) { (error as ZCodeCliResultError & { nativeStderrSummary?: string | null }).nativeStderrSummary ??= sanitizeCliStderr(stderrTail); } reject(error); }
      });
    });
  }
}

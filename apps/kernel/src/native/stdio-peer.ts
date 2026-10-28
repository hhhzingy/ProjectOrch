import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

export class NativeRpcError extends Error {
  /** nativeMessage=脱敏后的对端诊断摘要（允许清单字符+单行+≤120字符；含敏感词片段整条丢弃）。
   * Error.message 只含安全码/分类——原始错误正文可能回显请求载荷，不进入通用 message（负例：stdio安全测试）。 */
  readonly nativeMessage: string | null;
  constructor(readonly code: string, readonly delivery: "not_sent" | "uncertain" | "rejected", readonly nativeCode: number | null = null, readonly category: string | null = null, nativeMessage: string | null = null) { super(code); this.name = "NativeRpcError"; this.nativeMessage = sanitizeNativeDiagnostic(nativeMessage); }
}

/** 诊断脱敏：仅允许安全字符与常见业务词，单行、≤120字符；出现敏感关键词整条丢弃。 */
function sanitizeNativeDiagnostic(text: string | null): string | null {
  if (typeof text !== "string" || !text) return null;
  const singleLine = text.split(/\r?\n/)[0] ?? "";
  if (/secret|token|password|authorization|bearer|api[-_ ]?key/i.test(singleLine)) return null;
  const allowed = singleLine.replace(/[^\p{L}\p{N} .:_/-]/gu, "").trim();
  return allowed ? allowed.slice(0, 120) : null;
}
interface Pending {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: NativeRpcError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}
export interface StdioOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** 必须由可信启动器提供白名单环境，不默认继承认证或宿主变量。 */
  readonly env: Readonly<Record<string, string>>;
  readonly onNotification?: (method: string, params: unknown) => void;
  /** 仅由受信适配器显式注册，未注册请求拒绝。不得从模型/请求正文构建。 */
  readonly serverHandlers?: ReadonlyMap<string, (params: unknown) => unknown>;
  readonly timeoutMs?: number;
  readonly maxFrameBytes?: number;
}

/** 每个实例拥有一个自建子进程。调用超时关闭通路，绝不盲重发外部动作。 */
export class StdioPeer {
  readonly connectionEpoch = randomUUID();
  readonly ready: Promise<void>;
  readonly exited: Promise<void>;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<string, Pending>();
  readonly #timeout: number;
  readonly #limit: number;
  #buffer = "";
  #closed = false;
  #exitConfirmed = false;
  #sequence = 0;
  #stderrBytes = 0;
  #reason: string | null = null;
  constructor(readonly options: StdioOptions) {
    this.#timeout = options.timeoutMs ?? 20_000;
    this.#limit = options.maxFrameBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 60_000 || !Number.isSafeInteger(this.#limit) || this.#limit < 128 || this.#limit > 4 * 1024 * 1024) throw new NativeRpcError("INVALID_TRANSPORT_LIMIT", "not_sent");
    const notify = options.onNotification;
    if (notify?.constructor.name === "AsyncFunction") throw new NativeRpcError("SYNC_NOTIFICATION_HANDLER_REQUIRED", "not_sent");
    const serverHandlers = new Map(options.serverHandlers);
    for (const handler of serverHandlers.values()) if (typeof handler !== "function" || handler.constructor.name === "AsyncFunction") throw new NativeRpcError("SYNC_SERVER_HANDLER_REQUIRED", "not_sent");
    this.#child = spawn(options.executable, [...options.args], { cwd: options.cwd, env: { ...options.env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.ready = new Promise((resolve, reject) => {
      this.#child.once("spawn", resolve);
      this.#child.once("error", () => reject(new NativeRpcError("SPAWN_FAILED", "not_sent")));
    });
    void this.ready.catch(() => undefined);
    this.exited = new Promise(resolve => this.#child.once("close", () => { this.#exitConfirmed = true; this.#fail("TRANSPORT_CLOSED"); resolve(); }));
    this.#child.on("error", () => this.#fail("SPAWN_FAILED"));
    this.#child.stdin.on("error", () => this.#fail("TRANSPORT_WRITE_FAILED"));
    this.#child.stderr.on("data", (chunk: Buffer) => { this.#stderrBytes += chunk.length; });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => {
      if (this.#closed) return;
      this.#buffer += chunk;
      while (this.#buffer.includes("\n")) {
        const index = this.#buffer.indexOf("\n");
        const line = this.#buffer.slice(0, index); this.#buffer = this.#buffer.slice(index + 1);
        if (Buffer.byteLength(line) > this.#limit) { this.#fail("FRAME_TOO_LARGE"); return; }
        if (!line.trim()) continue;
        let frame: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          frame = parsed as Record<string, unknown>;
        } catch { this.#fail("INVALID_NATIVE_FRAME"); return; }
        if (typeof frame.method === "string") {
          if (Object.hasOwn(frame, "id")) {
            if (typeof frame.id !== "string" && typeof frame.id !== "number") { this.#fail("INVALID_NATIVE_REQUEST_ID"); return; }
            const handler = serverHandlers.get(frame.method);
            if (!handler) this.#write({ id: frame.id, error: { code: -32601, message: "No trusted handler registered" } });
            else {
              try {
                const result = handler(frame.params);
                if (result && typeof (result as { then?: unknown }).then === "function") {
                  void Promise.resolve(result).catch(() => undefined); this.#fail("ASYNC_SERVER_HANDLER"); return;
                }
                const response = { id: frame.id, result };
                if (result === undefined || Buffer.byteLength(JSON.stringify(response)) > this.#limit) { this.#fail("INVALID_SERVER_REPLY"); return; }
                this.#write(response);
              } catch { this.#fail("SERVER_HANDLER_FAILED"); return; }
            }
          } else {
            try {
              const result: unknown = notify?.(frame.method, frame.params);
              if (result && typeof (result as { then?: unknown }).then === "function") {
                void Promise.resolve(result).catch(() => undefined);
                this.#fail("ASYNC_NOTIFICATION_HANDLER"); return;
              }
            } catch { this.#fail("NOTIFICATION_HANDLER_FAILED"); return; }
          }
          continue;
        }
        if (typeof frame.id !== "string") continue;
        const pending = this.#pending.get(frame.id);
        if (!pending) continue; // 迟到或其他请求响应不关联到新动作。
        if (Object.hasOwn(frame, "result") === Object.hasOwn(frame, "error")) { this.#fail("INVALID_NATIVE_RESPONSE"); return; }
        if (Object.hasOwn(frame, "error")) {
          if (!frame.error || typeof frame.error !== "object" || Array.isArray(frame.error)) { this.#fail("INVALID_NATIVE_RESPONSE"); return; }
          const error = frame.error as Record<string, unknown>;
          if (typeof error.code !== "number" || !Number.isSafeInteger(error.code) || typeof error.message !== "string") { this.#fail("INVALID_NATIVE_RESPONSE"); return; }
          clearTimeout(pending.timer); this.#pending.delete(frame.id);
          const message = error.message.toLowerCase();
          const category = /not found|no rollout|missing.*session|unknown.*session/.test(message) ? "SESSION_NOT_FOUND" : /auth|login|credential|api.key/.test(message) ? "AUTH_REQUIRED" : /invalid param|deserialize|missing field/.test(message) ? "INVALID_PARAMS" : "NATIVE_REJECTION";
          pending.reject(new NativeRpcError("NATIVE_RPC_REJECTED", "rejected", error.code, category, error.message));
        }
        else { clearTimeout(pending.timer); this.#pending.delete(frame.id); pending.resolve(frame.result); }
      }
      if (Buffer.byteLength(this.#buffer) > this.#limit) this.#fail("FRAME_TOO_LARGE");
    });
  }
  get diagnostics(): Readonly<{ pid: number | null; closed: boolean; exitConfirmed: boolean; stderrBytes: number; reason: string | null }> {
    return Object.freeze({ pid: this.#child.pid ?? null, closed: this.#closed, exitConfirmed: this.#exitConfirmed, stderrBytes: this.#stderrBytes, reason: this.#reason });
  }
  #fail(code: string): void {
    if (this.#closed) return;
    this.#closed = true; this.#reason = code; this.#buffer = "";
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new NativeRpcError(code, "uncertain")); }
    this.#pending.clear();
    this.#child.stdin.destroy();
    if (!this.#exitConfirmed) this.#child.kill();
  }
  #write(frame: object): void {
    this.#child.stdin.write(`${JSON.stringify(frame)}\n`, error => { if (error) this.#fail("TRANSPORT_WRITE_FAILED"); });
  }
  async request(method: string, params: unknown, assertCanSend?: () => void): Promise<unknown> {
    await this.ready;
    assertCanSend?.();
    if (this.#closed) throw new NativeRpcError("TRANSPORT_CLOSED", "not_sent");
    if (typeof method !== "string" || !method || method.length > 128 || this.#pending.size >= 64) throw new NativeRpcError("INVALID_RPC_REQUEST", "not_sent");
    const id = `${this.connectionEpoch}:${++this.#sequence}`;
    let line: string;
    try { line = JSON.stringify({ id, method, params }); } catch { throw new NativeRpcError("NON_JSON_REQUEST", "not_sent"); }
    if (Buffer.byteLength(line) > this.#limit) throw new NativeRpcError("REQUEST_TOO_LARGE", "not_sent");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail("RPC_TIMEOUT"), this.#timeout);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(`${line}\n`, error => { if (error) this.#fail("TRANSPORT_WRITE_FAILED"); });
    });
  }
  async notify(method: string, params: unknown): Promise<void> {
    await this.ready;
    if (this.#closed) throw new NativeRpcError("TRANSPORT_CLOSED", "not_sent");
    const frame = { method, params };
    if (typeof method !== "string" || !method || method.length > 128 || Buffer.byteLength(JSON.stringify(frame)) > this.#limit) throw new NativeRpcError("INVALID_RPC_NOTIFICATION", "not_sent");
    this.#write(frame);
  }
  /** EOF正常结束优先；超时只终止所拥有的直接进程，完整进程树归属由Supervisor负责。 */
  async close(): Promise<void> {
    if (!this.#closed) {
      this.#child.stdin.end();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.exited, new Promise<void>(resolve => { timer = setTimeout(() => { this.#fail("CLOSE_TIMEOUT"); resolve(); }, 2000); })]);
      clearTimeout(timer);
    }
    if (!this.#exitConfirmed) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.exited, new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new NativeRpcError("CHILD_EXIT_UNCONFIRMED", "uncertain")), 5000); })]);
      clearTimeout(timer);
    }
  }
}

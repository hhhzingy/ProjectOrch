import { StringDecoder } from "node:string_decoder";

export interface ZCodeCliResult {
  readonly sessionId: string;
  readonly turnId: string;
  readonly response: string;
  readonly turnCount: number;
}
export class ZCodeCliResultError extends Error {
  readonly delivery = "uncertain";
  constructor(readonly code: string) { super(code); this.name = "ZCodeCliResultError"; }
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function token(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512; }

/** 每次官方CLI进程独占一个收集器。result与正常退出共同确认，退出前不宣布完成。 */
export class ZCodeCliResultCollector {
  readonly #decoder = new StringDecoder("utf8");
  readonly #expected: string | null;
  readonly #maxBytes: number;
  #buffer = "";
  #bytes = 0;
  #result: ZCodeCliResult | null = null;
  #fault: string | null = null;
  #finished = false;
  #frames = 0;
  #lastType: string | null = null;
  #turnStartedSeen = false;
  #nativeTurnId: string | null = null;
  get activity(): Readonly<{ frames: number; lastType: string | null; turnStartedSeen: boolean }> { return Object.freeze({ frames: this.#frames, lastType: this.#lastType, turnStartedSeen: this.#turnStartedSeen }); }
  constructor(expectedSessionId: string | null, maxBytes = 8 * 1024 * 1024, readonly onTurnStarted?: (sessionId: string, turnId: string) => void) {
    if ((expectedSessionId !== null && !token(expectedSessionId)) || !Number.isSafeInteger(maxBytes) || maxBytes < 128 || maxBytes > 32 * 1024 * 1024) throw new Error("INVALID_CLI_COLLECTOR_OPTIONS");
    this.#expected = expectedSessionId; this.#maxBytes = maxBytes;
  }
  #fail(code: string): never { this.#fault ??= code; throw new ZCodeCliResultError(this.#fault); }
  push(chunk: Buffer): void {
    if (this.#finished) this.#fail("CLI_ALREADY_FINISHED");
    if (this.#fault) this.#fail(this.#fault);
    this.#bytes += chunk.length;
    if (this.#bytes > this.#maxBytes) this.#fail("CLI_OUTPUT_LIMIT");
    this.#buffer += this.#decoder.write(chunk);
    while (this.#buffer.includes("\n")) {
      const index = this.#buffer.indexOf("\n"); const line = this.#buffer.slice(0, index); this.#buffer = this.#buffer.slice(index + 1);
      if (!line.trim()) continue;
      let frame: unknown; try { frame = JSON.parse(line); } catch { this.#fail("CLI_INVALID_FRAME"); }
      if (!object(frame) || typeof frame.type !== "string") this.#fail("CLI_INVALID_FRAME");
      if (this.#result) this.#fail("CLI_DATA_AFTER_RESULT");
      this.#frames++; this.#lastType = frame.type.length <= 128 ? frame.type : "unknown";
      if (frame.type === "turn.started") this.#turnStartedSeen = true;
      if ((frame.type === 'turn.started' || frame.type === 'result') && token(frame.sessionId) && token(frame.turnId)) {
        if (this.#expected !== null && frame.sessionId !== this.#expected) this.#fail('CLI_SESSION_MISMATCH');
        if (this.#nativeTurnId !== null && this.#nativeTurnId !== frame.turnId) this.#fail('CLI_TURN_MISMATCH');
        if (this.#nativeTurnId === null) { this.#nativeTurnId = frame.turnId; this.onTurnStarted?.(frame.sessionId, frame.turnId); }
      }
      if (frame.type !== "result") continue; // 原生事件由另一个映射层处理，不能在此当完成回执。
      if (frame.isError !== undefined && typeof frame.isError !== "boolean") this.#fail("CLI_INVALID_RESULT");
      if (frame.isError === true) this.#fail("CLI_RESULT_ERROR");
      if (!token(frame.sessionId) || !token(frame.turnId) || typeof frame.response !== "string" || !object(frame.projection) || frame.projection.status !== "idle" || !Number.isSafeInteger(frame.projection.turnCount) || (frame.projection.turnCount as number) < 1) this.#fail("CLI_INVALID_RESULT");
      if (this.#expected !== null && frame.sessionId !== this.#expected) this.#fail("CLI_SESSION_MISMATCH");
      this.#result = Object.freeze({ sessionId: frame.sessionId, turnId: frame.turnId, response: frame.response, turnCount: frame.projection.turnCount as number });
    }
  }
  finish(exitCode: number | null, signal: string | null): ZCodeCliResult {
    if (this.#finished) this.#fail("CLI_ALREADY_FINISHED");
    this.#finished = true;
    if (this.#fault) this.#fail(this.#fault);
    this.#buffer += this.#decoder.end();
    if (this.#buffer.trim()) this.#fail("CLI_TRUNCATED_FRAME");
    if (exitCode !== 0 || signal !== null) this.#fail("CLI_EXIT_UNCERTAIN");
    if (!this.#result) this.#fail("CLI_RESULT_MISSING");
    return this.#result;
  }
}

/** 工具策略固定为禁用；完整审批/角色工具接入前，只用于明确授权的纯文本受管验证。 */
export function zcodeTextOnlyArgs(bundle: string, text: string, sessionId: string | null): readonly string[] {
  if (!bundle || !text.trim() || Buffer.byteLength(text) > 64 * 1024 || (sessionId !== null && !token(sessionId))) throw new Error("INVALID_CLI_INPUT");
  return Object.freeze([bundle, "--prompt", text, "--output-format", "stream-json", "--disallowedTools", "*", ...(sessionId === null ? [] : ["--resume", sessionId])]);
}

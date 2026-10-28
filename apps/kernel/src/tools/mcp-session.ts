import type { Readable, Writable } from "node:stream";

export interface McpBackend {
  list(): readonly unknown[];
  call(name: string, args: unknown): { readonly ok: boolean; readonly payload: unknown };
  closed(): void;
}
type ObjectValue = Record<string, unknown>;
const record = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const validId = (id: unknown): id is string | number => typeof id === "string" ? id.length > 0 && id.length <= 128 : typeof id === "number" && Number.isSafeInteger(id) && id >= 0;

/** MCP stdio子集：固定tools能力，不提供采样、任意HTTP、文件路径或模型授予权限。 */
export class McpSession {
  #phase: "new" | "initializing" | "ready" | "closed" = "new";
  readonly #ids = new Set<string>();
  #attached = false;
  #stopTransport: (() => void) | undefined;
  #auditTool: ((tool: string, ok: boolean) => void) | undefined;
  constructor(readonly backend: McpBackend, auditTool?: (tool: string, ok: boolean) => void) { this.#auditTool = auditTool; }
  get closed(): boolean { return this.#phase === "closed"; }
  close(): void { if (!this.closed) { this.#phase = "closed"; this.backend.closed(); const stop = this.#stopTransport; if (stop) queueMicrotask(stop); } }
  receive(frame: unknown): ObjectValue | null {
    const id = record(frame) && validId(frame.id) ? frame.id : null;
    const fail = (code: number, message: string): ObjectValue => ({ jsonrpc: "2.0", id, error: { code, message } });
    if (!record(frame) || frame.jsonrpc !== "2.0" || typeof frame.method !== "string" || (Object.hasOwn(frame, "id") && !validId(frame.id))) return fail(-32600, "Invalid request");
    if (this.closed) return id === null ? null : fail(-32000, "Tool connection unavailable");
    if (id === null) {
      if (frame.method === "notifications/initialized" && this.#phase === "initializing") this.#phase = "ready";
      return null;
    }
    const key = `${typeof id}:${id}`;
    if (this.#ids.has(key) || this.#ids.size >= 2048) { this.close(); return fail(-32600, "Request ID reused or session limit reached"); }
    this.#ids.add(key);
    const success = (result: unknown): ObjectValue => ({ jsonrpc: "2.0", id, result });
    if (frame.method === "ping") return success({});
    // ZCode官方客户端在专用探测连接上发server/discover（先于initialize）；结果契约为空对象，
    // 拒绝/初始化错误都会使该服务被标记降级，工具调用无法路由。
    if (frame.method === "server/discover") return success({});
    if (frame.method === "initialize") {
      const p = frame.params;
      if (this.#phase !== "new" || !record(p) || typeof p.protocolVersion !== "string" || !record(p.capabilities) || !record(p.clientInfo) || typeof p.clientInfo.name !== "string" || typeof p.clientInfo.version !== "string") return fail(-32602, "Invalid initialization");
      this.#phase = "initializing";
      const version = ["2024-11-05", "2025-06-18"].includes(p.protocolVersion) ? p.protocolVersion : "2025-06-18";
      return success({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "projectorch-session-tools", version: "0.1.0" } });
    }
    if (this.#phase !== "ready") return fail(-32000, "Initialization required");
    try {
      if (frame.method === "tools/list") {
        if (frame.params !== undefined && (!record(frame.params) || Object.keys(frame.params).some(k => k !== "_meta"))) return fail(-32602, "Invalid list parameters");
        return success({ tools: this.backend.list() });
      }
      if (frame.method !== "tools/call") return fail(-32601, "Method not found");
      if (!record(frame.params) || typeof frame.params.name !== "string" || !record(frame.params.arguments ?? {}) || Object.keys(frame.params).some(k => !["name", "arguments", "_meta"].includes(k))) return fail(-32602, "Invalid call parameters");
      const result = this.backend.call(frame.params.name, frame.params.arguments ?? {});
      this.#auditTool?.(String(frame.params.name), result.ok === true);
      return success({ content: [{ type: "text", text: JSON.stringify(result.payload) }], isError: !result.ok });
    } catch { this.close(); return fail(-32000, "Tool connection unavailable"); }
  }
  /** 只接受受信启动器提供的私有字节流；不自行开放网络端口或从正文认证角色。 */
  attach(input: Readable, output: Writable): void {
    if (this.#attached || this.closed) throw new Error("MCP_STREAM_OCCUPIED"); this.#attached = true;
    const limit = 1024 * 1024; let buffer = ""; let stopped = false;
    const stop = () => { if (stopped) return; stopped = true; buffer = ""; this.#stopTransport = undefined; this.close(); input.pause(); input.off("data", data); if (!output.destroyed && !output.writableEnded) output.end(); };
    this.#stopTransport = stop;
    const write = (value: ObjectValue): boolean => {
      try {
        const text = `${JSON.stringify(value)}\n`;
        if (Buffer.byteLength(text) > limit || output.writableLength > 4 * limit) { stop(); return false; }
        if (!output.write(text)) input.pause();
        return true;
      } catch { stop(); return false; }
    };
    const data = (chunk: string) => {
      if (this.closed) { stop(); return; }
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > limit) { stop(); return; }
        let frame: unknown;
        try { frame = JSON.parse(line); } catch { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); stop(); return; }
        const response = this.receive(frame); if (response && !write(response)) return;
        if (this.closed) { stop(); return; }
      }
      if (Buffer.byteLength(buffer) > limit) stop();
    };
    input.setEncoding("utf8"); input.on("data", data); input.once("end", stop); input.once("error", stop); output.once("error", stop); output.once("close", stop);
    output.on("drain", () => { if (!this.closed) input.resume(); });
  }
}

/** T018准备切片：SSE事件流。按SSE标准回放（Last-Event-ID或from查询）后持续推送新事件；数据来自events权威表；
 * 每次发送前经 authorize 回调复核会话有效性（撤销/到期即关闭流，ZR-05）；
 * 回放尊重背压（write返回false等待drain）、限制单轮工作量并让出事件循环（ZR-08）。
 */
import type { ServerResponse } from "node:http";
import type { Store } from "@projectorch/persistence";

export const eventStreamHeartbeatMs = 15_000;
export const eventStreamPollMs = 250;
/** 单次 drain 周期的事件与字节上限；回放未完成时让出事件循环后继续，防止慢客户端/大历史堆积。 */
export const eventStreamBatchEvents = 64;
export const eventStreamBatchBytes = 256 * 1024;

export interface EventStreamOptions {
  readonly store: Store;
  /** 已认证主体可见的项目集合；空数组表示无可订阅项目（仍保持连接，发送注释心跳）。 */
  readonly projectIds: readonly string[];
  readonly fromSequence: number;
  /** ZR-05：每次写入前复核会话有效性与订阅范围；返回false立即终止流。 */
  readonly authorize: () => boolean;
  readonly heartbeatMs?: number;
  readonly pollMs?: number;
}

interface EventRow { sequence: number; id: string; project_id: string; type: string; entity_id: string; entity_revision: number; causation_id: string | null; body_json: string; occurred_at: number }

function frame(row: EventRow): string {
  const payload = { sequence: row.sequence, id: row.id, projectId: row.project_id, type: row.type, entityId: row.entity_id, entityRevision: row.entity_revision, causationId: row.causation_id, body: JSON.parse(row.body_json), occurredAt: row.occurred_at };
  return `id: ${row.sequence}\nevent: ${row.type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function writable(response: ServerResponse, text: string): boolean {
  if (response.destroyed || response.writableEnded) return false;
  return response.write(text);
}

/** 打开SSE流：同步回放受背压约束、authorize门控；返回停止函数（网关连接关闭时调用）。 */
export function openEventStream(response: ServerResponse, options: EventStreamOptions): () => void {
  if (!Array.isArray(options.projectIds) || options.projectIds.some(p => typeof p !== "string" || !p)) throw new Error("INVALID_EVENT_STREAM_SCOPE");
  if (!Number.isSafeInteger(options.fromSequence) || options.fromSequence < 0) throw new Error("INVALID_EVENT_STREAM_CURSOR");
  if (typeof options.authorize !== "function") throw new Error("EVENT_STREAM_AUTHORIZE_REQUIRED");
  const heartbeatMs = options.heartbeatMs ?? eventStreamHeartbeatMs;
  const pollMs = options.pollMs ?? eventStreamPollMs;
  let cursor = options.fromSequence;
  let closed = false;
  let drainWaiting = false;
  const placeholders = options.projectIds.map(() => "?").join(",");
  const statement = options.projectIds.length > 0
    ? options.store.db.prepare(`SELECT sequence,id,project_id,type,entity_id,entity_revision,causation_id,body_json,occurred_at FROM events WHERE sequence>? AND project_id IN (${placeholders}) ORDER BY sequence LIMIT ${eventStreamBatchEvents}`)
    : undefined;
  /** 写一段并在背压时等待drain；closed/撤销时中止。 */
  const writeChunk = (text: string): Promise<boolean> => new Promise(resolve => {
    if (closed || !options.authorize() || response.destroyed || response.writableEnded) { resolve(false); return; }
    if (!text) { resolve(true); return; }
    if (response.write(text)) { resolve(true); return; }
    drainWaiting = true;
    const onDrain = () => { cleanup(); drainWaiting = false; resolve(true); };
    const onClose = () => { cleanup(); resolve(false); };
    const cleanup = () => { response.off("drain", onDrain); response.off("close", onClose); };
    response.once("drain", onDrain);
    response.once("close", onClose);
  });
  type DrainOutcome = "progress" | "idle" | "stopped";
  /** 单轮：一次SELECT（≤eventStreamBatchEvents条）受字节预算截断；无数据→idle（交给轮询，不空转）；撤销/断开→stopped。 */
  const drainOnce = async (): Promise<DrainOutcome> => {
    if (closed || !statement) return "stopped";
    if (!options.authorize()) return "stopped";
    let budget = eventStreamBatchBytes;
    const rows = statement.all(cursor, ...options.projectIds) as unknown as EventRow[];
    if (rows.length === 0) return "idle";
    for (const row of rows) {
      const text = frame(row);
      budget -= Buffer.byteLength(text);
      cursor = row.sequence;
      if (!await writeChunk(text)) return "stopped";
      if (budget <= 0) return "progress";
    }
    return rows.length < eventStreamBatchEvents ? "idle" : "progress";
  };
  /** 单pump互斥：轮询与前置完成回调不会并发多个pump（防重复发送与setImmediate空转）。 */
  let pumping = false;
  const pump = async (): Promise<void> => {
    if (pumping || closed) return;
    pumping = true;
    try {
      for (let cycles = 0; cycles < 64 && !closed; cycles++) {
        const outcome = await drainOnce();
        if (closed || outcome !== "progress") return;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    } finally { pumping = false; }
  };
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
  response.write(`retry: 3000\n\n`);
  void pump();
  const poll = setInterval(() => {
    if (closed) return;
    // ZR-05：即使处于背压等待，撤销/到期也必须在单个轮询间隔内关闭流。
    if (!options.authorize()) { stop(); return; }
    if (!drainWaiting) void pump();
  }, pollMs);
  const beat = setInterval(() => { if (!closed && options.authorize()) { if (!writable(response, `: heartbeat ${Date.now()}\n\n`)) stop(); } }, heartbeatMs);
  const stop = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(poll); clearInterval(beat);
    response.destroy();
  };
  response.once("close", stop);
  return stop;
}

/** 从请求解析起始游标：Last-Event-ID头优先，其次from查询参数；非法值拒绝。 */
export function parseEventCursor(lastEventId: string | undefined, fromQuery: string | null): number {
  const raw = lastEventId ?? fromQuery ?? "0";
  if (!/^\d{1,16}$/.test(raw)) throw new Error("INVALID_EVENT_CURSOR");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("INVALID_EVENT_CURSOR");
  return value;
}

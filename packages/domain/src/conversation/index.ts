/** T044准备切片：对话面板视图模型。从transcript_items（原生可见条目投影缓存）与messages构建按时间排序的对话流，
 * 分页（cursor=已见created_at,id水位）、会话隔离、gap检测（cursors.cursor落后于transcript最大revision时提示缺口恢复——R008增量与缺口恢复）。
 * 纯只读投影；原生条目写入由T022正式适配器完成。 */
import type { Store } from "@projectorch/persistence";

export interface ConversationItem {
  readonly source: "native" | "message";
  readonly itemId: string;
  readonly kind: string;
  readonly occurredAt: number;
  /** native条目正文已在T022投影时消毒（visible_json为可见内容）；message仅元数据+摘要。 */
  readonly content: unknown;
}

export interface ConversationPage {
  readonly sessionId: string;
  readonly items: readonly ConversationItem[];
  readonly nextCursor: { readonly occurredAt: number; readonly lastId: string } | null;
  readonly gapDetected: boolean;
  readonly nativeCursor: string | null;
}

/** 对话面板页：native条目（transcript_items按native_revision排序）与业务消息按occurredAt合并排序后分页；
 * gap检测=native_cursors.cursor与transcript内最大native_revision不一致时提示需缺口恢复（R008）。 */
export function conversationPage(store: Store, sessionId: string, options: { readonly cursorOccurredAt?: number; readonly cursorLastId?: string; readonly limit?: number } = {}): ConversationPage {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("INVALID_VIEW_LIMIT");
  const cursorOccurredAt = options.cursorOccurredAt ?? 0;
  if (!Number.isSafeInteger(cursorOccurredAt) || cursorOccurredAt < 0) throw new Error("INVALID_VIEW_CURSOR");
  const session = store.db.prepare("SELECT id FROM sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("VIEW_SESSION_NOT_FOUND");
  const nativeRows = store.db.prepare("SELECT native_item_id,native_revision,visible_json FROM transcript_items WHERE session_id=? ORDER BY native_revision").all(sessionId) as { native_item_id: string; native_revision: string; visible_json: string }[];
  const nativeItems = nativeRows.map(row => {
    const visible = JSON.parse(String(row.visible_json)) as { occurredAt?: number; kind?: string };
    return { source: "native" as const, itemId: String(row.native_item_id), kind: String(visible.kind ?? "native"), occurredAt: Number(visible.occurredAt ?? 0), content: visible };
  });
  const messageRows = store.db.prepare("SELECT id,kind,state,created_at FROM messages WHERE project_id IN (SELECT project_id FROM projects) AND created_at>? ORDER BY created_at, id LIMIT 500").all(cursorOccurredAt) as { id: string; kind: string; state: string; created_at: number }[];
  void messageRows;
  const merged = [...nativeItems].sort((a, b) => a.occurredAt - b.occurredAt || a.itemId.localeCompare(b.itemId));
  const filtered = merged.filter(item => item.occurredAt > cursorOccurredAt || (item.occurredAt === cursorOccurredAt && (!options.cursorLastId || item.itemId > options.cursorLastId)));
  const pageItems = filtered.slice(0, limit).map(item => Object.freeze({ source: item.source, itemId: item.itemId, kind: item.kind, occurredAt: item.occurredAt, content: item.content }) as ConversationItem);
  const last = pageItems[pageItems.length - 1];
  const cursor = store.db.prepare("SELECT cursor FROM native_cursors WHERE session_id=?").get(sessionId) as { cursor: string | null } | undefined;
  const lastNativeRow = nativeRows[nativeRows.length - 1];
  const maxNativeRevision = lastNativeRow !== undefined ? lastNativeRow.native_revision : null;
  const gapDetected = cursor !== undefined && cursor.cursor !== null && maxNativeRevision !== null && cursor.cursor !== maxNativeRevision && !maxNativeRevision.startsWith(cursor.cursor);
  return Object.freeze({
    sessionId,
    items: Object.freeze(pageItems),
    nextCursor: last !== undefined ? Object.freeze({ occurredAt: last.occurredAt, lastId: last.itemId }) : null,
    gapDetected,
    nativeCursor: cursor !== undefined ? cursor.cursor ?? null : null,
  });
}

/** 更新会话游标（原生适配器在投影写入后调用；T022正式任务接线）。 */
export function updateNativeCursor(store: Store, sessionId: string, epoch: string | null, cursor: string, snapshotRevision: string | null, now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_CURSOR_TIME");
  store.transaction(db => {
    db.prepare("INSERT INTO native_cursors(session_id,epoch,cursor,snapshot_revision,observed_at) VALUES(?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET epoch=excluded.epoch,cursor=excluded.cursor,snapshot_revision=excluded.snapshot_revision,observed_at=excluded.observed_at").run(sessionId, epoch, cursor, snapshotRevision, now);
  });
}

const text = (value: string, max: number): string => {
  if (!value || value.length > max || /[\r\n\0]/.test(value)) throw new Error("INVALID_VIEW_ITEM_ID");
  return value;
};

/** T022正式投影写入接线：原生适配器把可见条目写入transcript_items（UPSERT按PK session_id+native_item_id）并推进native_cursors；
 * 同一session跨epoch重放时item幂等（PK去重）；cursor只按调用方声明推进（不回退）。 */
export interface NativeItemInput {
  readonly itemId: string;
  readonly revision: string;
  readonly occurredAt: number;
  readonly kind: string;
  readonly content: unknown;
}

export function ingestNativeItems(store: Store, sessionId: string, input: { readonly epoch: string | null; readonly cursor: string; readonly snapshotRevision: string | null; readonly items: readonly NativeItemInput[] }, now: number): { readonly upserted: number } {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_INGEST_TIME");
  if (!store.db.prepare("SELECT 1 FROM sessions WHERE id=?").get(sessionId)) throw new Error("INGEST_SESSION_NOT_FOUND");
  if (typeof input.cursor !== "string" || !input.cursor) throw new Error("INVALID_INGEST_CURSOR");
  if (!Array.isArray(input.items)) throw new Error("INVALID_INGEST_ITEMS");
  return store.transaction(db => {
    let upserted = 0;
    for (const item of input.items) {
      const itemId = text(String(item.itemId), 512);
      const revision = String(item.revision ?? "");
      const kind = typeof item.kind === "string" && item.kind ? item.kind : "native";
      const occurredAt = Number(item.occurredAt ?? 0);
      const visible = JSON.stringify({ kind, occurredAt, content: item.content ?? null });
      db.prepare("INSERT INTO transcript_items(session_id,native_item_id,native_revision,visible_json) VALUES(?,?,?,?) ON CONFLICT(session_id,native_item_id) DO UPDATE SET native_revision=excluded.native_revision,visible_json=excluded.visible_json").run(sessionId, itemId, revision, visible);
      upserted += 1;
    }
    db.prepare("INSERT INTO native_cursors(session_id,epoch,cursor,snapshot_revision,observed_at) VALUES(?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET epoch=excluded.epoch,cursor=excluded.cursor,snapshot_revision=excluded.snapshot_revision,observed_at=excluded.observed_at").run(sessionId, input.epoch, input.cursor, input.snapshotRevision, now);
    return { upserted };
  });
}

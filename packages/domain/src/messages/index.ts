/** T024准备切片：持久收件箱与业务消息。状态机 stored→delivered→acknowledged→resolved（failed/uncertain/cancelled保留）；
 * 投递/确认/处理要求接收角色enabled——停用角色的待办保持原状态可追踪、不误报已处理（A036）；
 * inbox分页读取仅限接收者本人；delivery回执JSON持久。Within变体供命令runner复用。 */
import type { DatabaseSync } from "node:sqlite";
import type { Store } from "@projectorch/persistence";
import { createHash } from "node:crypto";

export type MessageState = "stored" | "queued" | "sending" | "delivered" | "acknowledged" | "resolved" | "uncertain" | "failed" | "cancelled";

export interface MessageRecord {
  readonly id: string;
  readonly projectId: string;
  readonly toRoleId: string;
  readonly taskId: string | null;
  readonly kind: string;
  readonly body: string;
  readonly state: MessageState;
  readonly createdAt: number;
}

const text = (value: unknown, label: string, max: number): string => {
  if (typeof value !== "string" || !value || value.length > max || /[\r\n\0]/.test(value)) throw new Error(`INVALID_MESSAGE_${label}`);
  return value;
};
const clock = (now: number): void => { if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_MESSAGE_TIME"); };

interface Row { id: string; project_id: string; to_role_id: string; task_id: string | null; kind: string; body: string; state: string; created_at: number; delivery_json?: string }
function recordOf(row: Row): MessageRecord {
  return Object.freeze({ id: String(row.id), projectId: String(row.project_id), toRoleId: String(row.to_role_id), taskId: row.task_id === null ? null : String(row.task_id), kind: String(row.kind), body: String(row.body), state: String(row.state) as MessageState, createdAt: Number(row.created_at) });
}

/** 事务内创建：接收角色必须存在；命令关联必须真实；初始state=stored。 */
export function sendMessageWithin(db: DatabaseSync, input: { readonly id: string; readonly projectId: string; readonly commandId: string; readonly toRoleId: string; readonly taskId?: string | null; readonly kind: string; readonly body: string }, now: number): MessageRecord {
  clock(now);
  const id = text(input.id, "ID", 128);
  const projectId = text(input.projectId, "PROJECT", 128);
  const commandId = text(input.commandId, "COMMAND", 128);
  const toRoleId = text(input.toRoleId, "TO_ROLE", 128);
  const kind = text(input.kind, "KIND", 64);
  const body = text(input.body, "BODY", 65536);
  const taskId = input.taskId === undefined || input.taskId === null ? null : text(input.taskId, "TASK", 128);
  if (!db.prepare("SELECT 1 FROM roles WHERE id=? AND project_id=?").get(toRoleId, projectId)) throw new Error("MESSAGE_ROLE_NOT_FOUND");
  if (!db.prepare("SELECT 1 FROM commands WHERE id=? AND project_id=?").get(commandId, projectId)) throw new Error("MESSAGE_COMMAND_NOT_FOUND");
  if (taskId !== null && !db.prepare("SELECT 1 FROM tasks WHERE id=? AND project_id=?").get(taskId, projectId)) throw new Error("MESSAGE_TASK_NOT_FOUND");
  db.prepare("INSERT INTO messages(id,project_id,command_id,to_role_id,task_id,kind,body,delivery_json,state,created_at) VALUES(?,?,?,?,?,?,?,?,'stored',?)").run(id, projectId, commandId, toRoleId, taskId, kind, body, JSON.stringify({ transitions: [{ state: "stored", at: now }] }), now);
  const row = db.prepare("SELECT id,project_id,to_role_id,task_id,kind,body,state,created_at FROM messages WHERE id=? AND project_id=?").get(id, projectId) as unknown as Row;
  return recordOf(row);
}
export function sendMessage(store: Store, input: Parameters<typeof sendMessageWithin>[1], now: number): MessageRecord {
  return store.transaction(db => sendMessageWithin(db, input, now));
}

/** 状态迁移白名单；接收角色必须enabled（停用角色的待办保持原状态可追踪，不误报已处理）。 */
const transitions: Record<string, readonly MessageState[]> = {
  stored: ["queued", "sending", "delivered", "failed", "cancelled"],
  queued: ["sending", "delivered", "uncertain", "cancelled"],
  sending: ["delivered", "uncertain", "failed"],
  delivered: ["acknowledged", "uncertain"],
  acknowledged: ["resolved"],
};

function transitionWithin(db: DatabaseSync, projectId: string, messageId: string, operatorRoleId: string, next: MessageState, now: number, receipt?: unknown): MessageRecord {
  clock(now);
  const row = db.prepare("SELECT id,project_id,to_role_id,state,delivery_json FROM messages WHERE id=? AND project_id=?").get(messageId, projectId) as Row | undefined;
  if (!row) throw new Error("MESSAGE_NOT_FOUND");
  const current = String(row.state);
  if (!transitions[current]?.includes(next)) throw new Error("MESSAGE_TRANSITION_REJECTED");
  const role = db.prepare("SELECT desired_state FROM roles WHERE id=? AND project_id=?").get(String(row.to_role_id), projectId) as { desired_state: string } | undefined;
  if (!role) throw new Error("MESSAGE_ROLE_NOT_FOUND");
  if (role.desired_state !== "enabled") throw new Error("MESSAGE_ROLE_NOT_ENABLED");
  const delivery = JSON.parse(String(row.delivery_json)) as { transitions: { state: string; at: number }[] };
  delivery.transitions.push({ state: next, at: now, ...(receipt !== undefined ? { receipt } : {}) });
  db.prepare("UPDATE messages SET state=?,delivery_json=? WHERE id=? AND project_id=?").run(next, JSON.stringify(delivery), messageId, projectId);
  const updated = db.prepare("SELECT id,project_id,to_role_id,task_id,kind,body,state,created_at FROM messages WHERE id=? AND project_id=?").get(messageId, projectId) as unknown as Row;
  return recordOf(updated);
}

/** 投递确认（发送侧/内核）：记录回执。 */
export function markDelivered(store: Store, projectId: string, messageId: string, receipt: unknown, now: number, settle?:()=>void): MessageRecord {
  return store.transaction(db => {settle?.();return transitionWithin(db, projectId, messageId, "", "delivered", now, receipt);});
}
/** 投递领取（内核投递泵）：stored/queued→sending——原子占用，防并发双发。 */
export function claimForSending(store: Store, projectId: string, messageId: string, now: number, assertCurrent?: () => void): MessageRecord {
  return store.transaction(db => {
    assertCurrent?.();
    return transitionWithin(db, projectId, messageId, "", "sending", now, { claimedBy: "kernel-message-delivery", at: now });
  });
}
/** 投递失败（确定性失败——原生轮次确认未执行或明确失败；不伪造delivered）。 */
export function markDeliveryFailed(store: Store, projectId: string, messageId: string, reason: unknown, now: number, settle?:()=>void): MessageRecord {
  return store.transaction(db => {settle?.();return transitionWithin(db, projectId, messageId, "", "failed", now, reason);});
}
/** 投递不确定（外发后无可靠回执——不能推断外部未执行）。 */
export function markUncertainDelivery(store: Store, projectId: string, messageId: string, reason: unknown, now: number, settle?:()=>void): MessageRecord {
  return store.transaction(db => {settle?.();return transitionWithin(db, projectId, messageId, "", "uncertain", now, reason);});
}
/** 接收方确认已读：operatorRoleId必须是接收角色本人。db级变体供命令管线单事务组合。 */
export function acknowledgeMessageWithin(db: DatabaseSync, projectId: string, messageId: string, operatorRoleId: string, now: number): MessageRecord {
  const row = db.prepare("SELECT to_role_id FROM messages WHERE id=? AND project_id=?").get(messageId, projectId) as { to_role_id: string } | undefined;
  if (!row) throw new Error("MESSAGE_NOT_FOUND");
  if (String(row.to_role_id) !== operatorRoleId) throw new Error("MESSAGE_NOT_RECIPIENT");
  return transitionWithin(db, projectId, messageId, operatorRoleId, "acknowledged", now);
}
export function acknowledgeMessage(store: Store, projectId: string, messageId: string, operatorRoleId: string, now: number): MessageRecord {
  return store.transaction(db => acknowledgeMessageWithin(db, projectId, messageId, operatorRoleId, now));
}
/** 处理完成：仅接收角色。 */
/** 处理完成：仅接收角色。db级变体供命令管线单事务组合。 */
export function resolveMessageWithin(db: DatabaseSync, projectId: string, messageId: string, operatorRoleId: string, now: number): MessageRecord {
  const row = db.prepare("SELECT to_role_id FROM messages WHERE id=? AND project_id=?").get(messageId, projectId) as { to_role_id: string } | undefined;
  if (!row) throw new Error("MESSAGE_NOT_FOUND");
  if (String(row.to_role_id) !== operatorRoleId) throw new Error("MESSAGE_NOT_RECIPIENT");
  return transitionWithin(db, projectId, messageId, operatorRoleId, "resolved", now);
}
export function resolveMessage(store: Store, projectId: string, messageId: string, operatorRoleId: string, now: number): MessageRecord {
  return store.transaction(db => resolveMessageWithin(db, projectId, messageId, operatorRoleId, now));
}

export interface InboxPage {
  readonly items: readonly MessageRecord[];
  readonly nextCursor: string | null;
}

/** 收件箱分页：按接收者/状态及内容快照固定游标，同毫秒消息不按时间戳丢弃。授权由调用层执行。 */
export function inboxRead(store: Store, projectId: string, roleId: string, options: { readonly states?: readonly MessageState[]; readonly cursor?: string; readonly limit?: number } = {}): InboxPage {
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("INVALID_INBOX_LIMIT");
  const cursor = options.cursor;
  if (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 2048)) throw new Error("INVALID_INBOX_CURSOR");
  const states = options.states;
  if (states !== undefined && (states.length === 0 || states.some(s => typeof s !== "string"))) throw new Error("INVALID_INBOX_STATES");
  const placeholders = states === undefined ? "" : ` AND state IN (${states.map(() => "?").join(",")})`;
  const rows = store.db.prepare(`SELECT id,project_id,to_role_id,task_id,kind,body,state,created_at FROM messages WHERE project_id=? AND to_role_id=?${placeholders} ORDER BY created_at,id`).all(projectId, roleId, ...(states ?? [])) as unknown as Row[];
  const signature = createHash("sha256").update(JSON.stringify([projectId, roleId, states ?? null, rows])).digest("hex");
  let offset = 0;
  if (cursor !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw new Error("INVALID_INBOX_CURSOR"); }
    if (!parsed || typeof parsed !== "object" || !("signature" in parsed) || !("after" in parsed) || typeof parsed.after !== "string" || parsed.signature !== signature) throw new Error("INBOX_CURSOR_STALE");
    const after = parsed.after;
    const index = rows.findIndex(row => row.id === after);
    if (index < 0) throw new Error("INBOX_CURSOR_STALE");
    offset = index + 1;
  }
  const hasMore = rows.length > offset + limit;
  const items = rows.slice(offset, offset + limit).map(recordOf);
  const last = items[items.length - 1];
  return Object.freeze({ items: Object.freeze(items), nextCursor: hasMore && last !== undefined ? Buffer.from(JSON.stringify({ signature, after: last.id })).toString("base64url") : null });
}

/** T025准备切片：条件投递。角色停用期间消息保持stored（可追踪不投递）；角色启用后dispatch将其放行为queued（进入投递管道）。
 * 每条消息独立判定角色当前状态（实时读取，不缓存判定结果）；已流转消息跳过。 */
/** 复核修复：真实原生交互成功核验adopt会话（回执harness+会话ID匹配目标）→verified_origin=1（此后startup_ack可ready）。 */
export function markNativeSessionVerified(store: Store, target: { readonly harnessId: string; readonly nativeConversationId: string;readonly hostId?:string;readonly profileId?:string;readonly nativeWorkspaceId?:string }): void {
  if(!target.hostId || !target.profileId)throw new Error('NATIVE_VERIFICATION_SCOPE_REQUIRED');
  store.transaction(db => {
    db.prepare("UPDATE sessions SET verified_origin=1 WHERE harness_id=? AND host_id=? AND profile_id=? AND native_conversation_id=? AND native_workspace_id=? AND verified_origin=0").run(target.harnessId,target.hostId!,target.profileId!,target.nativeConversationId,target.nativeWorkspaceId??'');
  });
}

export function dispatchQueuedForEnabledRoles(store: Store, projectId: string, now: number): { readonly dispatched: number; readonly blocked: number } {
  clock(now);
  return store.transaction(db => {
    // 复核修复：项目用户暂停不放行（stored保持可追踪）——与消息泵同一项目暂停栅栏
    const candidates = db.prepare("SELECT m.id AS id, m.to_role_id AS to_role_id FROM messages m JOIN roles r ON r.id=m.to_role_id AND r.project_id=m.project_id JOIN projects p ON p.id=m.project_id AND p.user_paused=0 WHERE m.project_id=? AND m.state='stored' AND r.desired_state='enabled' ORDER BY m.created_at, m.id LIMIT 200").all(projectId) as { id: string; to_role_id: string }[];
    let dispatched = 0;
    for (const candidate of candidates) {
      const row = db.prepare("SELECT delivery_json FROM messages WHERE id=? AND project_id=? AND state='stored'").get(candidate.id, projectId) as { delivery_json: string } | undefined;
      if (!row) continue;
      const delivery = JSON.parse(String(row.delivery_json)) as { transitions: { state: string; at: number }[] };
      delivery.transitions.push({ state: "queued", at: now });
      const changed = db.prepare("UPDATE messages SET state='queued',delivery_json=? WHERE id=? AND project_id=? AND state='stored'").run(JSON.stringify(delivery), candidate.id, projectId);
      dispatched += Number(changed.changes);
    }
    const blocked = Number(db.prepare("SELECT COUNT(*) AS n FROM messages m JOIN roles r ON r.id=m.to_role_id AND r.project_id=m.project_id WHERE m.project_id=? AND m.state='stored' AND r.desired_state!='enabled'").get(projectId)?.n);
    return Object.freeze({ dispatched, blocked });
  });
}

/** 唤醒待办清单：各启用角色当前stored积压计数（唤醒适配器决定是否唤醒原生会话——T025正式任务）。 */
export function wakeBacklog(store: Store, projectId: string): readonly { readonly roleId: string; readonly stored: number }[] {
  return Object.freeze((store.db.prepare("SELECT m.to_role_id AS roleId, COUNT(*) AS stored FROM messages m JOIN roles r ON r.id=m.to_role_id AND r.project_id=m.project_id WHERE m.project_id=? AND m.state='stored' AND r.desired_state='enabled' GROUP BY m.to_role_id ORDER BY m.to_role_id").all(projectId) as { roleId: string; stored: number }[]).map(row => Object.freeze({ roleId: String(row.roleId), stored: Number(row.stored) })));
}

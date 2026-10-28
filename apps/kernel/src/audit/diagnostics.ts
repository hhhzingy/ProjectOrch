/** T049准备切片：审计脱敏与诊断导出。诊断包=元数据导出（事件/命令/消息/变更集），默认**不含**任何正文、凭据原文或payload内容；
 * 消息正文仅以长度+摘要表示（可核对不可复原）；导出为确定性JSON（排序+稳定键序），供用户审阅与诊断分发。 */
import { createHash } from "node:crypto";
import type { Store } from "@projectorch/persistence";

export interface DiagnosticBundle {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly exportedAt: number;
  readonly redacted: true;
  readonly eventWatermark: number;
  readonly events: readonly { readonly sequence: number; readonly type: string; readonly entityId: string; readonly entityRevision: number; readonly causationId: string | null; readonly occurredAt: number }[];
  readonly commands: readonly { readonly id: string; readonly type: string; readonly state: string; readonly createdAt: number }[];
  readonly messages: readonly { readonly id: string; readonly toRoleId: string; readonly kind: string; readonly state: string; readonly bodyLength: number; readonly bodyDigest: string; readonly createdAt: number }[];
  readonly changesets: readonly { readonly id: string; readonly state: string; readonly expectedPlanRevision: number }[];
}

/** 摘要：正文以SHA-256前16位表示（可核对相同内容，不可复原原文）。 */
export function contentDigest(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

/** 导出诊断包：projectId必须存在；不含正文/凭据/payload内容（结构上不查询这些列）。 */
export function exportDiagnosticBundle(store: Store, projectId: string, exportedAt: number): DiagnosticBundle {
  if (!Number.isSafeInteger(exportedAt) || exportedAt < 0) throw new Error("INVALID_EXPORT_TIME");
  if (!store.db.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)) throw new Error("EXPORT_PROJECT_NOT_FOUND");
  const eventWatermark = Number(store.db.prepare("SELECT COALESCE(MAX(sequence),0) AS n FROM events WHERE project_id=?").get(projectId)?.n);
  const events = (store.db.prepare("SELECT sequence,type,entity_id,entity_revision,causation_id,occurred_at FROM events WHERE project_id=? ORDER BY sequence").all(projectId) as Record<string, unknown>[]).map(row => ({ sequence: Number(row.sequence), type: String(row.type), entityId: String(row.entity_id), entityRevision: Number(row.entity_revision), causationId: row.causation_id === null ? null : String(row.causation_id), occurredAt: Number(row.occurred_at) }));
  const commands = (store.db.prepare("SELECT id,type,state,created_at FROM commands WHERE project_id=? ORDER BY created_at").all(projectId) as Record<string, unknown>[]).map(row => ({ id: String(row.id), type: String(row.type), state: String(row.state), createdAt: Number(row.created_at) }));
  const messages = (store.db.prepare("SELECT id,to_role_id,kind,state,body,created_at FROM messages WHERE project_id=? ORDER BY created_at").all(projectId) as Record<string, unknown>[]).map(row => { const body = String(row.body); return { id: String(row.id), toRoleId: String(row.to_role_id), kind: String(row.kind), state: String(row.state), bodyLength: body.length, bodyDigest: contentDigest(body), createdAt: Number(row.created_at) }; });
  const changesets = (store.db.prepare("SELECT id,state,expected_plan_revision FROM changesets WHERE project_id=? ORDER BY id").all(projectId) as Record<string, unknown>[]).map(row => ({ id: String(row.id), state: String(row.state), expectedPlanRevision: Number(row.expected_plan_revision) }));
  return Object.freeze({ schemaVersion: 1, projectId, exportedAt, redacted: true, eventWatermark, events: Object.freeze(events), commands: Object.freeze(commands), messages: Object.freeze(messages), changesets: Object.freeze(changesets) });
}

/** 确定性序列化：键序稳定（JSON.stringify对字符串键按插入序——导出对象均为字面量构造故稳定），供哈希比对。 */
export function serializeBundle(bundle: DiagnosticBundle): string {
  return JSON.stringify(bundle, null, 2) + "\n";
}

/** T038准备切片：交接记录与上下文包。prepare=按binding epoch+plan_revision打包上下文（目标水位/未完任务/关键消息摘要，不复制全部历史——A054"不依赖全部历史复制"）；
 * verify=验证者角色核对包完整性（binding epoch仍有效、plan_revision未漂移）→verified；
 * 绑定代次推进或plan漂移→stale（旧包显式过期，不误用）；consume=verified→consumed一次性消费。 */
import type { Store } from "@projectorch/persistence";

export interface HandoverPackage {
  readonly projectId: string;
  readonly roleId: string;
  readonly fromBindingEpoch: number;
  readonly planRevision: number;
  readonly eventWatermark: number;
  readonly openTaskIds: readonly string[];
  readonly recentMessageIds: readonly string[];
  readonly notes: string;
}

export interface HandoverView {
  readonly id: string;
  readonly projectId: string;
  readonly roleId: string;
  readonly revision: number;
  readonly fromBindingEpoch: number;
  readonly planRevision: number;
  readonly verifierRoleId: string;
  readonly state: "prepared" | "verified" | "consumed" | "stale";
}

const text = (value: unknown, label: string, max: number): string => {
  if (typeof value !== "string" || !value || value.length > max || /[\r\n\0]/.test(value)) throw new Error(`INVALID_HANDOVER_${label}`);
  return value;
};
const clock = (now: number): void => { if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_HANDOVER_TIME"); };

function viewOf(row: Record<string, unknown>): HandoverView {
  return Object.freeze({ id: String(row.id), projectId: String(row.project_id), roleId: String(row.role_id), revision: Number(row.revision), fromBindingEpoch: Number(row.from_binding_epoch), planRevision: Number(row.plan_revision), verifierRoleId: String(row.verifier_role_id), state: String(row.state) as HandoverView["state"] });
}

/** 生成交接包：打包时点的客观水位（事件MAX序列、未完任务、近期消息），显式声明binding epoch与plan_revision基准。 */
export function prepareHandover(store: Store, input: { readonly id: unknown; readonly projectId: unknown; readonly roleId: unknown; readonly fromBindingEpoch: unknown; readonly verifierRoleId: unknown; readonly notes: unknown; readonly recentMessageIds?: readonly unknown[] }, now: number): HandoverView {
  clock(now);
  const id = text(input.id, "ID", 128);
  const projectId = text(input.projectId, "PROJECT", 128);
  const roleId = text(input.roleId, "ROLE", 128);
  const verifierRoleId = text(input.verifierRoleId, "VERIFIER", 128);
  if (verifierRoleId === roleId) throw new Error("HANDOVER_VERIFIER_SELF");
  const fromBindingEpoch = input.fromBindingEpoch;
  if (typeof fromBindingEpoch !== "number" || !Number.isSafeInteger(fromBindingEpoch) || fromBindingEpoch < 1) throw new Error("INVALID_HANDOVER_EPOCH");
  const notes = text(input.notes, "NOTES", 16384);
  const recentMessageIds = (input.recentMessageIds ?? []).map(value => text(value, "MSGREF", 128));
  if (recentMessageIds.length > 64) throw new Error("INVALID_HANDOVER_MSGREFS");
  return store.transaction(db => {
    if (!db.prepare("SELECT 1 FROM roles WHERE id=? AND project_id=?").get(roleId, projectId)) throw new Error("HANDOVER_ROLE_NOT_FOUND");
    if (!db.prepare("SELECT 1 FROM roles WHERE id=? AND project_id=?").get(verifierRoleId, projectId)) throw new Error("HANDOVER_VERIFIER_NOT_FOUND");
    const binding = db.prepare("SELECT epoch FROM role_bindings WHERE role_id=? AND project_id=? AND ended_at IS NULL ORDER BY epoch DESC LIMIT 1").get(roleId, projectId) as { epoch: number } | undefined;
    if (!binding || Number(binding.epoch) !== fromBindingEpoch) throw new Error("HANDOVER_BINDING_NOT_CURRENT");
    const planRevision = Number(db.prepare("SELECT plan_revision FROM projects WHERE id=?").get(projectId)?.plan_revision);
    const eventWatermark = Number(db.prepare("SELECT COALESCE(MAX(sequence),0) AS n FROM events WHERE project_id=?").get(projectId)?.n);
    const openTaskIds = (db.prepare("SELECT id FROM tasks WHERE project_id=? AND state IN ('draft','ready','active','waiting','review','blocked') ORDER BY id LIMIT 128").all(projectId) as { id: string }[]).map(row => row.id);
    const validMessageIds = recentMessageIds.filter(messageId => !!db.prepare("SELECT 1 FROM messages WHERE id=? AND project_id=?").get(messageId, projectId));
    const pkg: HandoverPackage = { projectId, roleId, fromBindingEpoch, planRevision, eventWatermark, openTaskIds, recentMessageIds: validMessageIds, notes };
    db.prepare("INSERT INTO handovers(id,project_id,role_id,revision,from_binding_epoch,plan_revision,package_json,verifier_role_id,state) VALUES(?,?,?,1,?,?,?,?,'prepared')").run(id, projectId, roleId, fromBindingEpoch, planRevision, JSON.stringify(pkg), verifierRoleId);
    const row = db.prepare("SELECT id,project_id,role_id,revision,from_binding_epoch,plan_revision,verifier_role_id,state FROM handovers WHERE id=? AND project_id=?").get(id, projectId) as Record<string, unknown>;
    return viewOf(row);
  });
}

export interface ReadinessCheck { readonly fresh: boolean; readonly bindingEpochCurrent: boolean; readonly planRevisionCurrent: number }

/** 核对：binding epoch仍有效（角色当前活跃代次一致）且plan_revision未漂移→可verify。 */
export function checkHandoverFreshness(store: Store, projectId: string, handoverId: string): ReadinessCheck {
  const row = store.db.prepare("SELECT from_binding_epoch,plan_revision,role_id FROM handovers WHERE id=? AND project_id=?").get(handoverId, projectId) as { from_binding_epoch: number; plan_revision: number; role_id: string } | undefined;
  if (!row) throw new Error("HANDOVER_NOT_FOUND");
  const binding = store.db.prepare("SELECT epoch FROM role_bindings WHERE role_id=? AND project_id=? AND ended_at IS NULL ORDER BY epoch DESC LIMIT 1").get(String(row.role_id), projectId) as { epoch: number } | undefined;
  const bindingEpochCurrent = !!binding && Number(binding.epoch) === Number(row.from_binding_epoch);
  const planRevisionCurrent = Number(store.db.prepare("SELECT plan_revision FROM projects WHERE id=?").get(projectId)?.plan_revision);
  return Object.freeze({ fresh: bindingEpochCurrent && planRevisionCurrent === Number(row.plan_revision), bindingEpochCurrent, planRevisionCurrent });
}

/** 验证者核验通过：仅fresh可verify；验证者≠交接者（prepare已强制）。 */
export function verifyHandover(store: Store, projectId: string, handoverId: string, operatorRoleId: string, now: number): HandoverView {
  clock(now);
  // 预检在事务外（只读）；stale留痕用独立事务提交后再抛出——留痕不被回滚。
  const probe = store.db.prepare("SELECT verifier_role_id,state FROM handovers WHERE id=? AND project_id=?").get(handoverId, projectId) as { verifier_role_id: string; state: string } | undefined;
  if (!probe) throw new Error("HANDOVER_NOT_FOUND");
  if (String(probe.verifier_role_id) !== operatorRoleId) throw new Error("HANDOVER_NOT_VERIFIER");
  if (probe.state !== "prepared") throw new Error("HANDOVER_TRANSITION_REJECTED");
  const check = checkHandoverFreshness(store, projectId, handoverId);
  if (!check.fresh) {
    store.transaction(db => db.prepare("UPDATE handovers SET state='stale' WHERE id=? AND project_id=? AND state='prepared'").run(handoverId, projectId));
    throw new Error("HANDOVER_STALE");
  }
  return store.transaction(db => {
    db.prepare("UPDATE handovers SET state='verified',revision=revision+1 WHERE id=? AND project_id=? AND state='prepared'").run(handoverId, projectId);
    const updated = db.prepare("SELECT id,project_id,role_id,revision,from_binding_epoch,plan_revision,verifier_role_id,state FROM handovers WHERE id=? AND project_id=?").get(handoverId, projectId) as Record<string, unknown>;
    return viewOf(updated);
  });
}

/** 消费（绑定新会话的入口动作）：verified→consumed一次性；stale不可消费。 */
export function consumeHandover(store: Store, projectId: string, handoverId: string, now: number): HandoverView {
  clock(now);
  return store.transaction(db => {
    const row = db.prepare("SELECT state FROM handovers WHERE id=? AND project_id=?").get(handoverId, projectId) as { state: string } | undefined;
    if (!row) throw new Error("HANDOVER_NOT_FOUND");
    if (row.state !== "verified") throw new Error("HANDOVER_TRANSITION_REJECTED");
    db.prepare("UPDATE handovers SET state='consumed',revision=revision+1 WHERE id=? AND project_id=?").run(handoverId, projectId);
    const updated = db.prepare("SELECT id,project_id,role_id,revision,from_binding_epoch,plan_revision,verifier_role_id,state FROM handovers WHERE id=? AND project_id=?").get(handoverId, projectId) as Record<string, unknown>;
    return viewOf(updated);
  });
}

export function readHandoverPackage(store: Store, projectId: string, handoverId: string): HandoverPackage {
  const row = store.db.prepare("SELECT package_json FROM handovers WHERE id=? AND project_id=?").get(handoverId, projectId) as { package_json: string } | undefined;
  if (!row) throw new Error("HANDOVER_NOT_FOUND");
  return JSON.parse(String(row.package_json)) as HandoverPackage;
}

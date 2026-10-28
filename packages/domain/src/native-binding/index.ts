/** T015准备切片：原生绑定与会话接替域。绑定=角色×原生会话×binding epoch（接替代次）；
 * 接替=旧绑定end+新绑定start（epoch+1），旧代凭据全部撤销，交接包消费核对；
 * 单owner=同session同task同时仅一个活跃绑定（session-lease语义域层镜像）。 */
import type { Store } from "@projectorch/persistence";

export interface NativeBinding {
  readonly bindingId: string;
  readonly projectId: string;
  readonly roleId: string;
  readonly sessionId: string;
  readonly epoch: number;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

const text = (value: unknown, label: string, max: number): string => {
  if (typeof value !== "string" || !value || value.length > max || /[\r\n\0]/.test(value)) throw new Error(`INVALID_NB_${label}`);
  return value;
};
const clock = (now: number): void => { if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_NB_TIME"); };

export interface SuccessionResult {
  readonly oldBinding: { readonly bindingId: string; readonly epoch: number; readonly endedAt: number };
  readonly newBinding: NativeBinding;
  readonly revokedCredentials: number;
}

/** 接替：同角色同session——旧活跃绑定end、同session新绑定start（epoch=max+1）、旧代凭据全部撤销；
 * 若存在verified交接包（同角色），要求已consumed才可接替（R016交接资料先行）；无交接包允许直接接替（用户直接接替路径）。 */
export function succeedBinding(store: Store, input: { readonly newBindingId: unknown; readonly projectId: unknown; readonly roleId: unknown; readonly sessionId: unknown; readonly handoverId?: unknown }, now: number): SuccessionResult {
  clock(now);
  const newBindingId = text(input.newBindingId, "ID", 128);
  const projectId = text(input.projectId, "PROJECT", 128);
  const roleId = text(input.roleId, "ROLE", 128);
  const sessionId = text(input.sessionId, "SESSION", 128);
  const handoverId = input.handoverId === undefined || input.handoverId === null ? null : text(input.handoverId, "HANDOVER", 128);
  return store.transaction(db => succeedBindingWithin(db,{newBindingId,projectId,roleId,sessionId,handoverId},now));
}

/** 已校验输入的事务内接替，供固定命令原子消费交接包及登记来源，不启动原生进程。 */
export function succeedBindingWithin(db:Store['db'],input:{newBindingId:string;projectId:string;roleId:string;sessionId:string;handoverId:string|null},now:number):SuccessionResult{
  if(!db.isTransaction)throw Error('NB_TRANSACTION_REQUIRED');clock(now);
  const {newBindingId,projectId,roleId,sessionId,handoverId}=input;
    if (!db.prepare("SELECT 1 FROM roles WHERE id=? AND project_id=?").get(roleId, projectId)) throw new Error("NB_ROLE_NOT_FOUND");
    if (!db.prepare("SELECT 1 FROM sessions WHERE id=?").get(sessionId)) throw new Error("NB_SESSION_NOT_FOUND");
    const current = db.prepare("SELECT id,epoch,started_at FROM role_bindings WHERE role_id=? AND project_id=? AND ended_at IS NULL ORDER BY epoch DESC LIMIT 1").get(roleId, projectId) as { id: string; epoch: number; started_at: number } | undefined;
    if (!current) throw new Error("NB_NO_ACTIVE_BINDING");
    const oldEpoch = Number(current.epoch);
    if (now < Number(current.started_at) || db.prepare("SELECT 1 FROM agent_credentials WHERE binding_id=? AND created_at>?").get(current.id, now)) throw new Error("INVALID_NB_TIME");
    if (!Number.isSafeInteger(oldEpoch + 1)) throw new Error("NB_EPOCH_EXHAUSTED");
    if (db.prepare("SELECT 1 FROM attempts a JOIN role_bindings b ON b.id=a.binding_id AND b.project_id=a.project_id WHERE b.role_id=? AND b.project_id=? AND a.state IN ('dispatching','running','waiting_input','unknown') LIMIT 1").get(roleId, projectId)) throw new Error("NB_EXECUTION_UNRESOLVED");
    if (handoverId !== null) {
      const handover = db.prepare("SELECT from_binding_epoch,plan_revision,state FROM handovers WHERE id=? AND project_id=? AND role_id=?").get(handoverId, projectId, roleId);
      const plan = db.prepare("SELECT plan_revision FROM projects WHERE id=?").get(projectId);
      if (!handover || handover.state !== "consumed" || handover.from_binding_epoch !== oldEpoch || handover.plan_revision !== plan?.plan_revision) throw new Error("NB_HANDOVER_NOT_CURRENT");
    }
    // 交接包核对（R016）：存在prepared/verified交接包且未消费→要求先消费（handover先于接替）
    const pendingHandover = db.prepare("SELECT id,state FROM handovers WHERE project_id=? AND role_id=? AND state IN ('prepared','verified') LIMIT 1").get(projectId, roleId) as { id: string; state: string } | undefined;
    if (pendingHandover) throw new Error(`NB_HANDOVER_PENDING:${pendingHandover.id}:${pendingHandover.state}`);
    const endedAt = now;
    db.prepare("UPDATE role_bindings SET ended_at=? WHERE id=? AND project_id=? AND ended_at IS NULL").run(endedAt, current.id, projectId);
    const newEpoch = oldEpoch + 1;
    db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES(?,?,?,?,?,?)").run(newBindingId, projectId, roleId, sessionId, newEpoch, now);
    // 旧代凭据全部撤销
    const revoked = db.prepare("UPDATE agent_credentials SET revoked_at=? WHERE binding_id=? AND binding_epoch=? AND revoked_at IS NULL").run(now, current.id, oldEpoch).changes;
    db.prepare("UPDATE roles SET binding_state='provisioning',model_effective_json=NULL,revision=revision+1 WHERE id=? AND project_id=?").run(roleId, projectId);
    db.prepare("INSERT INTO role_revisions(role_id,project_id,revision,snapshot_json) SELECT id,project_id,revision,json_object('desiredState',desired_state,'bindingState',binding_state,'bindingEpoch',?) FROM roles WHERE id=? AND project_id=?").run(newEpoch, roleId, projectId);
    return Object.freeze({
      oldBinding: Object.freeze({ bindingId: String(current.id), epoch: oldEpoch, endedAt }),
      newBinding: Object.freeze({ bindingId: newBindingId, projectId, roleId, sessionId, epoch: newEpoch, startedAt: now, endedAt: null }),
      revokedCredentials: Number(revoked),
    });
}

export function readActiveBinding(store: Store, projectId: string, roleId: string): NativeBinding | null {
  const row = store.db.prepare("SELECT id,project_id,role_id,session_id,epoch,started_at,ended_at FROM role_bindings WHERE role_id=? AND project_id=? AND ended_at IS NULL LIMIT 1").get(roleId, projectId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return Object.freeze({ bindingId: String(row.id), projectId: String(row.project_id), roleId: String(row.role_id), sessionId: String(row.session_id), epoch: Number(row.epoch), startedAt: Number(row.started_at), endedAt: null });
}

/** 首次绑定（A089闭环入口）：角色desired=enabled且binding_state=unbound且无活跃绑定才可建立（epoch=1）。
 * 已有活跃绑定走succeedBinding接替；绑定后实际状态仍由启动握手推进（此处不动binding_state）。 */
export function establishFirstBinding(store: Store, input: { readonly bindingId: unknown; readonly projectId: unknown; readonly roleId: unknown; readonly sessionId: unknown }, now: number): NativeBinding {
  clock(now);
  const bindingId = text(input.bindingId, "ID", 128);
  const projectId = text(input.projectId, "PROJECT", 128);
  const roleId = text(input.roleId, "ROLE", 128);
  const sessionId = text(input.sessionId, "SESSION", 128);
  return store.transaction(db => {
    const role = db.prepare("SELECT desired_state,binding_state FROM roles WHERE id=? AND project_id=?").get(roleId, projectId) as { desired_state: string; binding_state: string } | undefined;
    if (!role) throw new Error("NB_ROLE_NOT_FOUND");
    if (!db.prepare("SELECT 1 FROM sessions WHERE id=?").get(sessionId)) throw new Error("NB_SESSION_NOT_FOUND");
    if (role.desired_state !== "enabled") throw new Error("NB_ROLE_NOT_ENABLED");
    if (role.binding_state !== "unbound") throw new Error("NB_ROLE_ALREADY_BOUND");
    const active = db.prepare("SELECT 1 FROM role_bindings WHERE role_id=? AND project_id=? AND ended_at IS NULL").get(roleId, projectId);
    if (active) throw new Error("NB_ALREADY_ACTIVE");
    db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES(?,?,?,?,1,?)").run(bindingId, projectId, roleId, sessionId, now);
    return Object.freeze({ bindingId, projectId, roleId, sessionId, epoch: 1, startedAt: now, endedAt: null });
  });
}

/** 单owner核验：同session的活跃绑定至多一个（跨角色）。 */
export function assertSingleOwner(store: Store, sessionId: string): void {
  const count = Number(store.db.prepare("SELECT COUNT(*) AS n FROM role_bindings WHERE session_id=? AND ended_at IS NULL").get(sessionId)?.n);
  if (count > 1) throw new Error("NB_MULTIPLE_OWNERS");
}

/** T014准备切片：角色生命周期。意图（desired_state）与实际（binding_state）分离：意图写入不触碰实际状态，不能用状态字段伪造停止；停用不删除任何记录，任务归属保留；全部变更版本化快照。 */
import { randomUUID } from "node:crypto";
import type { Store } from "@projectorch/persistence";

export type RoleDesiredState = "enabled" | "paused" | "disabled";
export const ROLE_MAX_DEPTH = 8;

export interface RoleView {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly charter: string;
  readonly parentId: string | null;
  readonly permissionProfileId: string;
  readonly desiredState: RoleDesiredState;
  readonly bindingState: "unbound" | "provisioning" | "ready" | "error";
  readonly revision: number;
}

const text = (value: unknown, label: string, max: number): string => {
  if (typeof value !== "string" || !value || value.length > max || /[\r\n\0]/.test(value)) throw new Error(`INVALID_ROLE_${label}`);
  return value;
};
const clock = (now: number): void => { if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_ROLE_TIME"); };
function viewOf(row: Record<string, unknown>): RoleView {
  return Object.freeze({ id: String(row.id), projectId: String(row.project_id), name: String(row.name), charter: String(row.charter), parentId: row.parent_id === null ? null : String(row.parent_id), permissionProfileId: String(row.permission_profile), desiredState: String(row.desired_state) as RoleDesiredState, bindingState: String(row.binding_state) as RoleView["bindingState"], revision: Number(row.revision) });
}
function roleRow(store: Store, projectId: string, roleId: string): Record<string, unknown> {
  return roleRowDb(store.db, projectId, roleId);
}
function roleRowDb(db: Store["db"], projectId: string, roleId: string): Record<string, unknown> {
  const row = db.prepare("SELECT id,project_id,name,charter,parent_id,permission_profile,permission_profile_revision,scope_paths_json,desired_state,binding_state,revision FROM roles WHERE id=? AND project_id=?").get(roleId, projectId);
  if (!row) throw new Error("ROLE_NOT_FOUND");
  return row as Record<string, unknown>;
}
function revise(db: Store["db"], projectId: string, roleId: string, row: Record<string, unknown>): void {
  const revision = Number(row.revision);
  db.prepare("UPDATE roles SET revision=? WHERE id=? AND project_id=?").run(revision, roleId, projectId);
  const snapshot = { id: row.id, name: row.name, charter: row.charter, parentId: row.parent_id, permissionProfile: row.permission_profile, permissionProfileRevision: row.permission_profile_revision, scopePaths: JSON.parse(String(row.scope_paths_json)), desiredState: row.desired_state, bindingState: row.binding_state };
  db.prepare("INSERT INTO role_revisions(role_id,project_id,revision,snapshot_json) VALUES(?,?,?,?)").run(roleId, projectId, revision, JSON.stringify(snapshot));
}

/** 建立角色：层级同项目内、无环、深度受限；初始 revision 1 快照。 */
export function createRole(store: Store, input: { readonly id: unknown; readonly projectId: unknown; readonly name: unknown; readonly charter: unknown; readonly permissionProfileId: unknown; readonly parentId?: unknown }, now: number): RoleView {
  clock(now);
  const id = text(input.id, "ID", 128);
  const projectId = text(input.projectId, "PROJECT", 128);
  const name = text(input.name, "NAME", 512);
  const charter = text(input.charter, "CHARTER", 8192);
  const profileId = text(input.permissionProfileId, "PROFILE", 128);
  const parentId = input.parentId === undefined || input.parentId === null ? null : text(input.parentId, "PARENT", 128);
  return store.transaction(db => createRoleWithin(db, { id, projectId, name, charter, permissionProfileId: profileId, parentId }, now));
}

/** 事务内变体：供变更集/命令runner等已持有打开事务的受信调用方复用。 */
export function createRoleWithin(db: Store["db"], input: { readonly id: string; readonly projectId: string; readonly name: string; readonly charter: string; readonly permissionProfileId: string; readonly parentId: string | null; readonly permissionProfileRevision?: number; readonly scopePaths?: readonly string[] }, now: number): RoleView {
  clock(now);
  {
    const id = input.id;
    const projectId = input.projectId;
    const name = input.name;
    const charter = input.charter;
    const profileId = input.permissionProfileId;
    const parentId = input.parentId;
    if (!db.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)) throw new Error("ROLE_PROJECT_NOT_FOUND");
    if (parentId !== null) {
      const parent = roleRowDb(db, projectId, parentId);
      let depth = 1;
      let cursor: string | null = String(parent.parent_id ?? "");
      while (cursor) { depth += 1; if (depth > ROLE_MAX_DEPTH) throw new Error("ROLE_DEPTH_EXCEEDED"); if (cursor === id) throw new Error("ROLE_CYCLE_REJECTED"); const next = roleRowDb(db, projectId, cursor); cursor = next.parent_id === null ? null : String(next.parent_id); }
      if (parent.id === id) throw new Error("ROLE_CYCLE_REJECTED");
    }
    db.prepare("INSERT INTO roles(id,project_id,name,charter,parent_id,permission_profile,permission_profile_revision,scope_paths_json,desired_state,binding_state,revision) VALUES(?,?,?,?,?,?,?,?,'enabled','unbound',1)").run(id, projectId, name, charter, parentId, profileId, input.permissionProfileRevision ?? 0, JSON.stringify(input.scopePaths ?? []));
    revise(db, projectId, id, roleRowDb(db, projectId, id));
    return viewOf(roleRowDb(db, projectId, id));
  }
}

/** 意图转换白名单：enabled↔paused、→disabled、disabled→enabled（R003 重新启用）。
 * 重新启用只恢复意图；已结束的绑定与已撤销的凭据不因意图字段自动恢复（binding_state 原样保留，适配器需重新走绑定流程）。 */
const transitions: Record<RoleDesiredState, readonly RoleDesiredState[]> = { enabled: ["paused", "disabled"], paused: ["enabled", "disabled"], disabled: ["enabled"] };

/** 写入启用/暂停/停用意图：只改 desired_state 并快照；binding_state（实际）原样保留——状态字段不伪造停止。 */
export function setRoleDesiredState(store: Store, projectId: string, roleId: string, next: RoleDesiredState, now: number): RoleView {
  clock(now);
  if (!["enabled", "paused", "disabled"].includes(next)) throw new Error("INVALID_ROLE_STATE");
  return store.transaction(db => setRoleDesiredStateWithin(db, projectId, roleId, next, now));
}

export function setRoleDesiredStateWithin(db: Store["db"], projectId: string, roleId: string, next: RoleDesiredState, now: number): RoleView {
  clock(now);
  if (!["enabled", "paused", "disabled"].includes(next)) throw new Error("INVALID_ROLE_STATE");
  {
    const row = roleRowDb(db, projectId, roleId);
    const current = String(row.desired_state) as RoleDesiredState;
    if (current === next) throw new Error("ROLE_STATE_UNCHANGED");
    if (!transitions[current].includes(next)) throw new Error("ROLE_TRANSITION_REJECTED");
    const bindingBefore = String(row.binding_state);
    db.prepare("UPDATE roles SET desired_state=?,revision=? WHERE id=? AND project_id=?").run(next, Number(row.revision) + 1, roleId, projectId);
    revise(db, projectId, roleId, roleRowDb(db, projectId, roleId));
    const after = roleRowDb(db, projectId, roleId);
    if (String(after.binding_state) !== bindingBefore) throw new Error("ROLE_INTENT_LEAKED_TO_ACTUAL");
    return viewOf(after);
  }
}

export function readRole(store: Store, projectId: string, roleId: string): RoleView {
  return viewOf(roleRow(store, projectId, roleId));
}

/** 重启恢复：全部历史快照重读；停用角色仍存在（不删除）。 */
export function roleHistory(store: Store, projectId: string, roleId: string): readonly { readonly revision: number; readonly snapshot: { readonly desiredState: RoleDesiredState; readonly bindingState: RoleView["bindingState"] } }[] {
  const rows = store.db.prepare("SELECT revision,snapshot_json FROM role_revisions WHERE role_id=? AND project_id=? ORDER BY revision").all(roleId, projectId);
  return Object.freeze(rows.map(row => { const snapshot = JSON.parse(String(row.snapshot_json)); return Object.freeze({ revision: Number(row.revision), snapshot: Object.freeze({ desiredState: snapshot.desiredState, bindingState: snapshot.bindingState }) }); }));
}

/** 停用后的待办归属核对：任务行与角色关联原样保留，不因停用被清除或改派。 */
export function roleTaskOwnershipIntact(store: Store, projectId: string, roleId: string): boolean {
  if (!store.db.prepare("SELECT 1 FROM roles WHERE id=? AND project_id=?").get(roleId, projectId)) throw new Error("ROLE_NOT_FOUND");
  const orphan = store.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id=? AND role_id IS NOT NULL AND role_id NOT IN (SELECT id FROM roles WHERE project_id=?)").get(projectId, projectId);
  return Number(orphan?.n ?? 0) === 0;
}

/** T043：项目角色清单（Web导航只读投影）：期望(desired)与观测(binding)状态分离并列，停用角色保留在列（历史可查）。 */
export function listRolesWithStates(store: Store, projectId: string): readonly {readonly roleId:string;readonly name:string;readonly parentId:string|null;readonly desiredState:RoleDesiredState;readonly bindingState:RoleView['bindingState'];readonly revision:number;readonly modelRevision:number}[]{
  const rows = store.db.prepare("SELECT id,name,parent_id,desired_state,binding_state,revision,model_preference_revision FROM roles WHERE project_id=? ORDER BY id").all(projectId) as Record<string, unknown>[];
  return Object.freeze(rows.map(row => Object.freeze({ roleId: String(row.id), name: String(row.name), parentId: row.parent_id === null ? null : String(row.parent_id), desiredState: String(row.desired_state) as RoleDesiredState, bindingState: String(row.binding_state) as RoleView["bindingState"], revision: Number(row.revision),modelRevision:Number(row.model_preference_revision) })));
}

/** T115（PR2-W2）：角色模型偏好三态（F07）。
 * requested=用户原文（"6.1sol 极高"）不猜测替换；resolved=按目标版本能力映射（含依据引用）；
 * effective以实际执行回执为准（不入角色表）。修改版本化留痕。 */
export interface ModelRequested { readonly raw: string; readonly recordedAt: number }
export interface ModelResolved { readonly modelId: string | null; readonly reasoningLevel: string | null; readonly basis: string; readonly resolvedAt: number }

export function setRoleModelPreference(store: Store, projectId: string, roleId: string, requested: ModelRequested, resolved: ModelResolved | null): void {
  store.transaction(db=>setRoleModelPreferenceWithin(db,projectId,roleId,requested,resolved,requested.recordedAt));
}

/** 配置独立版本；职责/权限和原生启动锚点保持其自身版本，旧排队输入由配置快照拒绝。 */
export function setRoleModelPreferenceWithin(db:Store['db'],projectId:string,roleId:string,requested:ModelRequested|null,resolved:ModelResolved|null,now:number,context:{expectedRevision?:number;expectedModelRevision?:number;commandId?:string;sourcePrincipalId?:string}={}):{revision:number;modelRevision:number}{
  if(!db.isTransaction)throw new Error('MODEL_CONFIGURATION_TRANSACTION_REQUIRED');clock(now);
  if(requested===null&&resolved!==null)throw new Error('INVALID_MODEL_PREFERENCE');
  if(requested&&(typeof requested.raw!=='string'||!requested.raw.trim()||requested.raw.length>512||!Number.isSafeInteger(requested.recordedAt)||requested.recordedAt<0))throw new Error('INVALID_MODEL_PREFERENCE');
  if(resolved&&((resolved.modelId!==null&&(typeof resolved.modelId!=='string'||!resolved.modelId||resolved.modelId.length>128))||(resolved.reasoningLevel!==null&&(typeof resolved.reasoningLevel!=='string'||!resolved.reasoningLevel||resolved.reasoningLevel.length>32))||(!resolved.modelId&&!resolved.reasoningLevel)))throw new Error('INVALID_MODEL_PREFERENCE');
  const row=db.prepare('SELECT revision,model_preference_revision,model_effective_json FROM roles WHERE id=? AND project_id=?').get(roleId,projectId);
  if(!row)throw new Error('ROLE_NOT_FOUND');
  if(context.expectedRevision!==undefined&&row.revision!==context.expectedRevision)throw new Error('REVISION_CONFLICT');
  if(context.expectedModelRevision!==undefined&&row.model_preference_revision!==context.expectedModelRevision)throw new Error('MODEL_REVISION_CONFLICT');
  if(context.commandId&&!db.prepare("SELECT 1 FROM commands WHERE id=? AND project_id=? AND source_principal_id=? AND type='role.model_preference.configure' AND state='stored'").get(context.commandId,projectId,context.sourcePrincipalId??''))throw new Error('MODEL_COMMAND_SOURCE_MISMATCH');
  const revision=Number(row.revision),modelRevision=Number(row.model_preference_revision)+1;
  const requestedJson=requested===null?null:JSON.stringify(requested),resolvedJson=resolved===null?null:JSON.stringify(resolved);
  db.prepare('UPDATE roles SET model_requested_json=?,model_resolved_json=?,model_effective_json=NULL,model_preference_revision=? WHERE id=? AND project_id=?').run(requestedJson,resolvedJson,modelRevision,roleId,projectId);
  db.prepare('INSERT INTO role_model_revisions(project_id,role_id,revision,role_revision,requested_json,resolved_json,previous_effective_json,command_id,source_principal_id,recorded_at,origin) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(projectId,roleId,modelRevision,revision,requestedJson,resolvedJson,row.model_effective_json as string|null,context.commandId??null,context.sourcePrincipalId??null,now,context.commandId?'user_command':'trusted_internal');
  db.prepare("INSERT INTO events(id,project_id,type,entity_id,entity_revision,causation_id,body_json,occurred_at) VALUES(?,?,'role.model_preference.updated',?,?,?,?,?)").run(`ev-${randomUUID()}`,projectId,roleId,modelRevision,context.commandId??null,JSON.stringify({roleRevision:revision,modelRevision,resetToDefault:requested===null,strictMappingPresent:resolved!==null,nativeExecution:'not_asserted'}),now);
  return {revision,modelRevision};
}

/** 执行侧生效模型权威观察（工厂建会话后经app-server resume读回的modelId——非用户自报）。 */
export interface ModelEffective { readonly modelId: string; readonly providerId: string | null; readonly observedAt: number; readonly basis: "session-authoritative"|"turn-authoritative";readonly turnId?:string; }
export function recordModelEffective(store: Store, projectId: string, roleId: string, effective: ModelEffective,expectedModelRevision?:number): void {
  if (!effective?.modelId || typeof effective.modelId !== "string" || effective.modelId.length > 128) throw new Error("INVALID_MODEL_EFFECTIVE");
  store.transaction(db => {
    if (!db.prepare("SELECT 1 FROM roles WHERE id=? AND project_id=?").get(roleId, projectId)) throw new Error("ROLE_NOT_FOUND");
    if(expectedModelRevision!==undefined&&db.prepare('SELECT model_preference_revision FROM roles WHERE id=? AND project_id=?').get(roleId,projectId)?.model_preference_revision!==expectedModelRevision)throw new Error('MODEL_OBSERVATION_CONFIG_CHANGED');
    db.prepare("UPDATE roles SET model_effective_json=? WHERE id=? AND project_id=?").run(JSON.stringify(effective), roleId, projectId);
  });
}
export function readRoleModelEffective(store: Store, projectId: string, roleId: string): ModelEffective | null {
  const row = store.db.prepare("SELECT model_effective_json FROM roles WHERE id=? AND project_id=?").get(roleId, projectId) as { model_effective_json: string | null } | undefined;
  if (!row?.model_effective_json) return null;
  return JSON.parse(String(row.model_effective_json)) as ModelEffective;
}

export function readRoleModelPreference(store: Store, projectId: string, roleId: string): { readonly revision:number;readonly modelRevision:number;readonly requested: ModelRequested | null; readonly resolved: ModelResolved | null } {
  const row = store.db.prepare("SELECT revision,model_preference_revision,model_requested_json,model_resolved_json FROM roles WHERE id=? AND project_id=?").get(roleId, projectId) as {revision:number;model_preference_revision:number; model_requested_json: string | null; model_resolved_json: string | null } | undefined;
  if (!row) throw new Error("ROLE_NOT_FOUND");
  return {
    revision:Number(row.revision),modelRevision:Number(row.model_preference_revision),
    requested: row.model_requested_json === null ? null : JSON.parse(String(row.model_requested_json)) as ModelRequested,
    resolved: row.model_resolved_json === null ? null : JSON.parse(String(row.model_resolved_json)) as ModelResolved,
  };
}

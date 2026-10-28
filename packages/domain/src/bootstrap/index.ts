/** T067：首次接入（role.bootstrap幂等重试）与启动握手（role.startup_ack版本门槛）。
 * bootstrap：同requestId重试幂等回放（回执丢失可恢复）；未核验前binding_state保持unbound（不ready）；
 * startup_ack：角色/绑定代次/协议/策略/计划/任务规格六类版本逐一核验，任一不符显式拒绝（旧版本/旧绑定拒绝启动），全部一致才置ready。 */
import type { Store } from "@projectorch/persistence";
import { createRoleWithin, type RoleView } from "../roles/index.js";

type Db = Store["db"];

function viewOf(row: Record<string, unknown>): RoleView {
  return Object.freeze({ id: String(row.id), projectId: String(row.project_id), name: String(row.name), charter: String(row.charter), parentId: row.parent_id === null ? null : String(row.parent_id), permissionProfileId: String(row.permission_profile), desiredState: String(row.desired_state) as RoleView["desiredState"], bindingState: String(row.binding_state) as RoleView["bindingState"], revision: Number(row.revision) });
}

function roleRow(db: Db, projectId: string, roleId: string): Record<string, unknown> {
  const row = db.prepare("SELECT id,project_id,name,charter,parent_id,permission_profile,permission_profile_revision,desired_state,binding_state,startup_protocol_version,revision FROM roles WHERE id=? AND project_id=?").get(roleId, projectId) as Record<string, unknown> | undefined;
  if (!row) throw new Error("ROLE_NOT_FOUND");
  return row;
}

export interface BootstrapResult {
  readonly role: RoleView;
  readonly bootstrapState: "provisioning";
  readonly replay: boolean;
}

/** 首次接入：同事务创建角色+bootstrap登记。同principal+requestId重试→幂等回放；不同请求重复bootstrap→显式拒绝。 */
export function bootstrapRoleWithin(db: Db, input: { readonly projectId: string; readonly localRef: string; readonly name: string; readonly charter: string; readonly permissionProfileId: string; readonly permissionProfileRevision: number; readonly expectedPolicyRevision: number; readonly principalId: string; readonly requestId: string }, now: number): BootstrapResult {
  if (!Number.isSafeInteger(input.permissionProfileRevision) || input.permissionProfileRevision < 0) throw new Error("INVALID_PROFILE_REVISION");
  if (!Number.isSafeInteger(input.expectedPolicyRevision) || input.expectedPolicyRevision < 0) throw new Error("INVALID_POLICY_REVISION");
  const project = db.prepare("SELECT policy_revision FROM projects WHERE id=?").get(input.projectId) as { policy_revision: number } | undefined;
  if (!project) throw new Error("BOOTSTRAP_PROJECT_NOT_FOUND");
  if (Number(project.policy_revision) !== input.expectedPolicyRevision) throw new Error("POLICY_REVISION_CONFLICT");
  const existing = db.prepare("SELECT role_id FROM project_bootstrap WHERE project_id=?").get(input.projectId) as { role_id: string } | undefined;
  if (existing !== undefined) {
    const same = db.prepare("SELECT 1 FROM project_bootstrap WHERE project_id=? AND principal_id=? AND request_id=?").get(input.projectId, input.principalId, input.requestId);
    if (!same) throw new Error("BOOTSTRAP_ALREADY_EXISTS");
    return { role: viewOf(roleRow(db, input.projectId, String(existing.role_id))), bootstrapState: "provisioning", replay: true };
  }
  const role = createRoleWithin(db, { id: input.localRef, projectId: input.projectId, name: input.name, charter: input.charter, permissionProfileId: input.permissionProfileId, parentId: null }, now);
  db.prepare("UPDATE roles SET permission_profile_revision=? WHERE id=? AND project_id=?").run(input.permissionProfileRevision, input.localRef, input.projectId);
  db.prepare("INSERT INTO project_bootstrap(project_id,role_id,principal_id,request_id,state) VALUES(?,?,?,?,'provisioning')").run(input.projectId, input.localRef, input.principalId, input.requestId);
  return { role: viewOf(roleRow(db, input.projectId, input.localRef)), bootstrapState: "provisioning", replay: false };
}

export function bootstrapRole(store: Store, input: Parameters<typeof bootstrapRoleWithin>[1], now: number): BootstrapResult {
  return store.transaction(db => bootstrapRoleWithin(db, input, now));
}

export interface StartupAckInput {
  readonly projectId: string;
  readonly roleId: string;
  readonly bindingEpoch: number;
  readonly protocolVersion: number;
  readonly policyRevision: number;
  readonly planRevision: number;
  readonly roleRevision: number;
  readonly taskSpecRevisions: readonly { readonly taskId: string; readonly specRevision: number }[];
}

/** 启动握手：六类版本门槛全部通过才置binding_state=ready；任何不符显式拒绝且不部分生效（单事务）。 */
export function completeStartupAckWithin(db: Db, input: StartupAckInput, now: number): RoleView {
  const role = roleRow(db, input.projectId, input.roleId);
  if (Number(role.revision) !== input.roleRevision) throw new Error("STARTUP_ROLE_REVISION_MISMATCH");
  const protocol = role.startup_protocol_version === null || role.startup_protocol_version === undefined ? null : Number(role.startup_protocol_version);
  if (input.protocolVersion !== 2) throw new Error("STARTUP_PROTOCOL_VERSION_MISMATCH");
  if (protocol !== null && protocol !== input.protocolVersion) throw new Error("STARTUP_PROTOCOL_VERSION_MISMATCH");
  if (!db.isTransaction || !Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_STARTUP_TRANSACTION");
  const binding = db.prepare("SELECT id,epoch,started_at FROM role_bindings WHERE project_id=? AND role_id=? AND ended_at IS NULL ORDER BY epoch DESC LIMIT 1").get(input.projectId, input.roleId) as { id: string; epoch: number; started_at: number } | undefined;
  if (!binding) throw new Error("STARTUP_NOT_BOUND");
  if (Number(binding.epoch) !== input.bindingEpoch) throw new Error("STARTUP_BINDING_EPOCH_MISMATCH");
  if (now < binding.started_at) throw new Error("INVALID_STARTUP_TIME");
  const project = db.prepare("SELECT policy_revision,plan_revision FROM projects WHERE id=?").get(input.projectId) as { policy_revision: number; plan_revision: number };
  if (Number(project.policy_revision) !== input.policyRevision) throw new Error("STARTUP_POLICY_REVISION_MISMATCH");
  if (Number(project.plan_revision) !== input.planRevision) throw new Error("STARTUP_PLAN_REVISION_MISMATCH");
  for (const entry of input.taskSpecRevisions) {
    const task = db.prepare("SELECT spec_revision FROM tasks WHERE id=? AND project_id=?").get(String(entry.taskId), input.projectId) as { spec_revision: number } | undefined;
    if (!task) throw new Error(`STARTUP_TASK_NOT_FOUND:${String(entry.taskId)}`);
    if (Number(task.spec_revision) !== entry.specRevision) throw new Error(`STARTUP_TASK_SPEC_REVISION_MISMATCH:${String(entry.taskId)}`);
  }
  db.prepare("UPDATE roles SET binding_state='ready',startup_protocol_version=?,revision=revision+1 WHERE id=? AND project_id=?").run(input.protocolVersion, input.roleId, input.projectId);
  db.prepare("UPDATE project_bootstrap SET state='ready' WHERE project_id=? AND role_id=?").run(input.projectId,input.roleId);
  db.prepare("INSERT INTO role_startup_acks(binding_id,project_id,binding_epoch,role_revision,policy_revision,plan_revision,task_specs_json,acknowledged_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(binding_id) DO UPDATE SET binding_epoch=excluded.binding_epoch,role_revision=excluded.role_revision,policy_revision=excluded.policy_revision,plan_revision=excluded.plan_revision,task_specs_json=excluded.task_specs_json,acknowledged_at=excluded.acknowledged_at")
    .run(binding.id, input.projectId, input.bindingEpoch, Number(role.revision) + 1, input.policyRevision, input.planRevision, JSON.stringify(input.taskSpecRevisions), now);
  db.prepare("INSERT INTO role_revisions(project_id,role_id,revision,snapshot_json) VALUES(?,?,?,?)").run(input.projectId, input.roleId, Number(role.revision) + 1, JSON.stringify({ desiredState: role.desired_state, bindingState: "ready" }));
  return viewOf(roleRow(db, input.projectId, input.roleId));
}

export function completeStartupAck(store: Store, input: StartupAckInput, now: number): RoleView {
  return store.transaction(db => completeStartupAckWithin(db, input, now));
}

export interface TaskSpecPage {
  readonly items: readonly { readonly taskId: string; readonly goal: string; readonly state: string; readonly specRevision: number }[];
  readonly nextCursor: string | null;
  readonly filterToken: string;
}

/** 任务规格分页：cursor=末位taskId水位（无静默漏项）；filterToken绑定过滤器，换过滤条件复用旧cursor显式拒绝。 */
export function taskSpecPage(store: Store, projectId: string, options: { readonly limit?: number; readonly cursor?: string; readonly states?: readonly string[] } = {}): TaskSpecPage {
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("INVALID_PAGE_LIMIT");
  const states = options.states === undefined ? ["draft", "ready", "active", "waiting", "review", "accepted", "blocked", "cancelled"] : options.states;
  if (states.length === 0 || states.some(s => typeof s !== "string")) throw new Error("INVALID_PAGE_FILTER");
  const filterToken = states.join(",");
  let cursorTaskId: string | null = null;
  if (options.cursor !== undefined) {
    const match = /^v1:([^|]+)\|(.*)$/.exec(options.cursor);
    if (!match) throw new Error("INVALID_PAGE_CURSOR");
    if (match[2] !== filterToken) throw new Error("PAGE_CURSOR_FILTER_MISMATCH");
    cursorTaskId = match[1] ?? null;
  }
  const placeholders = states.map(() => "?").join(",");
  const rows = (cursorTaskId === null
    ? store.db.prepare(`SELECT id,goal,state,spec_revision FROM tasks WHERE project_id=? AND state IN (${placeholders}) ORDER BY id LIMIT ?`).all(projectId, ...states, limit + 1)
    : store.db.prepare(`SELECT id,goal,state,spec_revision FROM tasks WHERE project_id=? AND state IN (${placeholders}) AND id>? ORDER BY id LIMIT ?`).all(projectId, ...states, cursorTaskId, limit + 1)) as { id: string; goal: string; state: string; spec_revision: number }[];
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(row => ({ taskId: String(row.id), goal: String(row.goal), state: String(row.state), specRevision: Number(row.spec_revision) }));
  const last = items[items.length - 1];
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: hasMore && last !== undefined ? `v1:${last.taskId}|${filterToken}` : null,
    filterToken,
  });
}

/** T035：provisioning恢复查询（A051）——bootstrap回执丢失后检查已创建身份，不重复创建。 */
export function readBootstrapState(store: Store, projectId: string): { readonly state: string; readonly roleId: string; readonly requestId: string } | null {
  const row = store.db.prepare("SELECT state,role_id,request_id FROM project_bootstrap WHERE project_id=?").get(projectId) as { state: string; role_id: string; request_id: string } | undefined;
  if (!row) return null;
  return { state: String(row.state), roleId: String(row.role_id), requestId: String(row.request_id) };
}

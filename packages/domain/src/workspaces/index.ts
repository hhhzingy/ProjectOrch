/** T040准备切片：工作空间冲突协调与生命周期。注册=规范化路径（复用canonicalRoot）+全局路径唯一；
 * 预约=available→reserved独占（已reserved即冲突，任务归属记录）；释放=reserved→available（仅持有者任务可释放）；
 * 退役=available→retired终态；路径边界解析复用artifacts的resolveWithinProject。 */
import type { Store } from "@projectorch/persistence";
import { canonicalRoot } from "../projects/index.js";
export {workspaceWriterConflict,type OwnedWriterReservation} from './writer-conflicts.js';
export {reserveNativeWriteWithin,assertNativeWriteWithin,assertNativeWriteIdentityWithin,activateNativeWriteWithin,finishNativeWriteWithin,reconcileFactoryWriteWithin,reconcileRecoveredFactoryWriteWithin,reconcileInterruptedMessageWithin,interruptNativeWritesWithin,type NativeWriteRequest} from './native-write-effects.js';
export type {NativeWriteProof} from './writer-conflicts.js';

export type WorkspaceState = "available" | "reserved" | "unknown" | "retired";

export interface WorkspaceView {
  readonly id: string;
  readonly projectId: string;
  readonly canonicalPath: string;
  readonly ownerTaskId: string | null;
  readonly managed: boolean;
  readonly enforcement: "enforced" | "advisory" | "unknown";
  readonly state: WorkspaceState;
  readonly revision: number;
}

const text = (value: unknown, label: string, max: number): string => {
  if (typeof value !== "string" || !value || value.length > max || /[\r\n\0]/.test(value)) throw new Error(`INVALID_WORKSPACE_${label}`);
  return value;
};
const clock = (now: number): void => { if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_WORKSPACE_TIME"); };
function rowToView(row: Record<string, unknown>): WorkspaceView {
  return Object.freeze({ id: String(row.id), projectId: String(row.project_id), canonicalPath: String(row.canonical_path), ownerTaskId: row.owner_task_id === null ? null : String(row.owner_task_id), managed: Number(row.managed) === 1, enforcement: String(row.enforcement) as WorkspaceView["enforcement"], state: String(row.state) as WorkspaceState, revision: Number(row.revision) });
}
function getRow(store: Store, projectId: string, workspaceId: string): Record<string, unknown> {
  const row = store.db.prepare("SELECT id,project_id,canonical_path,owner_task_id,managed,enforcement,state,revision FROM workspaces WHERE id=? AND project_id=?").get(workspaceId, projectId);
  if (!row) throw new Error("WORKSPACE_NOT_FOUND");
  return row as Record<string, unknown>;
}

/** 注册工作空间：路径经canonicalRoot规范化身份；全局唯一（跨项目重复绑定同一目录拒绝）；可登记写路径清单（策略模板语法由授权层校验）。 */
export function registerWorkspace(store: Store, input: { readonly id: unknown; readonly projectId: unknown; readonly canonicalPath: unknown; readonly ownerTaskId?: unknown; readonly managed?: unknown; readonly enforcement?: unknown; readonly writePaths?: readonly unknown[] }, now: number): WorkspaceView {
  return store.transaction(db => registerWorkspaceWithin(db, input, now));
}

/** 供受信工作流准备与预约同事务使用，不接受模型提供的数据库对象。 */
export function registerWorkspaceWithin(db: Store["db"], input: { readonly id: unknown; readonly projectId: unknown; readonly canonicalPath: unknown; readonly ownerTaskId?: unknown; readonly managed?: unknown; readonly enforcement?: unknown; readonly writePaths?: readonly unknown[] }, now: number): WorkspaceView {
  if (!db.isTransaction) throw new Error("WORKSPACE_TRANSACTION_REQUIRED");
  clock(now);
  const id = text(input.id, "ID", 128);
  const projectId = text(input.projectId, "PROJECT", 128);
  const canonicalPath = canonicalRoot(input.canonicalPath);
  const rawOwnerTaskId = input.ownerTaskId;
  const ownerTaskId = rawOwnerTaskId === undefined || rawOwnerTaskId === null ? null : text(rawOwnerTaskId, "OWNER_TASK", 128);
  const managed = input.managed === true ? 1 : 0;
  const rawEnforcement = input.enforcement;
  const enforcement = rawEnforcement === undefined ? "unknown" : rawEnforcement;
  if (typeof enforcement !== "string" || !["enforced", "advisory", "unknown"].includes(enforcement)) throw new Error("INVALID_WORKSPACE_ENFORCEMENT");
  const writePathsJson = JSON.stringify(input.writePaths ?? []);
    if (!db.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)) throw new Error("WORKSPACE_PROJECT_NOT_FOUND");
    if (ownerTaskId !== null && !db.prepare("SELECT 1 FROM tasks WHERE id=? AND project_id=?").get(ownerTaskId, projectId)) throw new Error("WORKSPACE_TASK_NOT_FOUND");
    db.prepare("INSERT INTO workspaces(id,project_id,canonical_path,base_version,owner_task_id,managed,enforcement,revision,state,write_paths_json) VALUES(?,?,?,NULL,?,?,?,1,'available',?)").run(id, projectId, canonicalPath, ownerTaskId, managed, enforcement, writePathsJson);
    return rowToView(db.prepare("SELECT * FROM workspaces WHERE id=? AND project_id=?").get(id, projectId) as Record<string, unknown>);
}

/** 预约（独占）：available→reserved并记owner_task；已reserved即WORKSPACE_CONFLICT（同任务重复预约亦拒绝，幂等交由命令层以reservation记录实现）。 */
export function reserveWorkspace(store: Store, projectId: string, workspaceId: string, ownerTaskId: string, now: number): WorkspaceView {
  clock(now);
  return store.transaction(db => {
    const row = getRow(store, projectId, workspaceId);
    if (row.state !== "available") throw new Error("WORKSPACE_CONFLICT");
    if (ownerTaskId !== null && !db.prepare("SELECT 1 FROM tasks WHERE id=? AND project_id=?").get(ownerTaskId, projectId)) throw new Error("WORKSPACE_TASK_NOT_FOUND");
    db.prepare("UPDATE workspaces SET state='reserved',owner_task_id=?,revision=revision+1 WHERE id=? AND project_id=? AND state='available'").run(ownerTaskId, workspaceId, projectId);
    return rowToView(getRow(store, projectId, workspaceId));
  });
}

/** 释放：reserved→available；仅当前持有者任务可释放。 */
export function releaseWorkspace(store: Store, projectId: string, workspaceId: string, ownerTaskId: string, now: number): WorkspaceView {
  clock(now);
  return store.transaction(db => {
    const row = getRow(store, projectId, workspaceId);
    if (row.state !== "reserved") throw new Error("WORKSPACE_NOT_RESERVED");
    if (row.owner_task_id !== ownerTaskId) throw new Error("WORKSPACE_NOT_OWNER");
    db.prepare("UPDATE workspaces SET state='available',owner_task_id=NULL,revision=revision+1 WHERE id=? AND project_id=? AND state='reserved' AND owner_task_id=?").run(workspaceId, projectId, ownerTaskId);
    return rowToView(getRow(store, projectId, workspaceId));
  });
}

/** 退役：available→retired（终态；历史引用保留）。 */
export function retireWorkspace(store: Store, projectId: string, workspaceId: string, now: number): WorkspaceView {
  clock(now);
  return store.transaction(db => {
    const row = getRow(store, projectId, workspaceId);
    if (row.state !== "available") throw new Error("WORKSPACE_TRANSITION_REJECTED");
    db.prepare("UPDATE workspaces SET state='retired',revision=revision+1 WHERE id=? AND project_id=? AND state='available'").run(workspaceId, projectId);
    return rowToView(getRow(store, projectId, workspaceId));
  });
}

export function readWorkspace(store: Store, projectId: string, workspaceId: string): WorkspaceView {
  return rowToView(getRow(store, projectId, workspaceId));
}

/** T040：手动外部修改观察（A057）。记录不可变来源观察（source_observations）并将工作空间置unknown——
 * 后续派发按策略排队（WORKSPACE_CONFLICT待基线核对），不静默覆盖外部改动。 */
export function markExternalModification(store: Store, input: { readonly projectId: string; readonly workspaceId: string; readonly observation: unknown }, now: number): WorkspaceView {
  clock(now);
  if (input.observation === undefined || typeof input.observation !== "object" || Array.isArray(input.observation)) throw new Error("INVALID_WORKSPACE_OBSERVATION");
  return store.transaction(db => {
    const row = getRow(store, input.projectId, input.workspaceId);
    if (row.state === "retired") throw new Error("WORKSPACE_TRANSITION_REJECTED");
    db.prepare("INSERT INTO source_observations(id,project_id,source_kind,payload_json,observed_at) VALUES(?,?, 'kernel', ?, ?)").run(`obs-${input.workspaceId}-${now}`, input.projectId, JSON.stringify({ workspaceId: input.workspaceId, kind: "external_modification", ...input.observation as Record<string, unknown> }), now);
    db.prepare("UPDATE workspaces SET state='unknown',revision=revision+1 WHERE id=? AND project_id=?").run(input.workspaceId, input.projectId);
    return rowToView(getRow(store, input.projectId, input.workspaceId));
  });
}

/** T040：基线重新核对（A057）。unknown→available并记录新基线版本锚；隔离能力声明保持原样如实暴露（advisory≠隔离）。 */
export function acknowledgeBaseline(store: Store, input: { readonly projectId: string; readonly workspaceId: string; readonly baselineSha256: unknown }, now: number): WorkspaceView {
  clock(now);
  const baseline = text(input.baselineSha256, "BASELINE", 128);
  return store.transaction(db => {
    const row = getRow(store, input.projectId, input.workspaceId);
    if (row.state !== "unknown") throw new Error("WORKSPACE_NOT_UNCERTAIN");
    db.prepare("UPDATE workspaces SET state='available',base_version=?,revision=revision+1 WHERE id=? AND project_id=? AND state='unknown'").run(baseline, input.workspaceId, input.projectId);
    return rowToView(getRow(store, input.projectId, input.workspaceId));
  });
}

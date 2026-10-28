/** T034：管理变更集事务。合同形状经contracts固定Schema校验；持有写锁后核验计划版本，逐操作核验前序写入后的状态；
 * 任一失败→整册回滚并留痕（conflict/failed记录持久，不部分应用）；plan_revision随成功应用递增。
 * 支持：plan.revise、role.create/update/enable/pause/disable、task.create（spec含依赖）/assign/cancel、case.assign；
 * task.spec.revise与task.dependencies.replace复用完整修订管线。 */
import type { Store } from "@projectorch/persistence";
import { parseContract, type ContractRegistry } from "@projectorch/contracts";
import { setProjectObjectiveWithin, readProjectWithin } from "../projects/index.js";
import { createRoleWithin, setRoleDesiredStateWithin, type RoleDesiredState } from "../roles/index.js";
import { createTaskWithin, type TaskDependencyInput } from "../tasks/index.js";
import { reviseTaskSpecWithin, type SpecReviseInput } from "../plan-revisions/index.js";

type Changeset = ContractRegistry["changeset"];
type Operation = Changeset["operations"][number];

export interface AppliedChangeset {
  readonly changesetId: string;
  readonly planRevision: number;
  readonly appliedOperations: number;
}

type Db = Store["db"];
function roleRevisionOf(db: Db, projectId: string, roleId: string): { readonly revision: number; readonly desiredState: string } | null {
  const row = db.prepare("SELECT revision,desired_state FROM roles WHERE id=? AND project_id=?").get(roleId, projectId) as { revision: number; desired_state: string } | undefined;
  return row ? { revision: Number(row.revision), desiredState: String(row.desired_state) } : null;
}
function precheckOperation(db: Db, projectId: string, operation: Operation): string | null {
  const exists = (sql: string, ...params: (string | number)[]): boolean => !!db.prepare(sql).get(...params);
  switch (operation.type) {
    case "task.dependencies.replace":
    case "task.spec.revise": {
      const task = db.prepare("SELECT revision,spec_revision,state FROM tasks WHERE id=? AND project_id=?").get(operation.taskId, projectId);
      if (!task) return "SPEC_TASK_NOT_FOUND";
      if (task.revision !== operation.expectedRevision || task.spec_revision !== operation.expectedSpecRevision) return "SPEC_REVISION_CONFLICT";
      if (task.state === "cancelled") return "SPEC_TASK_CANCELLED";
      return null;
    }
    case "plan.revise":
      for (const taskId of operation.affectedTaskIds) if (!exists("SELECT 1 FROM tasks WHERE id=? AND project_id=?", taskId, projectId)) return `TASK_NOT_FOUND:${taskId}`;
      return null;
    case "role.create": {
      if (operation.parentRoleId !== undefined && !exists("SELECT 1 FROM roles WHERE id=? AND project_id=?", operation.parentRoleId, projectId)) return `ROLE_NOT_FOUND:${operation.parentRoleId}`;
      if (exists("SELECT 1 FROM roles WHERE id=? AND project_id=?", operation.localRef, projectId)) return `ROLE_EXISTS:${operation.localRef}`;
      return null;
    }
    case "role.update": {
      const role = roleRevisionOf(db, projectId, operation.roleId);
      if (!role) return `ROLE_NOT_FOUND:${operation.roleId}`;
      if (role.revision !== operation.expectedRevision) return `ROLE_REVISION_CONFLICT:${operation.roleId}`;
      return null;
    }
    case "role.enable":
    case "role.pause":
    case "role.disable": {
      const role = roleRevisionOf(db, projectId, operation.roleId);
      if (!role) return `ROLE_NOT_FOUND:${operation.roleId}`;
      if (role.revision !== operation.expectedRevision) return `ROLE_REVISION_CONFLICT:${operation.roleId}`;
      const target: RoleDesiredState = operation.type === "role.enable" ? "enabled" : operation.type === "role.pause" ? "paused" : "disabled";
      const allowed: Record<string, readonly string[]> = { enabled: ["paused", "disabled"], paused: ["enabled", "disabled"], disabled: ["enabled"] };
      if (role.desiredState === target) return `ROLE_STATE_UNCHANGED:${operation.roleId}`;
      if (!allowed[role.desiredState]?.includes(target)) return `ROLE_TRANSITION_REJECTED:${operation.roleId}`;
      return null;
    }
    case "task.create": {
      if (exists("SELECT 1 FROM tasks WHERE id=? AND project_id=?", operation.localRef, projectId)) return `TASK_EXISTS:${operation.localRef}`;
      if (operation.assigneeRoleId !== undefined && operation.assigneeRoleId !== null && !exists("SELECT 1 FROM roles WHERE id=? AND project_id=?", operation.assigneeRoleId, projectId)) return `ROLE_NOT_FOUND:${operation.assigneeRoleId}`;
      if (operation.assigneeLocalRef !== undefined && !exists("SELECT 1 FROM roles WHERE id=? AND project_id=?", operation.assigneeLocalRef, projectId)) return `ROLE_NOT_FOUND:${operation.assigneeLocalRef}`;
      for (const dependency of operation.spec.dependencies ?? []) {
        if (!exists("SELECT 1 FROM task_revisions WHERE task_id=? AND project_id=? AND revision=?", dependency.taskId, projectId, dependency.requiredTaskRevision)) return `TASK_PREREQ_REVISION_NOT_FOUND:${dependency.taskId}`;
      }
      return null;
    }
    case "task.assign":
    case "task.cancel": {
      const row = db.prepare("SELECT revision,state FROM tasks WHERE id=? AND project_id=?").get(operation.taskId, projectId) as { revision: number; state: string } | undefined;
      if (!row) return `TASK_NOT_FOUND:${operation.taskId}`;
      if (Number(row.revision) !== operation.expectedRevision) return `TASK_REVISION_CONFLICT:${operation.taskId}`;
      if (operation.type === "task.cancel" && ["review", "accepted", "cancelled"].includes(String(row.state))) return `TASK_TRANSITION_REJECTED:${operation.taskId}`;
      if (operation.type === "task.assign" && ["review", "accepted", "cancelled"].includes(String(row.state))) return `TASK_TRANSITION_REJECTED:${operation.taskId}`;
      if (operation.type === "task.assign" && operation.roleId !== null && operation.roleId !== undefined && !exists("SELECT 1 FROM roles WHERE id=? AND project_id=?", operation.roleId, projectId)) return `ROLE_NOT_FOUND:${operation.roleId}`;
      if (operation.type === "task.assign" && operation.roleLocalRef !== undefined && !exists("SELECT 1 FROM roles WHERE id=? AND project_id=?", operation.roleLocalRef, projectId)) return `ROLE_NOT_FOUND:${operation.roleLocalRef}`;
      if (exists("SELECT 1 FROM attempts WHERE task_id=? AND project_id=? AND state IN ('dispatching','running','waiting_input','unknown')", operation.taskId, projectId)) return `TASK_EXECUTION_UNRESOLVED:${operation.taskId}`;
      return null;
    }
    case "case.assign": {
      const row = db.prepare("SELECT revision FROM cases WHERE id=? AND project_id=?").get(operation.caseId, projectId) as { revision: number } | undefined;
      if (!row) return `CASE_NOT_FOUND:${operation.caseId}`;
      if (Number(row.revision) !== operation.expectedRevision) return `CASE_REVISION_CONFLICT:${operation.caseId}`;
      if (!exists("SELECT 1 FROM roles WHERE id=? AND project_id=?", operation.roleId, projectId)) return `ROLE_NOT_FOUND:${operation.roleId}`;
      return null;
    }
  }
  return `CAPABILITY_UNSUPPORTED:${(operation as { type: string }).type}`;
}

export class ChangesetFailure extends Error {}

/** 对外入口：持有写事务后检查版本，逐操作核验批内前序写入；失败提交审计后抛出。 */
export function applyChangeset(store: Store, commandId: string, changesetInput: unknown, now: number): AppliedChangeset {
  const outcome = store.transaction(db => {
    try { return applyChangesetWithin(db, commandId, changesetInput, now); }
    catch (error) { if (error instanceof ChangesetFailure) return error; throw error; }
  });
  if (outcome instanceof ChangesetFailure) throw outcome;
  return outcome;
}

/** 供可信命令管线使用。失败先回滚本册再留痕并抛出；外层事务失败时审计也共同回滚。 */
export function applyChangesetWithin(db: Db, commandId: string, changesetInput: unknown, now: number): AppliedChangeset {
  if (!db.isTransaction) throw new Error("CHANGESET_TRANSACTION_REQUIRED");
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_CHANGESET_TIME");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(commandId)) throw new Error("INVALID_CHANGESET_COMMAND_ID");
  const changeset = parseContract("changeset", changesetInput) as Changeset;
  const changesetId = `cs-${commandId}`;
  let index = -1;
  db.exec("SAVEPOINT changeset_apply");
  try {
    readProjectWithin(db, changeset.projectId);
    const current = Number(db.prepare("SELECT plan_revision FROM projects WHERE id=?").get(changeset.projectId)?.plan_revision);
    if (current !== changeset.expectedPlanRevision) throw new Error("PLAN_REVISION_CONFLICT");
    insertRecordWithin(db, changeset, changesetId, commandId, "proposed");
    let applied = 0;
    for (const operation of changeset.operations) {
      index = applied;
      const failure = precheckOperation(db, changeset.projectId, operation);
      if (failure) throw new Error(failure);
      applyOperation(db, changeset.projectId, operation, now);
      applied += 1;
    }
    db.prepare("UPDATE projects SET plan_revision=plan_revision+1 WHERE id=?").run(changeset.projectId);
    db.prepare("UPDATE changesets SET state='applied' WHERE id=?").run(changesetId);
    const planRevision = Number(db.prepare("SELECT plan_revision FROM projects WHERE id=?").get(changeset.projectId)?.plan_revision);
    for (const operation of changeset.operations) {
      if (operation.type === "task.create") db.prepare("UPDATE tasks SET plan_revision=? WHERE id=? AND project_id=?").run(planRevision, operation.localRef, changeset.projectId);
      else if ("taskId" in operation && operation.type.startsWith("task.")) db.prepare("UPDATE tasks SET plan_revision=? WHERE id=? AND project_id=?").run(planRevision, String(operation.taskId), changeset.projectId);
    }
    db.exec("RELEASE changeset_apply");
    return Object.freeze({ changesetId, planRevision, appliedOperations: applied });
  } catch (error) {
    db.exec("ROLLBACK TO changeset_apply"); db.exec("RELEASE changeset_apply");
    const reason = error instanceof Error ? error.message : "OPERATION_FAILED";
    const state = reason === "PLAN_REVISION_CONFLICT" ? "conflict" : "failed";
    insertRecordWithin(db, changeset, changesetId, commandId, state);
    throw new ChangesetFailure(`CHANGESET_${state.toUpperCase()}:${reason}@${index}`);
  }
}
function insertRecordWithin(db: Store["db"], changeset: Changeset, changesetId: string, commandId: string, state: string): void {
  db.prepare("INSERT INTO changesets(id,project_id,command_id,case_id,expected_plan_revision,operations_json,state) VALUES(?,?,?,?,?,?,?)").run(changesetId, changeset.projectId, commandId, null, changeset.expectedPlanRevision, JSON.stringify(changeset.operations), state);
}

function applyOperation(db: Store["db"], projectId: string, operation: Operation, now: number): void {
  switch (operation.type) {
    case "task.dependencies.replace": {
      const task = db.prepare("SELECT goal,inputs_json,outputs_json,acceptance_json FROM tasks WHERE id=? AND project_id=?").get(operation.taskId, projectId);
      if (!task) throw new Error("SPEC_TASK_NOT_FOUND");
      const spec = parseContract("task-spec", { goal: task.goal, inputArtifacts: JSON.parse(String(task.inputs_json)), outputRequirements: JSON.parse(String(task.outputs_json)), acceptance: JSON.parse(String(task.acceptance_json)), dependencies: operation.dependencies });
      applyOperation(db, projectId, { type: "task.spec.revise", taskId: operation.taskId, expectedRevision: operation.expectedRevision, expectedSpecRevision: operation.expectedSpecRevision,
        spec, affectedTaskIds: operation.affectedTaskIds, inFlightPolicy: operation.inFlightPolicy, outputReuse: "none", reason: operation.reason }, now);
      return;
    }
    case "plan.revise":
      setProjectObjectiveWithin(db, projectId, operation.objective, now);
      return;
    case "role.create": {
      createRoleWithin(db, { id: operation.localRef, projectId, name: operation.name, charter: operation.charter, permissionProfileId: operation.permissionProfileId, parentId: operation.parentRoleId ?? null, permissionProfileRevision: operation.permissionProfileRevision, scopePaths: operation.scopePaths }, now);
      return;
    }
    case "role.update": {
      const updates: string[] = [];
      const params: (string | number)[] = [];
      if (operation.charter !== undefined && operation.charter !== null) { updates.push("charter=?"); params.push(operation.charter); }
      if (operation.permissionProfileId !== undefined && operation.permissionProfileId !== null) { updates.push("permission_profile=?"); params.push(operation.permissionProfileId); }
      if (operation.permissionProfileRevision !== undefined) { updates.push("permission_profile_revision=?"); params.push(operation.permissionProfileRevision); }
      if (updates.length === 0) return;
      updates.push("revision=revision+1");
      params.push(operation.roleId, projectId);
      db.prepare(`UPDATE roles SET ${updates.join(",")} WHERE id=? AND project_id=?`).run(...params);
      const row = db.prepare("SELECT id,project_id,name,charter,parent_id,permission_profile,permission_profile_revision,scope_paths_json,desired_state,binding_state,revision FROM roles WHERE id=? AND project_id=?").get(operation.roleId, projectId) as Record<string, unknown>;
      const snapshot = { id: row.id, name: row.name, charter: row.charter, parentId: row.parent_id, permissionProfile: row.permission_profile, permissionProfileRevision: row.permission_profile_revision, scopePaths: JSON.parse(String(row.scope_paths_json)), desiredState: row.desired_state, bindingState: row.binding_state };
      db.prepare("INSERT INTO role_revisions(role_id,project_id,revision,snapshot_json) VALUES(?,?,?,?)").run(operation.roleId, projectId, Number(row.revision), JSON.stringify(snapshot));
      return;
    }
    case "role.enable":
    case "role.pause":
    case "role.disable": {
      const target: RoleDesiredState = operation.type === "role.enable" ? "enabled" : operation.type === "role.pause" ? "paused" : "disabled";
      setRoleDesiredStateWithin(db, projectId, operation.roleId, target, now);
      return;
    }
    case "task.create": {
      const dependencies: readonly TaskDependencyInput[] = (operation.spec.dependencies ?? []).map(dependency => ({ prerequisiteId: dependency.taskId, requiredRevision: dependency.requiredTaskRevision, condition: dependency.condition, ...(dependency.outputName === undefined ? {} : { outputName: dependency.outputName }) }));
      createTaskWithin(db, { id: operation.localRef, projectId, roleId: operation.assigneeRoleId ?? operation.assigneeLocalRef ?? null, goal: operation.spec.goal, acceptance: operation.spec.acceptance ?? [], dependencies, inputArtifacts: operation.spec.inputArtifacts ?? [], outputRequirements: operation.spec.outputRequirements ?? [] }, now);
      return;
    }
    case "task.assign":
      db.prepare("UPDATE tasks SET role_id=?,revision=revision+1 WHERE id=? AND project_id=?").run(operation.roleId ?? operation.roleLocalRef ?? null, operation.taskId, projectId);
      return;
    case "task.cancel":
      db.prepare("UPDATE tasks SET state='cancelled',revision=revision+1 WHERE id=? AND project_id=?").run(operation.taskId, projectId);
      return;
    case "task.spec.revise":
      reviseTaskSpecWithin(db, {
        projectId, taskId: operation.taskId,
        expectedRevision: operation.expectedRevision, expectedSpecRevision: operation.expectedSpecRevision,
        spec: {
          goal: operation.spec.goal,
          inputArtifacts: (operation.spec.inputArtifacts ?? []).map(a => ({ artifactId: a.artifactId, version: a.version })),
          outputRequirements: (operation.spec.outputRequirements ?? []).map(o => ({ name: o.name, kind: o.kind, description: o.description })),
          acceptance: operation.spec.acceptance ?? [],
          dependencies: (operation.spec.dependencies ?? []).map(d => ({ prerequisiteId: d.taskId, requiredRevision: d.requiredTaskRevision, condition: d.condition, ...(d.outputName === undefined ? {} : { outputName: d.outputName }) })),
        },
        affectedTaskIds: operation.affectedTaskIds, inFlightPolicy: operation.inFlightPolicy, outputReuse: operation.outputReuse, reason: operation.reason,
      } satisfies SpecReviseInput, now, { advancePlanRevision: false });
      return;
    case "case.assign":
      db.prepare("UPDATE cases SET owner_role_id=?,state='assigned',revision=revision+1 WHERE id=? AND project_id=?").run(operation.roleId, operation.caseId, projectId);
      return;
  }
  throw new Error(`CAPABILITY_UNSUPPORTED:${(operation as { type: string }).type}`);
}

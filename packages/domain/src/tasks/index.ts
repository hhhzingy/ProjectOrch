/** T027准备切片：任务图与启动条件。创建=规格快照+依赖（前置任务、所需revision、条件accepted/artifact_available）；
 * 建图拒绝自环与间接环（依赖DFS）；启动条件评估：全部前置满足才允许draft→ready（accepted=前置已验收；
 * artifact_available=指定规格结果中的具名成果可定位）。Within变体供命令runner复用。 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Store } from "@projectorch/persistence";

export type TaskState = "draft" | "ready" | "active" | "waiting" | "review" | "accepted" | "blocked" | "cancelled";
export type DependencyCondition = "accepted" | "artifact_available";

export interface TaskView {
  readonly id: string;
  readonly projectId: string;
  readonly roleId: string | null;
  readonly goal: string;
  readonly state: TaskState;
  readonly revision: number;
}

const text = (value: unknown, label: string, max: number): string => {
  if (typeof value !== "string" || !value || value.length > max || /[\r\n\0]/.test(value)) throw new Error(`INVALID_TASK_${label}`);
  return value;
};
const clock = (now: number): void => { if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_TASK_TIME"); };

function taskRowDb(db: DatabaseSync, projectId: string, taskId: string): Record<string, unknown> {
  const row = db.prepare("SELECT id,project_id,role_id,goal,state,revision,spec_revision FROM tasks WHERE id=? AND project_id=?").get(taskId, projectId);
  if (!row) throw new Error("TASK_NOT_FOUND");
  return row as Record<string, unknown>;
}
function viewOf(row: Record<string, unknown>): TaskView {
  return Object.freeze({ id: String(row.id), projectId: String(row.project_id), roleId: row.role_id === null ? null : String(row.role_id), goal: String(row.goal), state: String(row.state) as TaskState, revision: Number(row.revision) });
}
function snapshotTask(db: DatabaseSync, projectId: string, taskId: string, row: Record<string, unknown>): number {
  const revision = Number(row.spec_revision);
  const spec = db.prepare("SELECT inputs_json,outputs_json,acceptance_json FROM tasks WHERE id=? AND project_id=?").get(taskId, projectId);
  const dependencies = db.prepare("SELECT prerequisite_id AS prerequisiteId,required_revision AS requiredRevision,condition,output_name AS outputName FROM task_dependencies WHERE task_id=? AND project_id=? ORDER BY prerequisite_id").all(taskId, projectId);
  const snapshot = { goal: row.goal, roleId: row.role_id, inputArtifacts: JSON.parse(String(spec?.inputs_json ?? "[]")), outputRequirements: JSON.parse(String(spec?.outputs_json ?? "[]")), acceptance: JSON.parse(String(spec?.acceptance_json ?? "[]")), dependencies };
  db.prepare("INSERT INTO task_revisions(task_id,project_id,revision,snapshot_json) VALUES(?,?,?,?)").run(taskId, projectId, revision, JSON.stringify(snapshot));
  return revision;
}

/** 依赖环检测：沿依赖边DFS，回到起点即拒绝（间接环同样覆盖）。 */
export function assertNoTaskDependencyCycle(db: DatabaseSync, projectId: string, taskId: string, dependencies: readonly TaskDependencyInput[]): void {
  const stack = dependencies.map(d => typeof d.prerequisiteId === "string" ? d.prerequisiteId : "");
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === taskId) throw new Error("TASK_CYCLE_REJECTED");
    if (visited.has(current)) continue;
    visited.add(current);
    const edges = db.prepare("SELECT prerequisite_id FROM task_dependencies WHERE task_id=? AND project_id=?").all(current, projectId) as { prerequisite_id: string }[];
    for (const edge of edges) stack.push(String(edge.prerequisite_id));
  }
}

export interface TaskDependencyInput { readonly prerequisiteId: unknown; readonly requiredRevision: unknown; readonly condition: unknown; readonly outputName?: unknown }

/** v2依赖的具名输出不可丢失。旧库中缺失名称的依赖由评估器明确阻塞。 */
export function dependencyOutputName(dependency: TaskDependencyInput): string | null {
  if (dependency.condition === "artifact_available") return text(dependency.outputName, "OUTPUT_NAME", 128);
  return dependency.outputName === undefined || dependency.outputName === null ? null : text(dependency.outputName, "OUTPUT_NAME", 128);
}

export function createTask(store: Store, input: { readonly id: unknown; readonly projectId: unknown; readonly roleId?: unknown; readonly goal: unknown; readonly acceptance?: unknown; readonly dependencies?: readonly TaskDependencyInput[]; readonly inputArtifacts?: readonly unknown[]; readonly outputRequirements?: readonly unknown[] }, now: number): TaskView {
  clock(now);
  const id = text(input.id, "ID", 128);
  const projectId = text(input.projectId, "PROJECT", 128);
  const roleId = input.roleId === undefined || input.roleId === null ? null : text(input.roleId, "ROLE", 128);
  const goal = text(input.goal, "GOAL", 8192);
  const acceptance = input.acceptance === undefined ? [] : input.acceptance;
  if (!Array.isArray(acceptance) || acceptance.length > 32) throw new Error("INVALID_TASK_ACCEPTANCE");
  const dependencies = input.dependencies ?? [];
  if (!Array.isArray(dependencies) || dependencies.length > 64) throw new Error("INVALID_TASK_DEPENDENCIES");
  // 对外签名与createTaskWithin合同对齐：inputArtifacts/outputRequirements缺省[]——静默丢弃会造成规格不完整任务（task-detail合同minItems门槛拒读）。
  return store.transaction(db => createTaskWithin(db, { id, projectId, roleId, goal, acceptance, dependencies, inputArtifacts: input.inputArtifacts ?? [], outputRequirements: input.outputRequirements ?? [] }, now));
}

export function createTaskWithin(db: DatabaseSync, input: { readonly id: string; readonly projectId: string; readonly roleId: string | null; readonly goal: string; readonly acceptance: readonly unknown[]; readonly dependencies: readonly TaskDependencyInput[]; readonly inputArtifacts?: readonly unknown[]; readonly outputRequirements?: readonly unknown[] }, now: number): TaskView {
  clock(now);
  if (!db.prepare("SELECT 1 FROM projects WHERE id=?").get(input.projectId)) throw new Error("TASK_PROJECT_NOT_FOUND");
  if (input.roleId !== null && !db.prepare("SELECT 1 FROM roles WHERE id=? AND project_id=?").get(input.roleId, input.projectId)) throw new Error("TASK_ROLE_NOT_FOUND");
  db.prepare("INSERT INTO tasks(id,project_id,role_id,goal,state,revision,spec_revision,plan_revision,acceptance_json,inputs_json,outputs_json) VALUES(?,?,?,?,'draft',1,1,0,?,?,?)").run(input.id, input.projectId, input.roleId, input.goal, JSON.stringify(input.acceptance), JSON.stringify(input.inputArtifacts ?? []), JSON.stringify(input.outputRequirements ?? []));
  assertNoTaskDependencyCycle(db, input.projectId, input.id, input.dependencies);
  for (const dependency of input.dependencies) {
    const prerequisiteId = text(dependency.prerequisiteId, "PREREQ", 128);
    const requiredRevision = dependency.requiredRevision;
    const condition = text(dependency.condition, "CONDITION", 32);
    if (condition !== "accepted" && condition !== "artifact_available") throw new Error("INVALID_TASK_CONDITION");
    if (typeof requiredRevision !== "number" || !Number.isSafeInteger(requiredRevision) || requiredRevision < 0) throw new Error("INVALID_TASK_REQUIRED_REVISION");
    if (!db.prepare("SELECT 1 FROM task_revisions WHERE task_id=? AND project_id=? AND revision=?").get(prerequisiteId, input.projectId, requiredRevision)) throw new Error("TASK_PREREQ_REVISION_NOT_FOUND");
    db.prepare("INSERT INTO task_dependencies(project_id,task_id,prerequisite_id,required_revision,condition,output_name) VALUES(?,?,?,?,?,?)").run(input.projectId, input.id, prerequisiteId, requiredRevision, condition, dependencyOutputName(dependency));
  }
  assertNoTaskDependencyCycle(db, input.projectId, input.id, input.dependencies);
  snapshotTask(db, input.projectId, input.id, taskRowDb(db, input.projectId, input.id));
  return viewOf(taskRowDb(db, input.projectId, input.id));
}

export interface UnmetDependency { readonly prerequisiteId: string; readonly requiredRevision: number; readonly condition: DependencyCondition; readonly reason: string }

/** 启动条件评估：全部依赖满足返回ready=true；否则列出未满足项（不修改状态）。 */
export function evaluateStartConditions(store: Store, projectId: string, taskId: string): { readonly ready: boolean; readonly unmet: readonly UnmetDependency[] } {
  if (!store.db.prepare("SELECT 1 FROM tasks WHERE id=? AND project_id=?").get(taskId, projectId)) throw new Error("TASK_NOT_FOUND");
  const dependencies = store.db.prepare("SELECT prerequisite_id,required_revision,condition,output_name FROM task_dependencies WHERE task_id=? AND project_id=? ORDER BY prerequisite_id").all(taskId, projectId) as { prerequisite_id: string; required_revision: number; condition: string; output_name: string | null }[];
  const unmet: UnmetDependency[] = [];
  const impacts = store.db.prepare("SELECT i.source_task_id,i.source_spec_revision FROM task_revision_impacts i JOIN tasks t ON t.project_id=i.project_id AND t.id=i.task_id AND t.spec_revision=i.task_spec_revision WHERE i.project_id=? AND i.task_id=? ORDER BY i.source_task_id,i.source_spec_revision").all(projectId, taskId);
  for (const impact of impacts) unmet.push({ prerequisiteId: String(impact.source_task_id), requiredRevision: Number(impact.source_spec_revision), condition: "accepted", reason: "TASK_SPEC_REVALIDATION_REQUIRED" });
  for (const dependency of dependencies) {
    const prerequisiteId = String(dependency.prerequisite_id);
    const requiredRevision = Number(dependency.required_revision);
    const condition = String(dependency.condition) as DependencyCondition;
    const prerequisite = store.db.prepare("SELECT state,spec_revision FROM tasks WHERE id=? AND project_id=?").get(prerequisiteId, projectId) as { state: string; spec_revision: number } | undefined;
    if (!prerequisite) { unmet.push({ prerequisiteId, requiredRevision, condition, reason: "PREREQ_NOT_FOUND" }); continue; }
    if (Number(prerequisite.spec_revision) !== requiredRevision) { unmet.push({ prerequisiteId, requiredRevision, condition, reason: "PREREQ_SPEC_MISMATCH" }); continue; }
    if (prerequisite.state === "cancelled") { unmet.push({ prerequisiteId, requiredRevision, condition, reason: "PREREQ_CANCELLED" }); continue; }
    if (condition === "accepted") {
      const accepted = store.db.prepare("SELECT 1 FROM acceptances c JOIN results r ON r.id=c.result_id AND r.project_id=c.project_id JOIN attempts a ON a.id=r.attempt_id AND a.project_id=r.project_id WHERE r.project_id=? AND r.task_id=? AND r.task_revision=? AND c.task_revision=? AND c.decision='accept' AND r.outcome='succeeded' AND r.eligibility='current' AND a.state='succeeded'").get(projectId, prerequisiteId, requiredRevision, requiredRevision);
      if (!accepted) unmet.push({ prerequisiteId, requiredRevision, condition, reason: "PREREQ_NOT_ACCEPTED" });
    } else if (condition === "artifact_available") {
      if (!dependency.output_name) { unmet.push({ prerequisiteId, requiredRevision, condition, reason: "PREREQ_OUTPUT_NAME_MISSING" }); continue; }
      const results = store.db.prepare("SELECT outputs_json FROM results WHERE project_id=? AND task_id=? AND task_revision=? AND eligibility='current'").all(projectId, prerequisiteId, requiredRevision);
      const available = results.some(result => {
        const outputs: unknown = JSON.parse(String(result.outputs_json));
        return Array.isArray(outputs) && outputs.some(output => {
          if (!output || typeof output !== "object" || output.outputName !== dependency.output_name || typeof output.artifactId !== "string" || typeof output.version !== "string") return false;
          return !!store.db.prepare("SELECT 1 FROM artifacts WHERE id=? AND project_id=? AND task_id=? AND task_revision=? AND version=?").get(output.artifactId, projectId, prerequisiteId, requiredRevision, output.version);
        });
      });
      if (!available) unmet.push({ prerequisiteId, requiredRevision, condition, reason: "PREREQ_NO_ARTIFACT" });
    } else {
      unmet.push({ prerequisiteId, requiredRevision, condition, reason: "PREREQ_CONDITION_UNSUPPORTED" });
    }
  }
  return Object.freeze({ ready: unmet.length === 0, unmet: Object.freeze(unmet) });
}

/** draft→ready：仅当全部启动条件满足；revision递增并快照。 */
export function markTaskReady(store: Store, projectId: string, taskId: string, now: number): TaskView {
  clock(now);
  return store.transaction(db => {
    const evaluation = evaluateStartConditions(store, projectId, taskId);
    if (!evaluation.ready) throw new Error("TASK_START_CONDITIONS_UNMET");
    const row = taskRowDb(db, projectId, taskId);
    if (row.state !== "draft") throw new Error("TASK_TRANSITION_REJECTED");
    db.prepare("UPDATE tasks SET state='ready',revision=? WHERE id=? AND project_id=?").run(Number(row.revision) + 1, taskId, projectId);
    // ready只改变实体revision，不能制造一个新规格快照。
    return viewOf(taskRowDb(db, projectId, taskId));
  });
}

/** 返工重开：复核拒绝后的管理动作（blocked→ready，revision+1；可审计）。只有blocked态可重开。 */
export function reopenBlockedTask(store: Store, projectId: string, taskId: string, now: number): TaskView {
  clock(now);
  return store.transaction(db => {
    const row = taskRowDb(db, projectId, taskId);
    if (row.state !== "blocked") throw new Error("TASK_TRANSITION_REJECTED");
    db.prepare("UPDATE tasks SET state='ready',revision=? WHERE id=? AND project_id=?").run(Number(row.revision) + 1, taskId, projectId);
    db.prepare("INSERT INTO events(id,project_id,type,entity_id,entity_revision,causation_id,body_json,occurred_at) VALUES(?,?, 'task.reopened',?,?,NULL,?,?)").run(`ev-${randomUUID()}`, projectId, taskId, Number(row.revision) + 1, JSON.stringify({ from: "blocked" }), now);
    return viewOf(taskRowDb(db, projectId, taskId));
  });
}

export function readTask(store: Store, projectId: string, taskId: string): TaskView {
  return viewOf(taskRowDb(store.db, projectId, taskId));
}

/** T046准备切片：任务依赖与成果视图（只读投影）。任务详情=规格+依赖（含前置实时状态与满足判定）+成果清单+验收规则；
 * 项目任务图=全部任务+依赖边+就绪判定；投影按项目构造隔离，无跨项目读取路径。 */
import type { Store } from "@projectorch/persistence";
import { evaluateStartConditions } from "../tasks/index.js";

export interface DependencyView {
  readonly prerequisiteId: string;
  readonly requiredRevision: number;
  readonly condition: "accepted" | "artifact_available";
  readonly outputName?: string;
  readonly met: boolean;
  readonly prerequisiteState: string | null;
}

export interface ArtifactSummary {
  readonly artifactId: string;
  readonly version: string;
  readonly pathRef: string;
  readonly sha256: string | null;
  readonly taskRevision: number | null;
}

export interface TaskDetailView {
  readonly taskId: string;
  readonly goal: string;
  readonly state: string;
  readonly revision: number;
  readonly specRevision: number;
  readonly roleId: string | null;
  readonly acceptance: readonly unknown[];
  readonly dependencies: readonly DependencyView[];
  readonly startReady: boolean;
  readonly artifacts: readonly ArtifactSummary[];
}

export interface TaskGraphNode {
  readonly taskId: string;
  readonly state: string;
  readonly revision: number;
  readonly startReady: boolean;
  readonly dependsOn: readonly string[];
}

export interface ProjectTaskGraph {
  readonly projectId: string;
  readonly nodes: readonly TaskGraphNode[];
}

function assertProjectExists(store: Store, projectId: string): void {
  if (!store.db.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)) throw new Error("VIEW_PROJECT_NOT_FOUND");
}

export function taskDetailView(store: Store, projectId: string, taskId: string): TaskDetailView {
  assertProjectExists(store, projectId);
  const task = store.db.prepare("SELECT id,goal,state,revision,spec_revision,role_id,acceptance_json FROM tasks WHERE id=? AND project_id=?").get(taskId, projectId) as Record<string, unknown> | undefined;
  if (!task) throw new Error("VIEW_TASK_NOT_FOUND");
  const dependencyRows = store.db.prepare("SELECT prerequisite_id,required_revision,condition,output_name FROM task_dependencies WHERE task_id=? AND project_id=? ORDER BY prerequisite_id").all(taskId, projectId) as { prerequisite_id: string; required_revision: number; condition: string; output_name: string | null }[];
  const evaluation = evaluateStartConditions(store, projectId, taskId);
  const unmetByPrerequisite = new Map(evaluation.unmet.map(entry => [entry.prerequisiteId, entry.reason]));
  const dependencies = dependencyRows.map(row => {
    const prerequisite = store.db.prepare("SELECT state FROM tasks WHERE id=? AND project_id=?").get(String(row.prerequisite_id), projectId) as { state: string } | undefined;
    return {
      prerequisiteId: String(row.prerequisite_id),
      requiredRevision: Number(row.required_revision),
      condition: String(row.condition) as "accepted" | "artifact_available",
      ...(row.output_name === null ? {} : { outputName: String(row.output_name) }),
      met: !unmetByPrerequisite.has(String(row.prerequisite_id)),
      prerequisiteState: prerequisite ? String(prerequisite.state) : null,
    };
  });
  const artifacts = (store.db.prepare("SELECT id,version,path_ref,sha256,task_revision FROM artifacts WHERE task_id=? AND project_id=? ORDER BY id").all(taskId, projectId) as { id: string; version: string; path_ref: string; sha256: string | null; task_revision: number | null }[]).map(row => ({ artifactId: String(row.id), version: String(row.version), pathRef: String(row.path_ref), sha256: row.sha256 === null ? null : String(row.sha256), taskRevision: row.task_revision === null ? null : Number(row.task_revision) }));
  return Object.freeze({
    taskId: String(task.id),
    goal: String(task.goal),
    state: String(task.state),
    revision: Number(task.revision),
    specRevision: Number(task.spec_revision),
    roleId: task.role_id === null ? null : String(task.role_id),
    acceptance: JSON.parse(String(task.acceptance_json)) as readonly unknown[],
    dependencies: Object.freeze(dependencies),
    startReady: evaluation.ready,
    artifacts: Object.freeze(artifacts),
  });
}

export function projectTaskGraph(store: Store, projectId: string): ProjectTaskGraph {
  assertProjectExists(store, projectId);
  const tasks = store.db.prepare("SELECT id,state,revision FROM tasks WHERE project_id=? ORDER BY id").all(projectId) as { id: string; state: string; revision: number }[];
  const edges = store.db.prepare("SELECT task_id,prerequisite_id FROM task_dependencies WHERE project_id=? ORDER BY task_id,prerequisite_id").all(projectId) as { task_id: string; prerequisite_id: string }[];
  const edgesByTask = new Map<string, string[]>();
  for (const edge of edges) {
    const list = edgesByTask.get(String(edge.task_id)) ?? [];
    list.push(String(edge.prerequisite_id));
    edgesByTask.set(String(edge.task_id), list);
  }
  const nodes = tasks.map(task => {
    const evaluation = evaluateStartConditions(store, projectId, String(task.id));
    return { taskId: String(task.id), state: String(task.state), revision: Number(task.revision), startReady: evaluation.ready, dependsOn: edgesByTask.get(String(task.id)) ?? [] };
  });
  return Object.freeze({ projectId, nodes: Object.freeze(nodes) });
}

/** T047准备切片：管理总览投影。管理者一屏可见：项目暂停态、未决异常、需关注变更集（非applied）、非enabled角色、待处理消息积压、投递不确定积压。按项目隔离；投递不确定为全局计数（outbox无项目归属）。 */
export interface ManagementOverview {
  readonly projectId: string;
  readonly userPaused: boolean;
  readonly planRevision: number;
  readonly openIssues: readonly { readonly caseId: string; readonly state: string; readonly fingerprint: string; readonly revision: number }[];
  readonly changesetsNeedingAttention: readonly { readonly changesetId: string; readonly state: string }[];
  readonly rolesNotEnabled: readonly { readonly roleId: string; readonly desiredState: string; readonly bindingState: string }[];
  readonly messageBacklog: readonly { readonly roleId: string; readonly stored: number }[];
  readonly deliveryUncertain: number;
}

export function managementOverview(store: Store, projectId: string): ManagementOverview {
  assertProjectExists(store, projectId);
  const project = store.db.prepare("SELECT user_paused,plan_revision FROM projects WHERE id=?").get(projectId) as { user_paused: number; plan_revision: number } | undefined;
  if (!project) throw new Error("VIEW_PROJECT_NOT_FOUND");
  const openIssues = (store.db.prepare("SELECT id,state,fingerprint,revision FROM cases WHERE project_id=? AND state NOT IN ('resolved','escalated') ORDER BY revision").all(projectId) as Record<string, unknown>[]).map(row => ({ caseId: String(row.id), state: String(row.state), fingerprint: String(row.fingerprint), revision: Number(row.revision) }));
  const changesetsNeedingAttention = (store.db.prepare("SELECT id,state FROM changesets WHERE project_id=? AND state IN ('proposed','failed','conflict') ORDER BY id").all(projectId) as Record<string, unknown>[]).map(row => ({ changesetId: String(row.id), state: String(row.state) }));
  const rolesNotEnabled = (store.db.prepare("SELECT id,desired_state,binding_state FROM roles WHERE project_id=? AND desired_state!='enabled' ORDER BY id").all(projectId) as Record<string, unknown>[]).map(row => ({ roleId: String(row.id), desiredState: String(row.desired_state), bindingState: String(row.binding_state) }));
  const messageBacklog = (store.db.prepare("SELECT m.to_role_id AS roleId, COUNT(*) AS stored FROM messages m JOIN roles r ON r.id=m.to_role_id AND r.project_id=m.project_id WHERE m.project_id=? AND m.state='stored' AND r.desired_state='enabled' GROUP BY m.to_role_id ORDER BY m.to_role_id").all(projectId) as Record<string, unknown>[]).map(row => ({ roleId: String(row.roleId), stored: Number(row.stored) }));
  const deliveryUncertain = Number(store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state='uncertain'").get()?.n ?? 0);
  return Object.freeze({
    projectId,
    userPaused: Number(project.user_paused) === 1,
    planRevision: Number(project.plan_revision),
    openIssues: Object.freeze(openIssues),
    changesetsNeedingAttention: Object.freeze(changesetsNeedingAttention),
    rolesNotEnabled: Object.freeze(rolesNotEnabled),
    messageBacklog: Object.freeze(messageBacklog),
    deliveryUncertain,
  });
}

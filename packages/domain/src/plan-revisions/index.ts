/** T036：规格修订与计划影响分析（task.spec.revise落地）。修订=乐观并发校验后spec_revision推进+完整规格快照；
 * 旧成果由库触发器自动stale（保留历史不删除）；in-flight尝试按策略finish_stale/request_stop处置；
 * 影响分析=受影响下游+验收缺口+无关工作不变的显式清单；result.revalidate=按新规格建受控重验证尝试。
 * 负例：不自动降低验收标准——新规格的验收规则原样生效，缺口如实报告。 */
import type { Store } from "@projectorch/persistence";
import { randomUUID } from "node:crypto";
import { evaluateStartConditions, assertNoTaskDependencyCycle, dependencyOutputName } from "../tasks/index.js";

export interface TaskSpec {
  readonly goal: string;
  readonly inputArtifacts: readonly { readonly artifactId: string; readonly version: string }[];
  readonly outputRequirements: readonly { readonly name: string; readonly kind: "file" | "report" | "git_commit"; readonly description: string }[];
  readonly acceptance: readonly unknown[];
  readonly dependencies: readonly { readonly prerequisiteId: string; readonly requiredRevision: number; readonly condition: "accepted" | "artifact_available"; readonly outputName?: string }[];
}

export interface SpecReviseInput {
  readonly projectId: string;
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly expectedSpecRevision: number;
  readonly spec: TaskSpec;
  readonly affectedTaskIds: readonly string[];
  readonly inFlightPolicy: "finish_stale" | "request_stop";
  readonly outputReuse: "none" | "revalidate_only";
  readonly reason: string;
}

export interface SpecReviseImpact {
  readonly taskId: string;
  readonly specRevision: number;
  readonly revision: number;
  readonly staleResultIds: readonly string[];
  readonly interruptedAttemptIds: readonly string[];
  readonly stopRequestedAttemptIds: readonly string[];
  readonly downstreamTaskIds: readonly string[];
  readonly newAcceptanceGap: readonly { readonly ruleId: string; readonly gap: string }[];
  readonly unrelatedTaskCount: number;
  readonly planRevision: number;
}

type Db = Store["db"];

function reviseWithin(db: Db, input: SpecReviseInput, now: number, advancePlan = true): SpecReviseImpact {
  if (!Number.isSafeInteger(now) || now < 0 || !["finish_stale", "request_stop"].includes(input.inFlightPolicy) || !["none", "revalidate_only"].includes(input.outputReuse)) throw new Error("INVALID_SPEC_REQUEST");
  const row = db.prepare("SELECT id,goal,state,revision,spec_revision,acceptance_json FROM tasks WHERE id=? AND project_id=?").get(input.taskId, input.projectId) as Record<string, unknown> | undefined;
  if (!row) throw new Error("SPEC_TASK_NOT_FOUND");
  if (["cancelled"].includes(String(row.state))) throw new Error("SPEC_TASK_CANCELLED");
  if (Number(row.revision) !== input.expectedRevision) throw new Error("SPEC_REVISION_CONFLICT");
  if (Number(row.spec_revision) !== input.expectedSpecRevision) throw new Error("SPEC_STALE_CONFLICT");
  if (typeof input.reason !== "string" || !input.reason.length || input.reason.length > 16384) throw new Error("INVALID_SPEC_REASON");
  for (const id of input.affectedTaskIds) if (!db.prepare("SELECT 1 FROM tasks WHERE id=? AND project_id=?").get(id, input.projectId)) throw new Error("SPEC_AFFECTED_TASK_NOT_FOUND");
  const affected = db.prepare("WITH RECURSIVE affected(id) AS (SELECT id FROM tasks WHERE project_id=? AND (id=? OR id IN (SELECT value FROM json_each(?))) UNION SELECT d.task_id FROM task_dependencies d JOIN affected a ON d.prerequisite_id=a.id WHERE d.project_id=?) SELECT id FROM affected WHERE id<>? ORDER BY id")
    .all(input.projectId, input.taskId, JSON.stringify(input.affectedTaskIds), input.projectId, input.taskId).map(value => String(value.id));
  // 不得自动降低验收标准：新规格验收规则数量少于旧规格→显式拒绝（调用方需显式给出新规则集）
  const oldAcceptance = JSON.parse(String(row.acceptance_json)) as unknown[];
  if (Array.isArray(input.spec.acceptance) && input.spec.acceptance.length < oldAcceptance.length) throw new Error("SPEC_ACCEPTANCE_WEAKENED");
  const newSpecRevision = Number(row.spec_revision) + 1;
  const newRevision = Number(row.revision) + 1;
  if (!Number.isSafeInteger(newSpecRevision) || !Number.isSafeInteger(newRevision)) throw new Error("SPEC_REVISION_EXHAUSTED");
  db.prepare("UPDATE tasks SET goal=?,inputs_json=?,outputs_json=?,acceptance_json=?,spec_revision=?,revision=?,state='draft' WHERE id=? AND project_id=?").run(input.spec.goal, JSON.stringify(input.spec.inputArtifacts), JSON.stringify(input.spec.outputRequirements), JSON.stringify(input.spec.acceptance), newSpecRevision, newRevision, input.taskId, input.projectId);
  // 依赖原子替换（task.dependencies.replace语义并入）：前置revision快照必须存在
  db.prepare("DELETE FROM task_dependencies WHERE task_id=? AND project_id=?").run(input.taskId, input.projectId);
  for (const dep of input.spec.dependencies) {
    if (!Number.isSafeInteger(dep.requiredRevision) || dep.requiredRevision < 0) throw new Error("INVALID_SPEC_DEPENDENCY");
    if (!db.prepare("SELECT 1 FROM task_revisions WHERE task_id=? AND project_id=? AND revision=?").get(dep.prerequisiteId, input.projectId, dep.requiredRevision)) throw new Error(`SPEC_PREREQ_REVISION_NOT_FOUND:${dep.prerequisiteId}`);
    if (!["accepted", "artifact_available"].includes(dep.condition)) throw new Error("INVALID_SPEC_CONDITION");
    db.prepare("INSERT INTO task_dependencies(project_id,task_id,prerequisite_id,required_revision,condition,output_name) VALUES(?,?,?,?,?,?)").run(input.projectId, input.taskId, dep.prerequisiteId, dep.requiredRevision, dep.condition, dependencyOutputName(dep));
  }
  assertNoTaskDependencyCycle(db, input.projectId, input.taskId, input.spec.dependencies);
  // 完整规格快照
  db.prepare("INSERT INTO task_revisions(task_id,project_id,revision,snapshot_json) VALUES(?,?,?,?)").run(input.taskId, input.projectId, newSpecRevision, JSON.stringify({ ...input.spec, revisedAt: now, reason: input.reason, inFlightPolicy: input.inFlightPolicy, outputReuse: input.outputReuse, requestedAffectedTaskIds: input.affectedTaskIds, affectedTaskIds: affected }));
  for (const taskId of affected) {
    const task = db.prepare("SELECT spec_revision,state FROM tasks WHERE id=? AND project_id=?").get(taskId, input.projectId);
    if (!task) throw new Error("SPEC_AFFECTED_TASK_NOT_FOUND");
    db.prepare("INSERT INTO task_revision_impacts(project_id,source_task_id,source_spec_revision,task_id,task_spec_revision,created_at) VALUES(?,?,?,?,?,?)").run(input.projectId, input.taskId, newSpecRevision, taskId, Number(task.spec_revision), now);
    if (task.state !== "cancelled") db.prepare("UPDATE tasks SET state='blocked',revision=revision+1 WHERE id=? AND project_id=?").run(taskId, input.projectId);
  }
  // 只取消未发送内部调度意图；消息/回答、已发送和uncertain记录保持原样。
  db.prepare("UPDATE outbox SET state='cancelled',lease_epoch=lease_epoch+1,lease_until=NULL WHERE state='pending' AND command_id IN (SELECT id FROM commands WHERE project_id=?) AND json_extract(payload_json,'$.event')='workflow.evaluate' AND json_extract(payload_json,'$.taskId') IN (SELECT value FROM json_each(?))")
    .run(input.projectId, JSON.stringify([input.taskId, ...affected]));
  // 请求停止不等于已停止。保留原执行状态及占位，由可信Supervisor处理持久控制请求。
  const interruptedAttemptIds: string[] = [];
  const stopRequestedAttemptIds: string[] = [];
  if (input.inFlightPolicy === "request_stop") {
    const active = db.prepare("SELECT a.id,a.binding_id,a.binding_epoch,a.native_execution_id,t.spec_revision AS requested_spec_revision FROM attempts a JOIN tasks t ON t.id=a.task_id AND t.project_id=a.project_id WHERE a.project_id=? AND a.task_id IN (SELECT value FROM json_each(?)) AND a.state IN ('dispatching','running','waiting_input','unknown')").all(input.projectId, JSON.stringify([input.taskId, ...affected]));
    for (const attempt of active) {
      db.prepare("INSERT INTO native_control_requests(id,project_id,attempt_id,binding_id,binding_epoch,expected_native_execution_id,task_spec_revision,kind,state,created_at) VALUES(?,?,?,?,?,?,?,'stop','pending',?) ON CONFLICT(attempt_id,task_spec_revision,kind) DO NOTHING").run(randomUUID(), input.projectId, String(attempt.id), String(attempt.binding_id), Number(attempt.binding_epoch), attempt.native_execution_id ?? null, Number(attempt.requested_spec_revision), now);
      stopRequestedAttemptIds.push(String(attempt.id));
    }
  }
  // 影响分析：旧成果（触发器已stale）、下游依赖、验收缺口
  const staleResultIds = (db.prepare("SELECT id FROM results WHERE project_id=? AND task_id=? AND eligibility='stale' ORDER BY id").all(input.projectId, input.taskId) as { id: string }[]).map(r => String(r.id));
  const downstreamTaskIds = affected;
  const newAcceptanceGap = input.spec.acceptance.map(rule => {
    const record = rule as Record<string, unknown>;
    return { ruleId: String(record.ruleId ?? record.kind ?? "rule"), gap: "需要按新规格提交新结果并裁决" };
  });
  const unrelatedTaskCount = Number(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id=? AND id NOT IN (SELECT value FROM json_each(?))").get(input.projectId, JSON.stringify([input.taskId, ...affected]))?.n);
  // 计划版本锚：规格修订推进项目plan_revision并留痕
  const planRevision = Number(db.prepare("SELECT plan_revision FROM projects WHERE id=?").get(input.projectId)?.plan_revision) + (advancePlan ? 1 : 0);
  if (advancePlan) db.prepare("UPDATE projects SET plan_revision=? WHERE id=?").run(planRevision, input.projectId);
  const snapshotRevision = Number(db.prepare("SELECT COALESCE(MAX(revision),0) AS r FROM project_revisions WHERE project_id=?").get(input.projectId)?.r) + 1;
  db.prepare("INSERT INTO project_revisions(project_id,revision,snapshot_json,reason) VALUES(?,?,?,?)").run(input.projectId, snapshotRevision, JSON.stringify({ specRevised: input.taskId, specRevision: newSpecRevision }), input.reason);
  return { taskId: input.taskId, specRevision: newSpecRevision, revision: newRevision, staleResultIds, interruptedAttemptIds, stopRequestedAttemptIds, downstreamTaskIds, newAcceptanceGap, unrelatedTaskCount, planRevision };
}

export function reviseTaskSpec(store: Store, input: SpecReviseInput, now: number): SpecReviseImpact {
  return store.transaction(db => reviseWithin(db, input, now));
}

/** task.spec.revise的变更集入口（单事务内复用；由applyChangeset调用）。 */
export function reviseTaskSpecWithin(db: Db, input: SpecReviseInput, now: number, options: { readonly advancePlanRevision: boolean } = { advancePlanRevision: true }): SpecReviseImpact {
  return reviseWithin(db, input, now, options.advancePlanRevision);
}

/** A052影响分析（只读）：修订前后对照——旧成果保留清单、下游受影响、验收缺口、无关工作不变。 */
export function analyzeSpecImpact(store: Store, input: { readonly projectId: string; readonly taskId: string }, now: number): { readonly staleResults: readonly string[]; readonly downstream: readonly { readonly taskId: string; readonly startReady: boolean; readonly unmetCount: number }[]; readonly acceptanceGap: number; readonly unrelatedTasks: readonly { readonly taskId: string; readonly state: string; readonly revision: number }[] } {
  void now;
  const task = store.db.prepare("SELECT id,acceptance_json FROM tasks WHERE id=? AND project_id=?").get(input.taskId, input.projectId) as Record<string, unknown> | undefined;
  if (!task) throw new Error("SPEC_TASK_NOT_FOUND");
  const staleResults = (store.db.prepare("SELECT id FROM results WHERE project_id=? AND task_id=? AND eligibility='stale' ORDER BY id").all(input.projectId, input.taskId) as { id: string }[]).map(r => String(r.id));
  const downstream = (store.db.prepare("WITH RECURSIVE affected(task_id) AS (SELECT task_id FROM task_dependencies WHERE project_id=? AND prerequisite_id=? UNION SELECT i.task_id FROM task_revision_impacts i JOIN tasks t ON t.project_id=i.project_id AND t.id=i.task_id AND t.spec_revision=i.task_spec_revision WHERE i.project_id=? AND i.source_task_id=? UNION SELECT d.task_id FROM task_dependencies d JOIN affected a ON d.prerequisite_id=a.task_id WHERE d.project_id=?) SELECT task_id FROM affected ORDER BY task_id").all(input.projectId, input.taskId, input.projectId, input.taskId, input.projectId) as { task_id: string }[]).map(row => {
    const evaluation = evaluateStartConditions(store, input.projectId, String(row.task_id));
    return { taskId: String(row.task_id), startReady: evaluation.ready, unmetCount: evaluation.unmet.length };
  });
  const acceptanceGap = (JSON.parse(String(task.acceptance_json)) as unknown[]).length;
  const unrelatedTasks = (store.db.prepare("SELECT id,state,revision FROM tasks WHERE project_id=? AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY id").all(input.projectId, JSON.stringify([input.taskId, ...downstream.map(task => task.taskId)])) as { id: string; state: string; revision: number }[]).map(r => ({ taskId: String(r.id), state: String(r.state), revision: Number(r.revision) }));
  return { staleResults, downstream, acceptanceGap, unrelatedTasks };
}

/** A087：result.revalidate受控新尝试——按新规格revision建重验证尝试（execution_kind=revalidation）。
 * 旧结果已stale不释放新依赖；新尝试产出新结果后才可再裁决。 */
export function requestRevalidate(store: Store, input: { readonly projectId: string; readonly taskId: string; readonly bindingId: string; readonly bindingEpoch: number; readonly workspaceId?: string; readonly attemptId: string }, now: number): { readonly attemptId: string; readonly taskRevision: number } {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_REVALIDATION_TIME");
  return store.transaction(db => {
  const task = store.db.prepare("SELECT spec_revision,revision FROM tasks WHERE id=? AND project_id=?").get(input.taskId, input.projectId) as { spec_revision: number; revision: number } | undefined;
  if (!task) throw new Error("SPEC_TASK_NOT_FOUND");
  const taskRevision = Number(task.spec_revision);
  if (!store.db.prepare("SELECT 1 FROM task_revisions WHERE task_id=? AND project_id=? AND revision=?").get(input.taskId, input.projectId, taskRevision)) throw new Error("SPEC_REVISION_SNAPSHOT_MISSING");
    const active = db.prepare("SELECT 1 FROM attempts WHERE project_id=? AND task_id=? AND state IN ('dispatching','running','waiting_input','unknown')").get(input.projectId, input.taskId);
    if (active) throw new Error("REVALIDATE_ATTEMPT_ACTIVE");
    if (input.workspaceId !== undefined) {
      const current = db.prepare("SELECT COALESCE(MAX(fence),0) AS f FROM workspace_reservations WHERE workspace_id=?").get(input.workspaceId) as { f: number };
      db.prepare("INSERT INTO workspace_reservations(id,project_id,workspace_id,task_id,task_revision,fence,state) VALUES(?,?,?,?,?,?,'reserved')").run(`res-${input.attemptId}`, input.projectId, input.workspaceId, input.taskId, taskRevision, Number(current.f) + 1);
    }
    db.prepare("INSERT INTO attempts(id,project_id,task_id,task_revision,binding_id,binding_epoch,workspace_id,execution_kind,state,started_at) VALUES(?,?,?,?,?,?,?, 'revalidation','dispatching',?)").run(input.attemptId, input.projectId, input.taskId, taskRevision, input.bindingId, input.bindingEpoch, input.workspaceId ?? null, now);
    return { attemptId: input.attemptId, taskRevision };
  });
}

import {safeExecutionDiagnostic, type ExecutionDiagnostic} from '../native/execution-diagnostics.js';
import { createHash, randomUUID } from "node:crypto";
import path from 'node:path';
import {unresolvedFactoryCapacity} from './native-capacity.js';
import {taskExecutionPrompt} from './task-prompt.js';
import { realpathSync } from "node:fs";
import type { Store } from "@projectorch/persistence";
import { canonicalJson } from "@projectorch/persistence/outbox";
import { sameSession, parseSessionRef, type SessionRef } from "@projectorch/adapter-contract";
import { parseContract } from "@projectorch/contracts";
import { evaluateStartConditions } from "@projectorch/domain/tasks";
import {workspaceWriterConflict} from "@projectorch/domain/workspaces";
import { reserveDispatchWithin } from "@projectorch/domain/dispatch-guard";
import { canonicalRoot } from "@projectorch/domain/projects";
import { parsePermissionProfile, templateInside } from "@projectorch/domain/policy";
import { assertAgentPrincipalCurrent, type AgentPrincipal } from "../auth/agent-credential.js";
import { authorizeAgentAction } from "../auth/policy-check.js";
import { readProjectPolicy } from "../auth/project-policy.js";
import type { NativeCompatibilityRegistry, NativeIdentity } from "../native/compatibility.js";

export interface NativeExecutionOutcome {
  readonly diagnostics?: ExecutionDiagnostic;
  readonly session: SessionRef;
  readonly executionId: string;
  readonly status: "completed" | "failed" | "interrupted" | "unknown";
  readonly terminalConfirmed: boolean;
  /** 执行轮助手回复摘录（可观测/诊断；截断存储，不作为判据）。 */
  readonly responseExcerpt?: string;
}
export interface NativeExecutionHandle { readonly result: Promise<NativeExecutionOutcome> }
export interface NativeStopHandle { readonly result: Promise<{ readonly session: SessionRef; readonly executionId: string; readonly accepted: boolean }> }
/** 仅由受信官方传输适配器实现，不接收Web/模型提供的函数、命令行或能力声明。 */
export interface ManagedExecutionDriver {
  readonly session: SessionRef;
  readonly ownerKey: string;
  readonly workspaceRoot: string;
  readonly registry: NativeCompatibilityRegistry;
  identity(): NativeIdentity;
  assertOwner(): void;
  assertIsolation(policy: ReturnType<typeof readProjectPolicy>, profile: ReturnType<typeof parsePermissionProfile>): void;
  /** 异步准备后必须在实际传输写入前同步调用assertCanSend，不能沿用旧准入快照。 */
  start(input: unknown, started: (session: SessionRef, executionId: string) => void, assertCanSend: () => void): NativeExecutionHandle;
  /** 同步投递精确执行的停止请求；接受回执不是终态，不得使用“停止当前轮”等不带身份的接口。 */
  requestStop?(input: { readonly session: SessionRef; readonly executionId: string }): NativeStopHandle;
  /** 只读权威历史/状态；不能新建/恢复替代会话、启动模型或以PID退出代替终态。 */
  inspectExecution?(input: { readonly session: SessionRef; readonly executionId: string }): NativeExecutionHandle;
  /** 受信生产驱动支持不取得原owner的只读核对；完成后必须处理其精确旧租约。 */
  readonly supportsReadOnlyRecovery?: true;
  confirmRecoveredTerminal?(outcome:NativeExecutionOutcome):void;
}
export class NativeDispatchNotSent extends Error {}
export interface ExecutionServices {
  readonly now: () => number;
  readonly isKernelOwner: () => boolean;
  /** 读取实际门槛/证据；不是接收调用方布尔verified。未通过必须抛错。 */
  readonly assertGates: (session: SessionRef) => void;
  readonly principalForBinding: (bindingId: string) => AgentPrincipal;
  readonly driverForBinding: (bindingId: string) => ManagedExecutionDriver;
}
type Db = Store["db"];
interface Snapshot { readonly roleRevision: number; readonly taskRevision: number; readonly specRevision: number; readonly policyRevision: number; readonly policySha256: string; readonly planRevision: number; readonly holdRevision: number; readonly identity: NativeIdentity; readonly session: SessionRef; readonly workspaceRevision: number; readonly workspaceRoot: string }
const activeStates = "('dispatching','running','waiting_input','unknown')";
const token = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function synchronous(action: () => unknown): void { const value = action(); if (value && typeof (value as { then?: unknown }).then === "function") { void Promise.resolve(value).catch(() => undefined); throw new Error("ASYNC_EXECUTION_GUARD_FORBIDDEN"); } }
function event(db: Db, projectId: string, id: string, type: string, body: unknown, now: number): void {
  db.prepare("INSERT INTO events(id,project_id,type,entity_id,entity_revision,causation_id,body_json,occurred_at) VALUES(?,?,?,?,1,?,?,?)").run(randomUUID(), projectId, type, id, id, canonicalJson(body), now);
}

/** 持久发送边界：先提交占位，再在最后的事务检查后同步启动；未知绝不自动重派。 */
export class ExecutionCoordinator {
  readonly #owner = randomUUID();
  readonly #running = new Map<string, Promise<string>>();
  readonly #stopping = new Map<string, Promise<string>>();
  readonly #reconciling = new Map<string, Promise<string>>();
  #closed = false;
  readonly #stopSignal: Promise<"coordinator_closed">;
  #signalStop: () => void = () => undefined;
  constructor(readonly store: Store, readonly services: ExecutionServices) {
    for (const fn of [services.now, services.isKernelOwner, services.assertGates, services.principalForBinding, services.driverForBinding]) if (typeof fn !== "function" || fn.constructor.name === "AsyncFunction") throw new Error("SYNC_EXECUTION_SERVICE_REQUIRED");
    this.#stopSignal = new Promise(resolve => { this.#signalStop = () => resolve("coordinator_closed"); });
  }
  #now(): number { const now = this.services.now(); if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_EXECUTION_TIME"); return now; }
  #assertOwner(): void { if (this.#closed || this.services.isKernelOwner() !== true) throw new Error("EXECUTION_OWNER_LOST"); }
  #check(principal: AgentPrincipal, taskId: string, workspaceId: string, driver: ManagedExecutionDriver, reserved?: {attemptId:string;dispatchId:string;dispatchFence:number}): { snapshot: Snapshot; input: unknown } {
    const reservedAttempt=reserved?.attemptId;
    this.#assertOwner(); const now = this.#now();
    assertAgentPrincipalCurrent(this.store, principal, now);
    const db = this.store.db;
    const task = db.prepare("SELECT * FROM tasks WHERE id=? AND project_id=?").get(taskId, principal.projectId);
    if (!task || task.role_id !== principal.roleId) throw new Error("DISPATCH_TASK_NOT_OWNED");
    if (!["draft", "ready"].includes(String(task.state))) throw new Error("DISPATCH_TASK_NOT_READY");
    const permission = authorizeAgentAction(this.store, principal, undefined, { action: "task.claim", targetProjectId: principal.projectId, kind: "write", path: `tasks/${taskId}` }, now);
    if (!permission.allowed) throw new Error(`DISPATCH_FORBIDDEN:${permission.reason}`);
    const project = db.prepare("SELECT policy_revision,plan_revision,hold_revision FROM projects WHERE id=?").get(principal.projectId);
    const role = db.prepare("SELECT revision,binding_state,startup_protocol_version,permission_profile,permission_profile_revision FROM roles WHERE id=? AND project_id=?").get(principal.roleId, principal.projectId);
    if (!project || !role) throw new Error("DISPATCH_TARGET_MISSING");
    if (db.prepare("SELECT 1 FROM goal_holds WHERE project_id=? AND state IN ('pending','awaiting_user')").get(principal.projectId)) throw new Error("DISPATCH_HELD");
    const ack = db.prepare("SELECT * FROM role_startup_acks WHERE binding_id=? AND project_id=? AND binding_epoch=?").get(principal.bindingId, principal.projectId, principal.bindingEpoch);
    if (!ack || role.binding_state !== "ready" || role.startup_protocol_version !== 2 || ack.role_revision !== role.revision || ack.policy_revision !== project.policy_revision || ack.plan_revision !== project.plan_revision || Number(ack.acknowledged_at) > now) throw new Error("STARTUP_REQUIRED");
    const specs: unknown = JSON.parse(String(ack.task_specs_json));
    if (!Array.isArray(specs) || !specs.some(s => s?.taskId === taskId && s.specRevision === task.spec_revision)) throw new Error("STARTUP_TASK_SPEC_REQUIRED");
    if (!evaluateStartConditions(this.store, principal.projectId, taskId).ready) throw new Error("TASK_START_CONDITIONS_UNMET");
    const policy = readProjectPolicy(db, principal.projectId);
    const preference=db.prepare('SELECT model_requested_json,model_resolved_json,model_preference_revision FROM roles WHERE id=? AND project_id=?').get(principal.roleId,principal.projectId);
    if(preference?.model_requested_json&&!preference.model_resolved_json)throw new Error('MODEL_SELECTION_UNRESOLVED');
    if (policy.nativeMode !== "verified_only") throw new Error("NATIVE_EXECUTION_DISABLED");
    if(policy.limits.costCeiling!==null)throw new Error('COST_ENFORCEMENT_UNAVAILABLE');
    const profileInput = policy.profiles.find(p => p.id === role.permission_profile && p.revision === role.permission_profile_revision);
    if (!profileInput) throw new Error("POLICY_PROFILE_REVISION_CONFLICT");
    const profile = parsePermissionProfile(profileInput);
    const workspace = db.prepare("SELECT * FROM workspaces WHERE id=? AND project_id=?").get(workspaceId, principal.projectId);
    if (!workspace || !["available", "reserved"].includes(String(workspace.state)) || workspace.enforcement === "unknown") throw new Error("WORKSPACE_NOT_AVAILABLE");
    const root = canonicalRoot(realpathSync.native(driver.workspaceRoot));
    if (root !== workspace.canonical_path) throw new Error("WORKSPACE_IDENTITY_CHANGED");
    const writes: unknown = JSON.parse(String(workspace.write_paths_json));
    if (!Array.isArray(writes) || writes.some(p => typeof p !== "string") || !templateInside(profile.writePaths, writes)) throw new Error("WORKSPACE_PATH_OUT_OF_SCOPE");
    if (policy.writeIsolation === "enforced_paths" && workspace.enforcement !== "enforced") throw new Error("PATH_ENFORCEMENT_UNAVAILABLE");
    if (!sameSession(principal.session, driver.session) || !token(driver.ownerKey)) throw new Error("NATIVE_SESSION_MISMATCH");
    synchronous(() => driver.assertOwner()); synchronous(() => driver.assertIsolation(policy, profile)); synchronous(() => this.services.assertGates(driver.session));
    const identity = driver.identity();
    if (identity.harnessId !== driver.session.harnessId) throw new Error("NATIVE_IDENTITY_MISMATCH");
    for (const capability of ["textInput", "resume", "historyRead", "roleTools"] as const) if (!driver.registry.decide(identity, capability).enabled) throw new Error(`NATIVE_CAPABILITY_UNVERIFIED:${capability}`);
    const counts = db.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN binding_id=? THEN 1 ELSE 0 END) AS role FROM attempts WHERE project_id=? AND state IN ${activeStates} AND id<>?`).get(principal.bindingId, principal.projectId, reservedAttempt ?? "");
    const messageCounts = db.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN to_role_id=? THEN 1 ELSE 0 END) AS role FROM messages WHERE project_id=? AND state IN ('sending','uncertain')").get(principal.roleId,principal.projectId);
    const factories=unresolvedFactoryCapacity(db,principal.projectId,principal.roleId);
    if (Number(counts?.total) + Number(messageCounts?.total)+factories.total >= policy.limits.totalConcurrency || Number(counts?.role ?? 0) + Number(messageCounts?.role ?? 0)+factories.role >= policy.limits.roleConcurrency) throw new Error("DISPATCH_CONCURRENCY_EXCEEDED");
    const attempts = Number(db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE project_id=? AND task_id=? AND id<>?").get(principal.projectId, taskId, reservedAttempt ?? "")?.n);
    if (attempts >= policy.limits.maxAttempts) throw new Error("DISPATCH_ATTEMPTS_EXCEEDED");
    if (db.prepare(`SELECT 1 FROM attempts WHERE project_id=? AND task_id=? AND state IN ${activeStates} AND id<>?`).get(principal.projectId, taskId, reservedAttempt ?? "")) throw new Error("UNKNOWN_EXECUTION");
    const reservation = db.prepare("SELECT id FROM workspace_reservations WHERE workspace_id=? AND state IN ('reserved','unknown')").get(workspaceId);
    if (reservation && reservation.id !== `res-${reservedAttempt ?? ""}`) throw new Error("WORKSPACE_CONFLICT");
    const source=reserved?db.prepare('SELECT workspace_fence FROM execution_dispatches WHERE id=? AND attempt_id=? AND project_id=?').get(reserved.dispatchId,reserved.attemptId,principal.projectId):null;
    if(workspaceWriterConflict(this.store,principal.projectId,workspaceId,reserved?{
      dispatchId:reserved.dispatchId,dispatchOwnerKey:this.#owner,dispatchFence:reserved.dispatchFence,
      attemptId:reserved.attemptId,projectId:principal.projectId,workspaceId,taskId,taskRevision:Number(task.spec_revision),
      workspaceFence:Number(source?.workspace_fence),bindingId:principal.bindingId,bindingEpoch:principal.bindingEpoch,driverOwnerKey:driver.ownerKey
    }:undefined))throw Error('WORKSPACE_CONFLICT');
    const dependencies = db.prepare("SELECT prerequisite_id AS taskId,required_revision AS requiredTaskRevision,condition,output_name FROM task_dependencies WHERE task_id=? AND project_id=? ORDER BY prerequisite_id").all(taskId, principal.projectId).map(d => ({ taskId: d.taskId, requiredTaskRevision: d.requiredTaskRevision, condition: d.condition, ...(d.output_name === null ? {} : { outputName: d.output_name }) }));
    const spec = parseContract("task-spec", { goal: task.goal, inputArtifacts: JSON.parse(String(task.inputs_json)), outputRequirements: JSON.parse(String(task.outputs_json)), acceptance: JSON.parse(String(task.acceptance_json)), dependencies });
    for (const ref of spec.inputArtifacts) if (!db.prepare("SELECT 1 FROM artifacts WHERE id=? AND project_id=? AND version=?").get(ref.artifactId, principal.projectId, ref.version)) throw new Error("INPUT_ARTIFACT_NOT_FOUND");
    const snapshot: Snapshot = { roleRevision: Number(role.revision), taskRevision: Number(task.revision), specRevision: Number(task.spec_revision), policyRevision: Number(project.policy_revision), policySha256: digest(policy), planRevision: Number(project.plan_revision), holdRevision: Number(project.hold_revision), identity, session: parseSessionRef(driver.session), workspaceRevision: Number(workspace.revision), workspaceRoot: root };
    const reviewFeedback=db.prepare("SELECT d.rule_id AS ruleId,d.evidence_json AS evidence FROM result_rule_decisions d JOIN results r ON r.id=d.result_id AND r.project_id=d.project_id WHERE r.project_id=? AND r.task_id=? AND r.task_revision=? AND d.decision='reject' ORDER BY d.created_at,d.id").all(principal.projectId,taskId,Number(task.spec_revision)).map(r=>({ruleId:r.ruleId,...JSON.parse(String(r.evidence))}));
    const modelPreference=preference?{revision:Number(preference.model_preference_revision),requested:preference.model_requested_json?JSON.parse(String(preference.model_requested_json)):null,resolved:preference.model_resolved_json?JSON.parse(String(preference.model_resolved_json)):null}:null;
    // 保留同规格/同绑定全部已答决策；不能用条数截断悄悄丢本次解阻所需答案。
    // 增量计量防止先装载无界历史；超限显式阻塞，不能截断后继续执行。
    const resolvedQuestions=[];let questionBytes=0;
    for(const q of db.prepare("SELECT id,revision,prompt,answer,answerer_kind,answerer_role_id FROM questions WHERE project_id=? AND task_id=? AND task_revision=? AND binding_id=? AND binding_epoch=? AND state='answered' AND answer_command_id IS NOT NULL ORDER BY answered_at,id").iterate(principal.projectId,taskId,Number(task.spec_revision),principal.bindingId,principal.bindingEpoch)){
      const question={questionId:q.id,revision:q.revision,prompt:q.prompt,answer:JSON.parse(String(q.answer)),answerer:q.answerer_kind==='user'?{kind:'user'}:{kind:'role',roleId:q.answerer_role_id}};
      questionBytes+=Buffer.byteLength(JSON.stringify(question))+1;
      if(questionBytes>64000)throw new Error('TASK_EXECUTION_INPUT_TOO_LARGE');
      resolvedQuestions.push(question);
    }
    const projectRoot=String(db.prepare('SELECT canonical_root FROM projects WHERE id=?').get(principal.projectId)?.canonical_root);
    const workspaceRelativeToProjectRoot=path.relative(projectRoot,root).replaceAll('\\','/');
    if(path.isAbsolute(workspaceRelativeToProjectRoot)||workspaceRelativeToProjectRoot==='..'||workspaceRelativeToProjectRoot.startsWith('../'))throw Error('ARTIFACT_WORKSPACE_OUTSIDE_PROJECT');
    const artifactContext={pathRefBase:'projectRoot',workspaceRelativeToProjectRoot:workspaceRelativeToProjectRoot||'.'};
    const input={schemaVersion:2,projectId:principal.projectId,roleId:principal.roleId,bindingEpoch:principal.bindingEpoch,taskId,specRevision:task.spec_revision,spec,reviewFeedback,modelPreference,resolvedQuestions,artifactContext};
    // 与生产驱动使用相同编码器，包含真实发送包装；准备/异步发送边界均检查。
    taskExecutionPrompt({...input,attemptId:reservedAttempt??'00000000-0000-0000-0000-000000000000'});
    return {snapshot,input};
  }

  prepare(principal: AgentPrincipal, input: { readonly requestKey: string; readonly taskId: string; readonly workspaceId: string }): string {
    return this.store.transaction(() => this.prepareWithin(principal, input));
  }

  /** 供内部工作流消费者与候选回执同事务提交；不可在这里发模型输入。 */
  prepareWithin(principal: AgentPrincipal, input: { readonly requestKey: string; readonly taskId: string; readonly workspaceId: string }): string {
    const db = this.store.db;
    if (!db.isTransaction) throw new Error("DISPATCH_TRANSACTION_REQUIRED");
    if (!token(input.requestKey) || !token(input.taskId) || !token(input.workspaceId)) throw new Error("INVALID_DISPATCH_INPUT");
    const hash = digest({ ...input, bindingId: principal.bindingId, bindingEpoch: principal.bindingEpoch });
      this.#assertOwner(); assertAgentPrincipalCurrent(this.store, principal, this.#now());
      const existing = db.prepare("SELECT id,request_hash FROM execution_dispatches WHERE project_id=? AND request_key=?").get(principal.projectId, input.requestKey);
      if (existing) { if (existing.request_hash !== hash) throw new Error("DISPATCH_IDEMPOTENCY_CONFLICT"); return String(existing.id); }
      const driver = this.services.driverForBinding(principal.bindingId);
      const checked = this.#check(principal, input.taskId, input.workspaceId, driver);
      const id = randomUUID(); const now = this.#now();
      const reservation = reserveDispatchWithin(this.store, { projectId: principal.projectId, roleId: principal.roleId, bindingEpoch: principal.bindingEpoch, taskId: input.taskId, taskRevision: checked.snapshot.specRevision, workspaceId: input.workspaceId, attemptId: id }, now);
      db.prepare("INSERT INTO execution_dispatches(id,project_id,request_key,request_hash,task_id,task_revision,attempt_id,binding_id,binding_epoch,workspace_id,workspace_fence,owner_key,driver_owner_key,snapshot_json,input_json,phase,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?)")
        .run(id, principal.projectId, input.requestKey, hash, input.taskId, checked.snapshot.specRevision, id, principal.bindingId, principal.bindingEpoch, input.workspaceId, reservation.reservationFence, this.#owner, driver.ownerKey, canonicalJson(checked.snapshot), canonicalJson(checked.input), now);
      event(db, principal.projectId, id, "execution.reserved", { taskId: input.taskId, bindingEpoch: principal.bindingEpoch }, now);
      return id;
  }

  #row(id: string) { const row = this.store.db.prepare("SELECT * FROM execution_dispatches WHERE id=?").get(id); if (!row) throw new Error("DISPATCH_NOT_FOUND"); return row; }
  #owned(id: string, fence: number) { this.#assertOwner(); const row = this.#row(id); if (row.owner_key !== this.#owner || row.fence !== fence) throw new Error("DISPATCH_OWNER_LOST"); return row; }
  /** 发送、开始观察和终态都核对同一预约；不能等外发之后才发现栅栏丢失。 */
  #assertReservation(row: Record<string, unknown>, states: readonly string[], executionId: string | null): void {
    const db = this.store.db;
    const reservation = db.prepare("SELECT * FROM workspace_reservations WHERE id=? AND workspace_id=? AND project_id=? AND task_id=? AND task_revision=? AND fence=? AND state='reserved'")
      .get(`res-${String(row.attempt_id)}`, String(row.workspace_id), String(row.project_id), String(row.task_id), Number(row.task_revision), Number(row.workspace_fence));
    if (!reservation) throw new Error("WORKSPACE_FENCE_LOST");
    const attempt = db.prepare("SELECT state,native_execution_id FROM attempts WHERE id=? AND project_id=? AND task_id=? AND task_revision=? AND binding_id=? AND binding_epoch=? AND workspace_id=?")
      .get(String(row.attempt_id), String(row.project_id), String(row.task_id), Number(row.task_revision), String(row.binding_id), Number(row.binding_epoch), String(row.workspace_id));
    if (!attempt || !states.includes(String(attempt.state)) || attempt.native_execution_id !== executionId) throw new Error("DISPATCH_ATTEMPT_CHANGED");
  }
  #unknown(id: string, fence: number, diagnostics?:ExecutionDiagnostic): void {
    this.store.transaction(db => {
      const row = this.#owned(id, fence);
      if (!["reserved", "sending", "running"].includes(String(row.phase))) return;
      db.prepare("UPDATE execution_dispatches SET phase='unknown' WHERE id=?").run(id);
      db.prepare("UPDATE attempts SET state='unknown' WHERE id=? AND state IN ('dispatching','running','waiting_input')").run(String(row.attempt_id));
      db.prepare("UPDATE workspace_reservations SET state='unknown' WHERE id=? AND fence=? AND state='reserved'").run(`res-${String(row.attempt_id)}`, Number(row.workspace_fence));
      event(db, String(row.project_id), id, "execution.unknown", diagnostics?{diagnostics:safeExecutionDiagnostic(diagnostics)}:{}, this.#now());
    });
  }
  #uncertain(id: string, fence: number, diagnostics?:ExecutionDiagnostic): string {
    try { this.#assertOwner(); this.#unknown(id, fence, diagnostics); return String(this.#row(id).phase); }
    catch (error) {
      // 旧owner不能为新owner结算；实际接管者从持久发送边界恢复，不猜测执行结果。
      if (error instanceof Error && ["EXECUTION_OWNER_LOST", "DISPATCH_OWNER_LOST"].includes(error.message)) return "owner_lost";
      throw error;
    }
  }
  #release(db: Db, row: Record<string, unknown>): void {
    const updated = db.prepare("UPDATE workspace_reservations SET state='released' WHERE id=? AND workspace_id=? AND task_id=? AND fence=? AND state='reserved'").run(`res-${String(row.attempt_id)}`, String(row.workspace_id), String(row.task_id), Number(row.workspace_fence));
    if (Number(updated.changes) !== 1) throw new Error("WORKSPACE_FENCE_LOST");
  }
  #confirmStops(db: Db, row: Record<string, unknown>, executionId: string | null, phase: string): void {
    const requests = db.prepare("SELECT id FROM native_control_requests WHERE attempt_id=? AND project_id=? AND binding_id=? AND binding_epoch=? AND state IN ('pending','requested','uncertain') AND (expected_native_execution_id IS NULL OR expected_native_execution_id=?)")
      .all(String(row.attempt_id), String(row.project_id), String(row.binding_id), Number(row.binding_epoch), executionId);
    for (const request of requests) {
      db.prepare("UPDATE native_control_requests SET state='confirmed' WHERE id=?").run(String(request.id));
      event(db, String(row.project_id), String(request.id), "native.stop.terminal_confirmed", { dispatchId: row.id, executionId, phase }, this.#now());
    }
  }
  /** 仅处理持久用户/修订请求；不用Agent当前写权限阻止用户停止，也不将暂停解释为取消。 */
  async requestStop(requestId: string): Promise<string> {
    this.#assertOwner();
    if (!token(requestId)) throw new Error("INVALID_STOP_REQUEST");
    const existing = this.#stopping.get(requestId); if (existing) return existing;
    const work = Promise.resolve().then(() => this.#requestStop(requestId)); this.#stopping.set(requestId, work);
    try { return await work; } finally { this.#stopping.delete(requestId); }
  }
  #stopState(requestId: string): string { return String(this.store.db.prepare("SELECT state FROM native_control_requests WHERE id=?").get(requestId)?.state ?? "missing"); }
  #stopUncertain(requestId: string, code: string, target?: { readonly dispatchId: string; readonly fence: number }): string {
    if (this.#closed || this.services.isKernelOwner() !== true) return "owner_lost";
    if (target) {
      const row = this.#row(target.dispatchId);
      if (row.owner_key !== this.#owner || row.fence !== target.fence) return "owner_lost";
    }
    return this.store.transaction(db => {
      this.#assertOwner();
      const request = db.prepare("SELECT * FROM native_control_requests WHERE id=?").get(requestId);
      if (request?.state !== "requested") return this.#stopState(requestId);
      db.prepare("UPDATE native_control_requests SET state='uncertain' WHERE id=? AND state='requested'").run(requestId);
      event(db, String(request.project_id), requestId, "native.stop.uncertain", { code }, this.#now()); return "uncertain";
    });
  }
  async #requestStop(requestId: string): Promise<string> {
    // 先持久越过投递边界；即使随后崩溃，也不能因缺少回执而再次发送。
    const target = this.store.transaction(db => {
      this.#assertOwner();
      const request = db.prepare("SELECT * FROM native_control_requests WHERE id=?").get(requestId);
      if (!request) throw new Error("STOP_REQUEST_NOT_FOUND");
      if (request.state !== "pending") return null;
      const row = db.prepare("SELECT * FROM execution_dispatches WHERE attempt_id=? AND project_id=? AND binding_id=? AND binding_epoch=?")
        .get(String(request.attempt_id), String(request.project_id), String(request.binding_id), Number(request.binding_epoch));
      const reject = (code: string) => { db.prepare("UPDATE native_control_requests SET state='rejected' WHERE id=?").run(requestId); event(db, String(request.project_id), requestId, "native.stop.rejected", { code }, this.#now()); return null; };
      if (!row) return reject("STOP_DISPATCH_UNAVAILABLE");
      if (request.expected_native_execution_id !== null && request.expected_native_execution_id !== row.native_execution_id) return reject("STOP_EXECUTION_MISMATCH");
      this.#owned(String(row.id), Number(row.fence));
      if (["succeeded", "failed", "interrupted", "cancelled"].includes(String(row.phase))) {
        this.#confirmStops(db, row, row.native_execution_id as string | null, String(row.phase)); return null;
      }
      if (row.phase === "reserved") {
        this.#assertReservation(row, ["dispatching"], null); this.#release(db, row);
        const now = this.#now(); db.prepare("UPDATE execution_dispatches SET phase='cancelled',ended_at=? WHERE id=?").run(now, String(row.id));
        db.prepare("UPDATE attempts SET state='failed',ended_at=? WHERE id=? AND state='dispatching'").run(now, String(row.attempt_id));
        this.#confirmStops(db, row, null, "not_sent"); return null;
      }
      if (row.phase !== "running" || !token(row.native_execution_id)) return reject("STOP_EXECUTION_UNCONFIRMED");
      this.#assertReservation(row, ["running", "waiting_input"], String(row.native_execution_id));
      const prior = db.prepare("SELECT id FROM native_control_requests WHERE attempt_id=? AND project_id=? AND id<>? AND state IN ('requested','uncertain') LIMIT 1")
        .get(String(row.attempt_id), String(row.project_id), requestId);
      if (prior) {
        db.prepare("UPDATE native_control_requests SET state='uncertain' WHERE id=?").run(requestId);
        event(db, String(row.project_id), requestId, "native.stop.duplicate_suppressed", { predecessorId: prior.id, executionId: row.native_execution_id }, this.#now()); return null;
      }
      const snapshot = JSON.parse(String(row.snapshot_json)) as Snapshot;
      const driver = this.services.driverForBinding(String(row.binding_id));
      const binding = db.prepare("SELECT s.harness_id,s.host_id,s.profile_id,s.native_conversation_id FROM role_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.id=? AND b.project_id=? AND b.epoch=? AND b.ended_at IS NULL")
        .get(String(row.binding_id), String(row.project_id), Number(row.binding_epoch));
      if (!binding || !sameSession(snapshot.session, { harnessId: binding.harness_id, hostId: binding.host_id, profileId: binding.profile_id, nativeConversationId: binding.native_conversation_id } as SessionRef) || !sameSession(driver.session, snapshot.session) || driver.ownerKey !== row.driver_owner_key || canonicalJson(driver.identity()) !== canonicalJson(snapshot.identity)) return reject("STOP_DRIVER_CHANGED");
      synchronous(() => driver.assertOwner());
      if (!driver.requestStop || driver.requestStop.constructor.name === "AsyncFunction" || !driver.registry.decide(driver.identity(), "nativeCancel").enabled) return reject("STOP_CAPABILITY_UNVERIFIED");
      db.prepare("UPDATE native_control_requests SET state='requested' WHERE id=? AND state='pending'").run(requestId);
      event(db, String(row.project_id), requestId, "native.stop.prepared", { dispatchId: row.id, dispatchFence: row.fence, driverOwnerKey: row.driver_owner_key, executionId: row.native_execution_id, session: snapshot.session }, this.#now());
      return { dispatchId: String(row.id), fence: Number(row.fence), executionId: String(row.native_execution_id), session: snapshot.session, identity: snapshot.identity, driver };
    });
    if (!target) return this.#stopState(requestId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const handle = this.store.transaction(() => {
        const row = this.#owned(target.dispatchId, target.fence);
        if (this.#stopState(requestId) !== "requested" || row.phase !== "running" || row.native_execution_id !== target.executionId) throw new Error("STOP_TARGET_CHANGED");
        this.#assertReservation(row, ["running", "waiting_input"], target.executionId);
        const binding = this.store.db.prepare("SELECT s.harness_id,s.host_id,s.profile_id,s.native_conversation_id FROM role_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.id=? AND b.project_id=? AND b.epoch=? AND b.ended_at IS NULL")
          .get(String(row.binding_id), String(row.project_id), Number(row.binding_epoch));
        if (!binding || !sameSession(target.session, { harnessId: binding.harness_id, hostId: binding.host_id, profileId: binding.profile_id, nativeConversationId: binding.native_conversation_id } as SessionRef)) throw new Error("STOP_BINDING_CHANGED");
        if (this.services.driverForBinding(String(row.binding_id)) !== target.driver || target.driver.ownerKey !== row.driver_owner_key || !sameSession(target.driver.session, target.session) || canonicalJson(target.driver.identity()) !== canonicalJson(target.identity)) throw new Error("STOP_DRIVER_CHANGED");
        synchronous(() => target.driver.assertOwner());
        if (!target.driver.registry.decide(target.driver.identity(), "nativeCancel").enabled) throw new Error("STOP_CAPABILITY_UNVERIFIED");
        if (!target.driver.requestStop || target.driver.requestStop.constructor.name === "AsyncFunction") throw new Error("STOP_INVALID_DRIVER");
        return target.driver.requestStop({ session: target.session, executionId: target.executionId });
      });
      if (!handle?.result || typeof handle.result.then !== "function") throw new Error("STOP_INVALID_HANDLE");
      const timeout = new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), 10000); });
      const receipt = await Promise.race([Promise.resolve(handle.result), timeout, this.#stopSignal]);
      if (receipt === "timeout" || receipt === "coordinator_closed") return this.#stopUncertain(requestId, "STOP_RECEIPT_UNCONFIRMED", target);
      if (!sameSession(receipt.session, target.session) || receipt.executionId !== target.executionId || receipt.accepted !== true) return this.#stopUncertain(requestId, "STOP_RECEIPT_UNCONFIRMED", target);
      return this.store.transaction(db => {
        this.#owned(target.dispatchId, target.fence);
        if (this.#stopState(requestId) === "requested") event(db, String(this.#row(target.dispatchId).project_id), requestId, "native.stop.acknowledged", { executionId: target.executionId, terminalConfirmed: false }, this.#now());
        return this.#stopState(requestId);
      });
    } catch { return this.#stopUncertain(requestId, "STOP_DELIVERY_UNCONFIRMED", target); }
    finally { if (timer) clearTimeout(timer); }
  }
  /** 内部工作流心跳调用；只安排pending请求，不扫描requested/uncertain重新投递。 */
  consumeStopRequests(limit = 8): number {
    this.#assertOwner(); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new Error("INVALID_STOP_LIMIT");
    const rows = this.store.db.prepare("SELECT id FROM native_control_requests WHERE state='pending' ORDER BY created_at,id LIMIT ?").all(limit);
    let count = 0;
    for (const row of rows) if (!this.#stopping.has(String(row.id))) { count++; void this.requestStop(String(row.id)).catch(() => undefined); }
    return count;
  }
  #reconcileTarget(id: string, fence: number, expectedDriver?: ManagedExecutionDriver) {
    const db = this.store.db, row = this.#owned(id, fence);
    if (row.phase !== "unknown" || !token(row.native_execution_id)) throw new Error("RECONCILIATION_EXECUTION_ID_REQUIRED");
    const snapshot = JSON.parse(String(row.snapshot_json)) as Snapshot;
    const attempt = db.prepare("SELECT * FROM attempts WHERE id=? AND project_id=? AND task_id=? AND task_revision=? AND binding_id=? AND binding_epoch=? AND workspace_id=? AND state='unknown' AND native_execution_id=?")
      .get(String(row.attempt_id), String(row.project_id), String(row.task_id), Number(row.task_revision), String(row.binding_id), Number(row.binding_epoch), String(row.workspace_id), String(row.native_execution_id));
    const reservation = db.prepare("SELECT id FROM workspace_reservations WHERE id=? AND project_id=? AND workspace_id=? AND task_id=? AND task_revision=? AND fence=? AND state='unknown'")
      .get(`res-${String(row.attempt_id)}`, String(row.project_id), String(row.workspace_id), String(row.task_id), Number(row.task_revision), Number(row.workspace_fence));
    if (!attempt || !reservation) throw new Error("RECONCILIATION_FENCE_CHANGED");
    const binding = db.prepare("SELECT s.harness_id,s.host_id,s.profile_id,s.native_conversation_id,s.native_workspace_id FROM role_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.id=? AND b.project_id=? AND b.epoch=? AND b.ended_at IS NULL")
      .get(String(row.binding_id), String(row.project_id), Number(row.binding_epoch));
    if (!binding || !sameSession(snapshot.session, { harnessId: binding.harness_id, hostId: binding.host_id, profileId: binding.profile_id, nativeConversationId: binding.native_conversation_id,...(binding.native_workspace_id?{nativeWorkspaceId:binding.native_workspace_id}:{}) } as SessionRef)) throw new Error("RECONCILIATION_SESSION_CHANGED");
    const driver = this.services.driverForBinding(String(row.binding_id));
    const recoveryObserver=driver.supportsReadOnlyRecovery===true&&typeof driver.confirmRecoveredTerminal==='function';
    if ((expectedDriver && driver !== expectedDriver) || !sameSession(driver.session, snapshot.session) || (driver.ownerKey !== row.driver_owner_key&&!recoveryObserver) || canonicalJson(driver.identity()) !== canonicalJson(snapshot.identity)) throw new Error("RECONCILIATION_DRIVER_CHANGED");
    const workspace = db.prepare("SELECT canonical_path,revision FROM workspaces WHERE id=? AND project_id=?").get(String(row.workspace_id), String(row.project_id));
    if (!workspace || workspace.revision !== snapshot.workspaceRevision || workspace.canonical_path !== snapshot.workspaceRoot || canonicalRoot(realpathSync.native(driver.workspaceRoot)) !== snapshot.workspaceRoot) throw new Error("RECONCILIATION_WORKSPACE_CHANGED");
    synchronous(() => driver.assertOwner());
    if (!driver.inspectExecution || driver.inspectExecution.constructor.name === "AsyncFunction" || !driver.registry.decide(driver.identity(), "historyRead").enabled) throw new Error("RECONCILIATION_CAPABILITY_UNVERIFIED");
    return { row, driver, session: snapshot.session, executionId: String(row.native_execution_id) };
  }
  /** 仅接可信驱动观察，不接受调用者自报终态；不会自动重新发送任何执行或停止。 */
  async reconcile(id: string): Promise<string> {
    this.#assertOwner(); if (!token(id)) throw new Error("INVALID_RECONCILIATION_ID");
    if (this.#running.has(id)) throw new Error("RECONCILIATION_OBSERVER_ACTIVE");
    const existing = this.#reconciling.get(id); if (existing) return existing;
    const work = Promise.resolve().then(() => this.#reconcile(id)); this.#reconciling.set(id, work);
    try { return await work; } finally { this.#reconciling.delete(id); }
  }
  async #reconcile(id: string): Promise<string> {
    const initial = this.#row(id), fence = Number(initial.fence);
    let driver: ManagedExecutionDriver | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: Promise<NativeExecutionOutcome> | undefined;
    try {
      const observed = this.store.transaction(db => {
        const target = this.#reconcileTarget(id, fence); driver = target.driver;
        event(db, String(target.row.project_id), id, "execution.reconciliation_requested", { executionId: target.executionId, fence }, this.#now());
        const handle = target.driver.inspectExecution?.({ session: target.session, executionId: target.executionId });
        if (!handle?.result || typeof handle.result.then !== "function") throw new Error("RECONCILIATION_INVALID_HANDLE");
        pending = Promise.resolve(handle.result); void pending.catch(() => undefined);
        return handle;
      });
      const timeout = new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), 10000); });
      const outcome = await Promise.race([Promise.resolve(observed.result), timeout, this.#stopSignal]);
      if (outcome === "timeout" || outcome === "coordinator_closed") throw new Error("RECONCILIATION_UNCONFIRMED");
      return this.store.transaction(db => {
        const target = this.#reconcileTarget(id, fence, driver);
        if (!sameSession(outcome.session, target.session) || outcome.executionId !== target.executionId || outcome.terminalConfirmed !== true || !["completed", "failed", "interrupted"].includes(outcome.status)) throw new Error("RECONCILIATION_UNCONFIRMED");
        if(target.driver.confirmRecoveredTerminal)synchronous(()=>target.driver.confirmRecoveredTerminal!(outcome));
        const phase = outcome.status === "completed" ? "succeeded" : outcome.status, now = this.#now();
        const released = db.prepare("UPDATE workspace_reservations SET state='released' WHERE id=? AND fence=? AND state='unknown'").run(`res-${String(target.row.attempt_id)}`, Number(target.row.workspace_fence));
        if (Number(released.changes) !== 1) throw new Error("RECONCILIATION_FENCE_CHANGED");
        const dispatch = db.prepare("UPDATE execution_dispatches SET phase=?,ended_at=? WHERE id=? AND fence=? AND phase='unknown'").run(phase, now, id, fence);
        const attempt = db.prepare("UPDATE attempts SET state=?,ended_at=? WHERE id=? AND state='unknown' AND native_execution_id=?").run(phase, now, String(target.row.attempt_id), target.executionId);
        if (Number(dispatch.changes) !== 1 || Number(attempt.changes) !== 1) throw new Error("RECONCILIATION_TARGET_CHANGED");
        this.#confirmStops(db, target.row, target.executionId, phase);
        event(db, String(target.row.project_id), id, "execution.reconciled", { executionId: target.executionId, session: target.session, phase, source: "trusted_native_observation" }, now);
        return phase;
      });
    } catch {
      if (this.#closed || this.services.isKernelOwner() !== true) return "owner_lost";
      const row = this.#row(id); if (row.owner_key !== this.#owner || row.fence !== fence) return "owner_lost";
      // 错回执、超时或能力/归属漂移都不改写尝试和目录状态；保留原生ID，不能猜补。
      return String(row.phase);
    } finally { if (timer) clearTimeout(timer); }
  }
  async run(id: string): Promise<string> {
    this.#assertOwner();
    if (this.#running.has(id)) return this.#running.get(id) as Promise<string>;
    // 先登记再运行，防同步驱动回调重入形成第二个调用链。
    const work = Promise.resolve().then(() => this.#run(id)); this.#running.set(id, work);
    try { return await work; } finally { this.#running.delete(id); }
  }
  async #run(id: string): Promise<string> {
    this.#assertOwner();
    const initial = this.#row(id); const fence = Number(initial.fence);
    if (initial.owner_key !== this.#owner) throw new Error("DISPATCH_OWNER_LOST");
    if (initial.phase !== "reserved") return String(initial.phase);
    // 发送边界先持久提交，随后即使进程在spawn前后崩溃，也只恢复为unknown。
    this.store.transaction(db => { this.#owned(id, fence); db.prepare("UPDATE execution_dispatches SET phase='sending' WHERE id=? AND phase='reserved'").run(id); });
    let handle: NativeExecutionHandle | undefined; let invoked = false; let observationFault = false; let observationsClosed = false;
    let signalFault: () => void = () => undefined;
    const fault = new Promise<"observation_fault">(resolve => { signalFault = () => resolve("observation_fault"); });
    try {
      this.store.transaction(db => {
        const row = this.#owned(id, fence);
        this.#assertReservation(row, ["dispatching"], null);
        const principal = this.services.principalForBinding(String(row.binding_id));
        if (principal.bindingId !== row.binding_id || principal.bindingEpoch !== row.binding_epoch || principal.projectId !== row.project_id) throw new Error("DISPATCH_BINDING_CHANGED");
        const driver = this.services.driverForBinding(String(row.binding_id));
        if (driver.ownerKey !== row.driver_owner_key || driver.start.constructor.name === "AsyncFunction") throw new Error("DISPATCH_DRIVER_CHANGED");
        const checked = this.#check(principal, String(row.task_id), String(row.workspace_id), driver, {attemptId:String(row.attempt_id),dispatchId:id,dispatchFence:fence});
        if (canonicalJson(checked.snapshot) !== row.snapshot_json || canonicalJson(checked.input) !== row.input_json) throw new Error("DISPATCH_SNAPSHOT_CHANGED");
        invoked = true;
        const assertCanSend = (): void => {
          try {
            const recheck=()=>{
            if (observationsClosed || observationFault) throw new Error('DISPATCH_OBSERVATION_CLOSED');
            const latest = this.#owned(id,fence);
            if (latest.phase !== 'sending' || latest.native_execution_id !== null) throw new Error('DISPATCH_SEND_BOUNDARY_CHANGED');
            this.#assertReservation(latest,['dispatching'],null);
            const subject = this.services.principalForBinding(String(latest.binding_id));
            const current = this.#check(subject,String(latest.task_id),String(latest.workspace_id),driver,{attemptId:String(latest.attempt_id),dispatchId:id,dispatchFence:fence});
            if (canonicalJson(current.snapshot) !== latest.snapshot_json || canonicalJson(current.input) !== latest.input_json) throw new Error('DISPATCH_SNAPSHOT_CHANGED');
            };
            if(db.isTransaction)recheck();else this.store.transaction(recheck);
          } catch { throw new NativeDispatchNotSent('DISPATCH_SEND_RECHECK_REJECTED'); }
        };
        handle = driver.start({ ...checked.input as Record<string, unknown>, attemptId: row.attempt_id }, (session, executionId) => {
          if (this.#closed || observationsClosed || observationFault) return;
          // 驱动不允许在同步start调用栈中回调，以免嵌套事务；保守unknown结算。
          try {
            if (db.isTransaction || !token(executionId) || !sameSession(session, driver.session)) throw new Error("INVALID_START_OBSERVATION");
            this.store.transaction(tx => {
              const current = this.#owned(id, fence);
              if (current.phase !== "sending" || current.native_execution_id !== null) throw new Error("DUPLICATE_START_OBSERVATION");
              this.#assertReservation(current, ["dispatching"], null);
              tx.prepare("UPDATE execution_dispatches SET phase='running',native_execution_id=? WHERE id=?").run(executionId, id);
              tx.prepare("UPDATE attempts SET state='running',native_execution_id=? WHERE id=? AND state='dispatching'").run(executionId, String(row.attempt_id));
              event(tx, principal.projectId, id, "execution.started", { executionId }, this.#now());
            });
          } catch { observationFault = true; signalFault(); }
        }, assertCanSend);
        if (!handle || !handle.result || typeof handle.result.then !== "function") throw new Error("INVALID_EXECUTION_HANDLE");
      });
    } catch (error) {
      observationsClosed = true;
      if (handle?.result) void Promise.resolve(handle.result).catch(() => undefined);
      // 未调用驱动，或驱动明确证实未发送：失败可释放。其他错误一律保留未知占位。
      const knownNotSent = !invoked || (error instanceof NativeDispatchNotSent && !observationFault);
      if (knownNotSent) {
        try { return this.store.transaction(db => {
          const row = this.#owned(id, fence);
          this.#assertReservation(row, ["dispatching"], null);
          if (row.native_execution_id !== null) throw new Error("EXECUTION_ALREADY_STARTED");
          this.#release(db, row); const now = this.#now();
          db.prepare("UPDATE execution_dispatches SET phase='cancelled',ended_at=? WHERE id=?").run(now, id);
          db.prepare("UPDATE attempts SET state='failed',ended_at=? WHERE id=? AND state='dispatching'").run(now, String(row.attempt_id));
          event(db, String(row.project_id), id, "execution.not_sent", {}, now); return "cancelled";
        }); } catch { return this.#uncertain(id, fence); }
      }
      return this.#uncertain(id, fence);
    }
    try {
      const outcome = await Promise.race([Promise.resolve((handle as NativeExecutionHandle).result), fault, this.#stopSignal]);
      observationsClosed = true;
      if (observationFault || outcome === "observation_fault" || outcome === "coordinator_closed") return this.#uncertain(id, fence);
      if(outcome.status==='unknown')return this.#uncertain(id,fence,outcome.diagnostics);
      return this.store.transaction(db => {
        const row = this.#owned(id, fence); const snapshot = JSON.parse(String(row.snapshot_json)) as Snapshot;
        if (row.phase !== "running" || !sameSession(outcome.session, snapshot.session) || outcome.executionId !== row.native_execution_id || outcome.terminalConfirmed !== true || !["completed", "failed", "interrupted"].includes(outcome.status)) throw new Error("UNCONFIRMED_EXECUTION_TERMINAL");
        this.#assertReservation(row, ["running", "waiting_input"], outcome.executionId);
        this.#release(db, row); const phase = outcome.status === "completed" ? "succeeded" : outcome.status; const now = this.#now();
        db.prepare("UPDATE execution_dispatches SET phase=?,ended_at=? WHERE id=?").run(phase, now, id);
        db.prepare("UPDATE attempts SET state=?,ended_at=? WHERE id=? AND native_execution_id=?").run(phase, now, String(row.attempt_id), outcome.executionId);
        this.#confirmStops(db, row, outcome.executionId, phase);
        event(db, String(row.project_id), id, "execution.finished", { executionId: outcome.executionId, phase, ...(outcome.responseExcerpt !== undefined ? { responseExcerpt: outcome.responseExcerpt } : {}), ...(outcome.diagnostics?{diagnostics:safeExecutionDiagnostic(outcome.diagnostics)}:{}) }, now); return phase;
      });
    } catch (error) {
      observationsClosed = true;
      if (error instanceof NativeDispatchNotSent && !observationFault) {
        try { return this.store.transaction(db => {
          const row=this.#owned(id,fence);
          if (row.phase!=='sending' || row.native_execution_id!==null) throw new Error('EXECUTION_ALREADY_STARTED');
          this.#assertReservation(row,['dispatching'],null);this.#release(db,row);
          const now=this.#now();db.prepare("UPDATE execution_dispatches SET phase='cancelled',ended_at=? WHERE id=?").run(now,id);
          db.prepare("UPDATE attempts SET state='failed',ended_at=? WHERE id=? AND state='dispatching'").run(now,String(row.attempt_id));
          event(db,String(row.project_id),id,'execution.not_sent',{},now);return 'cancelled';
        }); } catch { return this.#uncertain(id,fence); }
      }
      return this.#uncertain(id, fence);
    }
  }

  /** 在新内核取得锁之后调用；不猜测外部动作是否发生，不自动重新发送。 */
  recover(): number {
    this.#assertOwner();
    return this.store.transaction(db => {
      const rows = db.prepare("SELECT * FROM execution_dispatches WHERE owner_key<>? AND phase IN ('reserved','sending','running','unknown')").all(this.#owner);
      for (const row of rows) {
        db.prepare("UPDATE execution_dispatches SET phase='unknown',fence=fence+1,owner_key=? WHERE id=?").run(this.#owner, String(row.id));
        db.prepare("UPDATE attempts SET state='unknown' WHERE id=? AND state IN ('dispatching','running','waiting_input')").run(String(row.attempt_id));
        db.prepare("UPDATE workspace_reservations SET state='unknown' WHERE id=? AND fence=? AND state='reserved'").run(`res-${String(row.attempt_id)}`, Number(row.workspace_fence));
        event(db, String(row.project_id), String(row.id), "execution.recovered_unknown", {}, this.#now());
      }
      const stops = db.prepare("SELECT id,project_id FROM native_control_requests WHERE state='requested'").all();
      for (const stop of stops) {
        if (this.#stopping.has(String(stop.id))) continue;
        db.prepare("UPDATE native_control_requests SET state='uncertain' WHERE id=? AND state='requested'").run(String(stop.id));
        event(db, String(stop.project_id), String(stop.id), "native.stop.recovered_uncertain", {}, this.#now());
      }
      return rows.length;
    });
  }
  get inFlight(): number { return this.#running.size; }
  close(): void { if (this.#running.size || this.#stopping.size || this.#reconciling.size) throw new Error("EXECUTION_STILL_IN_FLIGHT"); this.#closed = true; }
  /** 控制端停止：保存未知边界、停止观测，不擅自取消原生工作或释放原生owner租约。 */
  async detach(): Promise<void> {
    try {
      if (!this.#closed && this.services.isKernelOwner() === true) {
        const rows = this.store.db.prepare("SELECT id,fence FROM execution_dispatches WHERE owner_key=? AND phase IN ('reserved','sending','running')").all(this.#owner);
        for (const row of rows) this.#unknown(String(row.id), Number(row.fence));
      }
    } finally {
      try { for (const id of this.#stopping.keys()) this.#stopUncertain(id, "STOP_COORDINATOR_DETACHED"); }
      finally {
        this.#closed = true; this.#signalStop();
        await Promise.allSettled([...this.#running.values(), ...this.#stopping.values(), ...this.#reconciling.values()]);
      }
    }
  }
}

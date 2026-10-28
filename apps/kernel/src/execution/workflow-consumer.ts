import { randomUUID } from "node:crypto";
import type { Store } from "@projectorch/persistence";
import { canonicalJson } from "@projectorch/persistence/outbox";
import type { ExecutionCoordinator } from "./coordinator.js";
import { advanceReviewWorkflow } from './review-continuation.js';
import {selectFairWorkflowCandidate} from './fair-workflow-selection.js';
import {advanceQuestionWorkflow} from './question-continuation.js';
import {enqueueStartupNoticeWithin} from './startup-notice.js';

export interface WorkflowPumpResult { readonly prepared: number; readonly blocked: number; readonly discarded: number; readonly exhausted: number }
export interface WorkflowRuntime {
  recover(): number;
  pump(): WorkflowPumpResult;
  /** 必须在返回Promise前停止新预约并持久化在途未知边界；不取消原生用户工作。 */
  stop(): Promise<void>;
}
export interface WorkflowConsumerOptions {
  readonly trustedLocalUserId?:string;
  /** 只能由受信启动器按项目/任务/绑定选择已登记目录，不取模型自报路径。 */
  readonly workspaceForTask: (projectId: string, taskId: string, bindingId: string) => string;
  readonly maxPerPump?: number;
  readonly retryDelayMs?: number;
  readonly maxUnexpectedFailures?: number;
}
interface Intent { readonly schemaVersion: 2; readonly event: "workflow.evaluate"; readonly projectId: string; readonly taskId: string; readonly taskRevision: number; readonly specRevision: number }
const token = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128;
function intent(value: unknown): Intent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("WORKFLOW_INVALID_CANDIDATE");
  const p = value as Record<string, unknown>;
  if (p.schemaVersion !== 2 || !Number.isSafeInteger(p.taskRevision) || !Number.isSafeInteger(p.specRevision)) throw new Error("WORKFLOW_UNVERSIONED_CANDIDATE");
  if (p.event !== "workflow.evaluate" || !token(p.projectId) || !token(p.taskId) || Number(p.taskRevision) < 0 || Number(p.specRevision) < 0 || Object.keys(p).some(k => !["schemaVersion", "event", "projectId", "taskId", "taskRevision", "specRevision"].includes(k))) throw new Error("WORKFLOW_INVALID_CANDIDATE");
  return p as unknown as Intent;
}
const expectedBlockers = new Set([
  "WORKFLOW_BINDING_REQUIRED", "WORKFLOW_WORKSPACE_REQUIRED", "WORKFLOW_DRIVER_UNAVAILABLE", "WORKFLOW_PRINCIPAL_UNAVAILABLE",
  "WORKFLOW_UNCERTAIN_CANDIDATE",
  "ZCODE_RUNTIME_NOT_CONFIGURED", "CODEX_RUNTIME_NOT_CONFIGURED",
  "MODEL_SELECTION_UNRESOLVED", "MODEL_SELECTION_UNAVAILABLE",
  "TASK_EXECUTION_INPUT_TOO_LARGE",
  "COST_ENFORCEMENT_UNAVAILABLE",
  "DISPATCH_TASK_NOT_OWNED", "DISPATCH_FORBIDDEN", "DISPATCH_HELD", "STARTUP_REQUIRED", "STARTUP_TASK_SPEC_REQUIRED",
  "TASK_START_CONDITIONS_UNMET", "NATIVE_EXECUTION_DISABLED", "POLICY_PROFILE_REVISION_CONFLICT", "WORKSPACE_NOT_AVAILABLE",
  "WORKSPACE_IDENTITY_CHANGED", "WORKSPACE_PATH_OUT_OF_SCOPE", "PATH_ENFORCEMENT_UNAVAILABLE", "NATIVE_SESSION_MISMATCH",
  "NATIVE_IDENTITY_MISMATCH", "NATIVE_CAPABILITY_UNVERIFIED", "DISPATCH_CONCURRENCY_EXCEEDED", "DISPATCH_ATTEMPTS_EXCEEDED",
  "UNKNOWN_EXECUTION", "WORKSPACE_CONFLICT", "INPUT_ARTIFACT_NOT_FOUND", "GATE_NOT_VERIFIED", "DISPATCH_DENIED",
  "UNAUTHENTICATED", "AGENT_UNAUTHENTICATED", "AGENT_CREDENTIAL_EXPIRED", "AGENT_CREDENTIAL_REVOKED", "AGENT_BINDING_STALE",
]);
const discarded = new Set(["WORKFLOW_INVALID_CANDIDATE", "WORKFLOW_UNVERSIONED_CANDIDATE", "WORKFLOW_PROJECT_MISMATCH", "WORKFLOW_STALE_CANDIDATE", "WORKFLOW_TASK_NOT_FOUND", "WORKFLOW_TASK_NOT_READY", "WORKFLOW_COMMAND_NOT_COMPLETED"]);
function errorCode(error: unknown): string {
  const code = error instanceof Error ? error.message.split(":")[0] ?? "" : "";
  return expectedBlockers.has(code) || discarded.has(code) ? code : "WORKFLOW_PREPARATION_FAILED";
}

/** 仅消费内部候选：同事务准备+回执，原生run在提交后启动，不等待模型来保持队列推进。 */
export class WorkflowConsumer implements WorkflowRuntime {
  #closed = false;
  readonly #running = new Map<string, Promise<unknown>>();
  readonly #reconciling=new Map<string,Promise<unknown>>();
  readonly #nextObservation=new Map<string,number>();
  #lastRunError: string | null = null;
  readonly #max: number;
  readonly #delay: number;
  readonly #failures: number;
  constructor(readonly store: Store, readonly coordinator: ExecutionCoordinator, readonly options: WorkflowConsumerOptions) {
    this.#max = options.maxPerPump ?? 8; this.#delay = options.retryDelayMs ?? 5000; this.#failures = options.maxUnexpectedFailures ?? 5;
    if (coordinator.store !== store || typeof options.workspaceForTask !== "function" || options.workspaceForTask.constructor.name === "AsyncFunction" || !Number.isSafeInteger(this.#max) || this.#max < 1 || this.#max > 64 || !Number.isSafeInteger(this.#delay) || this.#delay < 1 || this.#delay > 300000 || !Number.isSafeInteger(this.#failures) || this.#failures < 1 || this.#failures > 64) throw new Error("INVALID_WORKFLOW_OPTIONS");
  }
  #assertOwner(): void { if (this.#closed || this.coordinator.services.isKernelOwner() !== true) throw new Error("WORKFLOW_OWNER_LOST"); }
  #now(): number { const now = this.coordinator.services.now(); if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + this.#delay)) throw new Error("INVALID_WORKFLOW_TIME"); return now; }
  recover(): number { this.#assertOwner(); return this.coordinator.recover(); }
  #consumeOne(): { decision: "prepared" | "blocked" | "discarded" | "exhausted"; dispatchId: string | null } | null {
    return this.store.transaction(db => {
      this.#assertOwner(); const now = this.#now();
      const row = selectFairWorkflowCandidate(db,now);
      if (!row) return null;
      const old = db.prepare("SELECT decision,code,failure_count FROM workflow_evaluations WHERE outbox_id=?").get(String(row.id));
      let decision: "prepared" | "blocked" | "discarded" | "exhausted" = "prepared"; let code = "WORKFLOW_PREPARED"; let dispatchId: string | null = null; let taskId: string | null = null; let failures = Number(old?.failure_count ?? 0);
      db.exec("SAVEPOINT workflow_prepare");
      try {
        if (row.command_state !== "completed") throw new Error("WORKFLOW_COMMAND_NOT_COMPLETED");
        const p = intent(JSON.parse(String(row.payload_json)));
        if (p.projectId !== row.project_id) throw new Error("WORKFLOW_PROJECT_MISMATCH");
        const task = db.prepare("SELECT id,role_id,state,revision,spec_revision FROM tasks WHERE id=? AND project_id=?").get(p.taskId, p.projectId);
        if (!task) throw new Error("WORKFLOW_TASK_NOT_FOUND");
        taskId = p.taskId;
        if (task.revision !== p.taskRevision || task.spec_revision !== p.specRevision) throw new Error("WORKFLOW_STALE_CANDIDATE");
        if (!["draft", "ready"].includes(String(task.state))) throw new Error("WORKFLOW_TASK_NOT_READY");
        if (db.prepare("SELECT 1 FROM outbox o JOIN commands c ON c.id=o.command_id WHERE o.id<>? AND c.project_id=? AND o.state IN ('dispatching','uncertain') AND json_extract(o.payload_json,'$.event')='workflow.evaluate' AND json_extract(o.payload_json,'$.taskId')=?").get(String(row.id), p.projectId, p.taskId)) throw new Error("WORKFLOW_UNCERTAIN_CANDIDATE");
        const binding = db.prepare("SELECT id FROM role_bindings WHERE project_id=? AND role_id=? AND ended_at IS NULL").get(p.projectId, String(task.role_id));
        if (!binding) throw new Error("WORKFLOW_BINDING_REQUIRED");
        const principal = this.coordinator.services.principalForBinding(String(binding.id));
        if (principal.projectId !== p.projectId || principal.roleId !== task.role_id || principal.bindingId !== binding.id) throw new Error("WORKFLOW_PROJECT_MISMATCH");
        const workspaceId = this.options.workspaceForTask(p.projectId, p.taskId, String(binding.id));
        if (!token(workspaceId)) throw new Error("WORKFLOW_WORKSPACE_REQUIRED");
        dispatchId = this.coordinator.prepareWithin(principal, { requestKey: `workflow:${String(row.id)}`, taskId: p.taskId, workspaceId });
        db.exec("RELEASE workflow_prepare");
      } catch (error) {
        db.exec("ROLLBACK TO workflow_prepare; RELEASE workflow_prepare");
        dispatchId = null; code = errorCode(error);
        // 原生/工具错误正文可能含请求或凭据，诊断只保留已分类的固定代码。
        if (discarded.has(code)) decision = "discarded";
        else if (expectedBlockers.has(code)) decision = "blocked";
        else { failures++; decision = failures >= this.#failures ? "exhausted" : "blocked"; }
      }
      if(decision==='blocked'&&taskId&&['STARTUP_REQUIRED','STARTUP_TASK_SPEC_REQUIRED'].includes(code)){
        try{enqueueStartupNoticeWithin(this.store,{projectId:String(row.project_id),taskId,commandId:String(row.command_id),now,principalForBinding:id=>this.coordinator.services.principalForBinding(id),...(this.options.trustedLocalUserId?{trustedLocalUserId:this.options.trustedLocalUserId}:{})});}catch{/* 凭据/权限或通知来源不可用时保留原阻塞，不代角色确认。 */}
      }
      // 只声明内部评估；不能用历史回执的false字段推断后来没有外部副作用。
      const receipt = { scope: "workflow_preparation", decision, code, dispatchId, nativeExecution: "not_asserted" };
      if (decision === "blocked") db.prepare("UPDATE outbox SET next_attempt_at=?,native_receipt_json=? WHERE id=? AND state='pending'").run(now + this.#delay, canonicalJson(receipt), String(row.id));
      else db.prepare("UPDATE outbox SET state=?,lease_epoch=lease_epoch+1,lease_until=NULL,attempts=attempts+1,native_receipt_json=? WHERE id=? AND state='pending'").run(decision === "exhausted" ? "exhausted" : "delivered", canonicalJson(receipt), String(row.id));
      db.prepare("INSERT INTO workflow_evaluations(outbox_id,project_id,task_id,decision,code,dispatch_id,check_count,failure_count,checked_at) VALUES(?,?,?,?,?,?,1,?,?) ON CONFLICT(outbox_id) DO UPDATE SET task_id=excluded.task_id,decision=excluded.decision,code=excluded.code,dispatch_id=excluded.dispatch_id,check_count=workflow_evaluations.check_count+1,failure_count=excluded.failure_count,checked_at=excluded.checked_at")
        .run(String(row.id), String(row.project_id), taskId, decision, code, dispatchId, failures, now);
      if (!old || old.decision !== decision || old.code !== code) db.prepare("INSERT INTO events(id,project_id,type,entity_id,entity_revision,causation_id,body_json,occurred_at) VALUES(?,?,?,?,0,?,?,?)")
        .run(randomUUID(), String(row.project_id), `workflow.${decision}`, taskId ?? String(row.id), String(row.command_id), canonicalJson({ outboxId: row.id, ...receipt }), now);
      return { decision, dispatchId };
    });
  }
  pump(): WorkflowPumpResult {
    this.#assertOwner();
    const observationTime=this.#now();
    for(const row of this.store.db.prepare("SELECT id FROM execution_dispatches WHERE phase='unknown' AND native_execution_id IS NOT NULL ORDER BY created_at LIMIT ?").all(this.#max)){
      const id=String(row.id);
      if(this.#reconciling.has(id)||(this.#nextObservation.get(id)??0)>observationTime)continue;
      this.#nextObservation.set(id,observationTime+30000);
      const work=this.coordinator.reconcile(id).catch(()=>undefined).finally(()=>{this.#reconciling.delete(id);});
      this.#reconciling.set(id,work);
    }
    advanceReviewWorkflow(this.store,this.#now(),this.#max);
    advanceQuestionWorkflow(this.store,this.#now(),this.#max);
    this.coordinator.consumeStopRequests(this.#max);
    const counts = { prepared: 0, blocked: 0, discarded: 0, exhausted: 0 };
    for (let i = 0; i < this.#max; i++) {
      const work = this.#consumeOne(); if (!work) break;
      counts[work.decision]++;
      if (work.dispatchId) {
        const id = work.dispatchId;
        const run = this.coordinator.run(id).catch(() => { this.#lastRunError = "EXECUTION_RUN_FAILED"; }).finally(() => { this.#running.delete(id); });
        this.#running.set(id, run);
      }
    }
    return Object.freeze(counts);
  }
  snapshot(): { readonly inFlight: number; readonly lastRunError: string | null } { return Object.freeze({ inFlight: this.#running.size, lastRunError: this.#lastRunError }); }
  async stop(): Promise<void> { this.#closed = true; await this.coordinator.detach(); await Promise.allSettled([...this.#running.values(),...this.#reconciling.values()]); }
}

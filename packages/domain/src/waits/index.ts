/** T032准备切片：等待、取消与互等处理。等待=任务绑定代次+target（question/issue/goal_hold）+deadline+超时策略（raise_issue/cancel_attempt）；
 * 取消请求与停止确认分离：requestCancel只写取消请求（wait state=cancelled + 任务waiting），确认由适配器完成（R021取消≠停止确认）；
 * 互等检测=两个任务互相等待对方target的环检测；超时=deadline到达按on_timeout处置。 */
import type { Store } from "@projectorch/persistence";
import {isDeepStrictEqual} from 'node:util';

export type WaitTarget = { readonly kind: "question"; readonly questionId: string } | { readonly kind: "issue"; readonly caseId: string } | { readonly kind: "goal_hold"; readonly holdId: string } | { readonly kind: "message"; readonly messageId: string } | { readonly kind: "task"; readonly taskId: string } | { readonly kind: "external"; readonly externalRef: string };

export interface WaitView {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly attemptId: string;
  readonly bindingEpoch: number;
  readonly target: WaitTarget;
  readonly deadline: number;
  readonly onTimeout: "raise_issue" | "cancel_attempt";
  readonly state: "waiting" | "resolved" | "expired" | "cancelled" | "stale";
}

const text = (value: unknown, label: string, max: number): string => {
  if (typeof value !== "string" || !value || value.length > max || /[\r\n\0]/.test(value)) throw new Error(`INVALID_WAIT_${label}`);
  return value;
};
const clock = (now: number): void => { if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_WAIT_TIME"); };

function parseTarget(value: unknown): WaitTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_WAIT_TARGET");
  const raw = value as Record<string, unknown>;
  if (raw.kind === "question" && typeof raw.questionId === "string") return Object.freeze({ kind: "question", questionId: raw.questionId });
  if (raw.kind === "issue" && typeof raw.caseId === "string") return Object.freeze({ kind: "issue", caseId: raw.caseId });
  if (raw.kind === "goal_hold" && typeof raw.holdId === "string") return Object.freeze({ kind: "goal_hold", holdId: raw.holdId });
  if (raw.kind === "message" && typeof raw.messageId === "string") return Object.freeze({ kind: "message", messageId: raw.messageId });
  if (raw.kind === "task" && typeof raw.taskId === "string") return Object.freeze({ kind: "task", taskId: raw.taskId });
  if (raw.kind === "external" && typeof raw.externalRef === "string") return Object.freeze({ kind: "external", externalRef: raw.externalRef });
  throw new Error("INVALID_WAIT_TARGET");
}
function targetKey(target: WaitTarget): string {
  if (target.kind === "question") return `question:${target.questionId}`;
  if (target.kind === "issue") return `issue:${target.caseId}`;
  if (target.kind === "message") return `message:${target.messageId}`;
  if (target.kind === "task") return `task:${target.taskId}`;
  if (target.kind === "external") return `external:${target.externalRef}`;
  return `goal_hold:${target.holdId}`;
}

function viewOf(row: Record<string, unknown>): WaitView {
  return Object.freeze({ id: String(row.id), projectId: String(row.project_id), taskId: String(row.task_id), taskRevision: Number(row.task_revision), attemptId: String(row.attempt_id), bindingEpoch: Number(row.binding_epoch), target: parseTarget(JSON.parse(String(row.target_json))), deadline: Number(row.deadline), onTimeout: String(row.on_timeout) as WaitView["onTimeout"], state: String(row.state) as WaitView["state"] });
}

/** 创建等待：任务须waiting态；同一target已被其他任务等待→互等环拒绝（WAIT_DEADLOCK）；deadline必须未来。 */
export function createWait(store: Store, input: { readonly id: unknown; readonly projectId: unknown; readonly taskId: unknown; readonly taskRevision: unknown; readonly attemptId: unknown; readonly bindingId: unknown; readonly bindingEpoch: unknown; readonly target: unknown; readonly deadline: unknown; readonly onTimeout: unknown }, now: number): WaitView {
  clock(now);
  const id = text(input.id, "ID", 128);
  const bindingId = text(input.bindingId, "BINDING", 128);
  const projectId = text(input.projectId, "PROJECT", 128);
  const taskId = text(input.taskId, "TASK", 128);
  const taskRevision = input.taskRevision;
  if (typeof taskRevision !== "number" || !Number.isSafeInteger(taskRevision) || taskRevision < 0) throw new Error("INVALID_WAIT_REVISION");
  const attemptId = text(input.attemptId, "ATTEMPT", 128);
  const bindingEpoch = input.bindingEpoch;
  if (typeof bindingEpoch !== "number" || !Number.isSafeInteger(bindingEpoch) || bindingEpoch < 1) throw new Error("INVALID_WAIT_EPOCH");
  const target = parseTarget(input.target);
  const deadline = input.deadline;
  if (typeof deadline !== "number" || !Number.isSafeInteger(deadline) || deadline <= now) throw new Error("INVALID_WAIT_DEADLINE");
  const onTimeout = input.onTimeout;
  if (onTimeout !== "raise_issue" && onTimeout !== "cancel_attempt") throw new Error("INVALID_WAIT_TIMEOUT_POLICY");
  return store.transaction(db => {
    if (!db.prepare("SELECT 1 FROM tasks WHERE id=? AND project_id=? AND state='waiting'").get(taskId, projectId)) throw new Error("WAIT_TASK_NOT_WAITING");
    if (!db.prepare("SELECT 1 FROM task_revisions WHERE task_id=? AND project_id=? AND revision=?").get(taskId, projectId, taskRevision)) throw new Error("WAIT_REVISION_NOT_FOUND");
    if (!db.prepare("SELECT 1 FROM attempts WHERE id=? AND project_id=? AND task_id=? AND task_revision=? AND binding_id=? AND binding_epoch=?").get(attemptId, projectId, taskId, taskRevision,bindingId,bindingEpoch)) throw new Error("WAIT_ATTEMPT_NOT_FOUND");
    // 互等检测：目标target已被其他waiting任务占用→环
    const key = targetKey(target);
    const conflicting = db.prepare("SELECT id,task_id FROM waits WHERE project_id=? AND state='waiting' AND target_json=?").all(projectId, JSON.stringify(target)) as { id: string; task_id: string }[];
    if (conflicting.length > 0 && conflicting.some(row => String(row.task_id) !== taskId)) throw new Error("WAIT_DEADLOCK");
    db.prepare("INSERT INTO waits(id,project_id,task_id,task_revision,attempt_id,binding_id,binding_epoch,target_json,deadline,on_timeout,state) VALUES(?,?,?,?,?,?,?,?,?,?,'waiting')").run(id, projectId, taskId, taskRevision, attemptId, bindingId, bindingEpoch, JSON.stringify(target), deadline, onTimeout);
    const row = db.prepare("SELECT id,project_id,task_id,task_revision,attempt_id,binding_epoch,target_json,deadline,on_timeout,state FROM waits WHERE id=? AND project_id=?").get(id, projectId) as Record<string, unknown>;
    return viewOf(row);
  });
}

/** 解决等待：waiting→resolved（target已满足）。 */
export function resolveWait(store: Store, projectId: string, waitId: string, now: number): WaitView {
  clock(now);
  return store.transaction(db => {
    const row = db.prepare("SELECT state FROM waits WHERE id=? AND project_id=?").get(waitId, projectId) as { state: string } | undefined;
    if (!row) throw new Error("WAIT_NOT_FOUND");
    if (row.state !== "waiting") throw new Error("WAIT_TRANSITION_REJECTED");
    db.prepare("UPDATE waits SET state='resolved' WHERE id=? AND project_id=?").run(waitId, projectId);
    const updated = db.prepare("SELECT id,project_id,task_id,task_revision,attempt_id,binding_epoch,target_json,deadline,on_timeout,state FROM waits WHERE id=? AND project_id=?").get(waitId, projectId) as Record<string, unknown>;
    return viewOf(updated);
  });
}

/** 取消请求（与停止确认分离，R021）：waiting→cancelled只表示请求方撤回等待；返回值含requested标记，停止确认由适配器另行记录。 */
export function cancelWait(store: Store, projectId: string, waitId: string, now: number): WaitView & { readonly cancelRequested: true } {
  clock(now);
  return store.transaction(db => {
    const row = db.prepare("SELECT state FROM waits WHERE id=? AND project_id=?").get(waitId, projectId) as { state: string } | undefined;
    if (!row) throw new Error("WAIT_NOT_FOUND");
    if (row.state !== "waiting") throw new Error("WAIT_TRANSITION_REJECTED");
    db.prepare("UPDATE waits SET state='cancelled' WHERE id=? AND project_id=?").run(waitId, projectId);
    const updated = db.prepare("SELECT id,project_id,task_id,task_revision,attempt_id,binding_epoch,target_json,deadline,on_timeout,state FROM waits WHERE id=? AND project_id=?").get(waitId, projectId) as Record<string, unknown>;
    return Object.freeze({ ...viewOf(updated), cancelRequested: true as const });
  });
}

/** 超时处置：deadline已过的waiting等待，按on_timeout返回处置动作（raise_issue/cancel_attempt）；不直接执行处置——返回给调用方（域纯函数语义），执行由调用方域操作完成。 */
export function expiredWaits(store: Store, projectId: string, now: number): readonly { readonly waitId: string; readonly onTimeout: "raise_issue" | "cancel_attempt" }[] {
  clock(now);
  return Object.freeze((store.db.prepare("SELECT id,on_timeout FROM waits WHERE project_id=? AND state='waiting' AND deadline<=?").all(projectId, now) as Record<string, unknown>[]).map(row => ({ waitId: String(row.id), onTimeout: String(row.on_timeout) as "raise_issue" | "cancel_attempt" })));
}

export function readWait(store: Store, projectId: string, waitId: string): WaitView {
  const row = store.db.prepare("SELECT id,project_id,task_id,task_revision,attempt_id,binding_epoch,target_json,deadline,on_timeout,state FROM waits WHERE id=? AND project_id=?").get(waitId, projectId);
  if (!row) throw new Error("WAIT_NOT_FOUND");
  return viewOf(row as Record<string, unknown>);
}

/** 超时处置执行（T068）：deadline已过的waiting→expired（与并发回复单事务竞争，谁先提交谁生效）。返回处置动作供调用方执行域操作。 */
export function processExpiredWaits(store: Store, projectId: string, now: number): readonly { readonly waitId: string; readonly onTimeout: "raise_issue" | "cancel_attempt" }[] {
  const expired = expiredWaits(store, projectId, now);
  return store.transaction(db => {
    const applied: { waitId: string; onTimeout: "raise_issue" | "cancel_attempt" }[] = [];
    for (const item of expired) {
      const changed = db.prepare("UPDATE waits SET state='expired' WHERE id=? AND project_id=? AND state='waiting'").run(item.waitId, projectId);
      if (Number(changed.changes) === 1) applied.push(item);
    }
    return Object.freeze(applied);
  });
}

/** T068：按问题解阻等待（A092）。新鲜度三重校验（attempt仍是本等待记录的、绑定代次仍当前、任务规格仍同版本）——
 * 换绑/改规格后的迟回答案不解阻（wait标stale，答案仅记录）。当前问题只解阻一次（状态机单次迁移）。 */
export function resolveWaitByQuestion(store: Store, input: { readonly projectId: string; readonly questionId: string; readonly answer: unknown }, now: number): { readonly unblocked: boolean; readonly waitState: "resolved" | "stale" | null } {
  clock(now);
  if (input.answer === undefined || input.answer === null || typeof input.answer !== "object" || Array.isArray(input.answer)) throw new Error("INVALID_WAIT_ANSWER");
  return store.transaction(db => {
    const wait = db.prepare("SELECT id,task_id,task_revision,attempt_id,binding_id,binding_epoch,state,deadline FROM waits WHERE project_id=? AND state='waiting' AND target_json=?").get(input.projectId, JSON.stringify({ kind: "question", questionId: input.questionId })) as Record<string, unknown> | undefined;
    if (!wait) return { unblocked: false, waitState: null };
    const question=db.prepare('SELECT * FROM questions WHERE id=? AND project_id=? AND task_id=? AND task_revision=? AND attempt_id=? AND binding_id=? AND binding_epoch=?').get(input.questionId,input.projectId,String(wait.task_id),Number(wait.task_revision),String(wait.attempt_id),String(wait.binding_id),Number(wait.binding_epoch));
    if(!question)throw new Error('WAIT_QUESTION_TARGET_MISMATCH');
    if(question.state==='answered'&&!isDeepStrictEqual(JSON.parse(String(question.answer)),input.answer))throw new Error('WAIT_ANSWER_IMMUTABLE');
    if(!['open','answered'].includes(String(question.state))||(question.state!=='answered'&&(Number(question.deadline)<=now||Number(wait.deadline)<=now)))return {unblocked:false,waitState:null};
    const attempt = db.prepare("SELECT state FROM attempts WHERE id=? AND project_id=? AND task_id=? AND task_revision=? AND binding_id=? AND binding_epoch=?").get(String(wait.attempt_id), input.projectId, String(wait.task_id), Number(wait.task_revision),String(wait.binding_id),Number(wait.binding_epoch)) as { state: string } | undefined;
    const binding = db.prepare("SELECT epoch,ended_at,role_id FROM role_bindings WHERE id=? AND project_id=? AND epoch=?").get(String(wait.binding_id), input.projectId, Number(wait.binding_epoch)) as { epoch: number; ended_at: number | null; role_id: string } | undefined;
    const latestEpoch = binding ? db.prepare("SELECT MAX(epoch) AS e FROM role_bindings WHERE project_id=? AND role_id=? AND ended_at IS NULL").get(input.projectId, String(binding.role_id)) as { e: number } : undefined;
    const task = db.prepare("SELECT spec_revision FROM tasks WHERE id=? AND project_id=?").get(String(wait.task_id), input.projectId) as { spec_revision: number } | undefined;
    const fresh = attempt !== undefined && (attempt.state === "waiting_input" || attempt.state === "running" || attempt.state === "dispatching") && binding !== undefined && binding.ended_at === null && latestEpoch !== undefined && Number(latestEpoch.e) === Number(wait.binding_epoch) && task !== undefined && Number(task.spec_revision) === Number(wait.task_revision);
    if (!fresh) {
      db.prepare("UPDATE waits SET state='stale' WHERE id=? AND state='waiting'").run(String(wait.id));
      db.prepare("UPDATE questions SET answer=?,revision=revision+1 WHERE id=? AND project_id=? AND state='open'").run(JSON.stringify({ ...input.answer as Record<string, unknown>, late: true }), input.questionId, input.projectId);
      return { unblocked: false, waitState: "stale" as const };
    }
    if(question.state!=='answered')return {unblocked:false,waitState:null};
    db.prepare("UPDATE waits SET state='resolved' WHERE id=? AND state='waiting'").run(String(wait.id));
    db.prepare("UPDATE questions SET answer=?,state='answered',revision=revision+1 WHERE id=? AND project_id=? AND state='open'").run(JSON.stringify(input.answer), input.questionId, input.projectId);
    return { unblocked: true, waitState: "resolved" as const };
  });
}

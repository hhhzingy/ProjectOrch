/** T068：持久业务问题。问题绑定attempt/binding代次/任务版本，重启持久；回答者身份由连接主体核验——
 * 用户回答必须来自已认证用户主体（伪造user回答=FORGED_USER_ANSWER），角色回答限定本人角色。回答不等任务完成。 */
import type { Store } from "@projectorch/persistence";

export interface QuestionView {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly attemptId: string;
  readonly bindingEpoch: number;
  readonly answererKind: "user" | "role";
  readonly answererRoleId: string | null;
  readonly prompt: string;
  readonly answer: unknown;
  readonly deadline: number;
  readonly state: "open" | "answered" | "expired" | "cancelled";
  readonly revision: number;
}

const text = (value: unknown, label: string, max: number): string => {
  if (typeof value !== "string" || !value || value.length > max || /[\r\n\0]/.test(value)) throw new Error(`INVALID_QUESTION_${label}`);
  return value;
};
const clock = (now: number): void => { if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_QUESTION_TIME"); };

function viewOf(row: Record<string, unknown>): QuestionView {
  return Object.freeze({ id: String(row.id), projectId: String(row.project_id), taskId: String(row.task_id), taskRevision: Number(row.task_revision), attemptId: String(row.attempt_id), bindingEpoch: Number(row.binding_epoch), answererKind: String(row.answerer_kind) as QuestionView["answererKind"], answererRoleId: row.answerer_role_id === null ? null : String(row.answerer_role_id), prompt: String(row.prompt), answer: row.answer === null ? null : JSON.parse(String(row.answer)), deadline: Number(row.deadline), state: String(row.state) as QuestionView["state"], revision: Number(row.revision) });
}

export function askQuestion(store: Store, input: { readonly id: unknown; readonly projectId: unknown; readonly taskId: unknown; readonly taskRevision: unknown; readonly attemptId: unknown; readonly bindingId: unknown; readonly bindingEpoch: unknown; readonly prompt: unknown; readonly answererKind: unknown; readonly answererRoleId?: unknown; readonly deadline: unknown }, now: number): QuestionView {
  clock(now);
  const id = text(input.id, "ID", 128);
  const projectId = text(input.projectId, "PROJECT", 128);
  const taskId = text(input.taskId, "TASK", 128);
  const attemptId = text(input.attemptId, "ATTEMPT", 128);
  const bindingId = text(input.bindingId, "BINDING", 128);
  const prompt = text(input.prompt, "PROMPT", 16384);
  const taskRevision = input.taskRevision;
  const bindingEpoch = input.bindingEpoch;
  const deadline = input.deadline;
  if (typeof taskRevision !== "number" || !Number.isSafeInteger(taskRevision) || taskRevision < 0) throw new Error("INVALID_QUESTION_REVISION");
  if (typeof bindingEpoch !== "number" || !Number.isSafeInteger(bindingEpoch) || bindingEpoch < 1) throw new Error("INVALID_QUESTION_EPOCH");
  if (typeof deadline !== "number" || !Number.isSafeInteger(deadline)) throw new Error("INVALID_QUESTION_DEADLINE");
  const answererKind = input.answererKind;
  if (answererKind !== "user" && answererKind !== "role") throw new Error("INVALID_QUESTION_ANSWERER");
  const answererRoleId = answererKind === "role" ? text(input.answererRoleId, "ANSWERER_ROLE", 128) : null;
  return store.transaction(db => {
    if (!db.prepare("SELECT 1 FROM attempts WHERE id=? AND project_id=? AND task_id=? AND task_revision=?").get(attemptId, projectId, taskId, taskRevision)) throw new Error("QUESTION_ATTEMPT_NOT_FOUND");
    if (!db.prepare("SELECT 1 FROM role_bindings WHERE id=? AND project_id=? AND epoch=?").get(bindingId, projectId, bindingEpoch)) throw new Error("QUESTION_BINDING_NOT_FOUND");
    db.prepare("INSERT INTO questions(id,project_id,task_id,task_revision,attempt_id,binding_id,binding_epoch,answerer_kind,answerer_role_id,prompt,answer,deadline,state) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,'open')").run(id, projectId, taskId, taskRevision, attemptId, bindingId, bindingEpoch, answererKind, answererRoleId, prompt, deadline);
    return viewOf(db.prepare("SELECT * FROM questions WHERE id=? AND project_id=?").get(id, projectId) as Record<string, unknown>);
  });
}

export type AnswererPrincipal = { readonly kind: "authenticated_user" } | { readonly kind: "bound_agent"; readonly roleId: string };

/** 回答：user问题仅限已认证用户主体（伪造→FORGED_USER_ANSWER）；role问题限本人角色；open才可答（answered/expired/cancelled显式拒绝）。重启后回答同路径（持久）。 */
export function answerQuestion(store: Store, input: { readonly projectId: string; readonly questionId: string; readonly answer: unknown; readonly principal: AnswererPrincipal }, now: number): QuestionView {
  clock(now);
  if (input.answer === undefined || input.answer === null || typeof input.answer !== "object" || Array.isArray(input.answer)) throw new Error("INVALID_QUESTION_ANSWER");
  return store.transaction(db => {
    const row = db.prepare("SELECT * FROM questions WHERE id=? AND project_id=?").get(input.questionId, input.projectId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("QUESTION_NOT_FOUND");
    if (String(row.state) !== "open") throw new Error("QUESTION_NOT_OPEN");
    if (String(row.answerer_kind) === "user") {
      if (input.principal.kind !== "authenticated_user") throw new Error("FORGED_USER_ANSWER");
    } else {
      if (input.principal.kind !== "bound_agent" || input.principal.roleId !== String(row.answerer_role_id)) throw new Error("QUESTION_NOT_ADDRESSEE");
    }
    if(Number(row.deadline)<=now)throw new Error('QUESTION_DEADLINE_EXPIRED');
    db.prepare("UPDATE questions SET answer=?,state='answered',revision=revision+1 WHERE id=? AND project_id=? AND state='open'").run(JSON.stringify(input.answer), input.questionId, input.projectId);
    return viewOf(db.prepare("SELECT * FROM questions WHERE id=? AND project_id=?").get(input.questionId, input.projectId) as Record<string, unknown>);
  });
}

/** 超期问题：deadline已过的open→expired（与回答竞争，单事务先到先得）。 */
export function expireOpenQuestions(store: Store, projectId: string, now: number): number {
  clock(now);
  return store.transaction(db => Number(db.prepare("UPDATE questions SET state='expired',revision=revision+1 WHERE project_id=? AND state='open' AND deadline<=?").run(projectId, now).changes));
}

export function readQuestion(store: Store, projectId: string, questionId: string): QuestionView {
  const row = store.db.prepare("SELECT * FROM questions WHERE id=? AND project_id=?").get(questionId, projectId);
  if (!row) throw new Error("QUESTION_NOT_FOUND");
  return viewOf(row as Record<string, unknown>);
}

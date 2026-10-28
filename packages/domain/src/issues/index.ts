/** T033准备切片：异常事项与升级。raise=同fingerprint的未决case合并（evidence追加、不动状态），新指纹建open；
 * 状态机 open→assigned→deciding→applying→monitoring→resolved，deciding→escalated升级（管理者入口）；
 * 全部转移带expectedRevision乐观并发；resolved/escalated为终态。 */
import type { Store } from "@projectorch/persistence";

export type CaseState = "open" | "assigned" | "deciding" | "applying" | "monitoring" | "resolved" | "escalated";

export interface CaseView {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string | null;
  readonly ownerRoleId: string | null;
  readonly fingerprint: string;
  readonly state: CaseState;
  readonly revision: number;
}

const text = (value: unknown, label: string, max: number): string => {
  if (typeof value !== "string" || !value || value.length > max || /[\r\n\0]/.test(value)) throw new Error(`INVALID_CASE_${label}`);
  return value;
};
const clock = (now: number): void => { if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_CASE_TIME"); };

function viewOf(row: Record<string, unknown>): CaseView {
  return Object.freeze({ id: String(row.id), projectId: String(row.project_id), taskId: row.task_id === null ? null : String(row.task_id), ownerRoleId: row.owner_role_id === null ? null : String(row.owner_role_id), fingerprint: String(row.fingerprint), state: String(row.state) as CaseState, revision: Number(row.revision) });
}
function getRow(store: Store, projectId: string, caseId: string): Record<string, unknown> {
  const row = store.db.prepare("SELECT id,project_id,task_id,owner_role_id,fingerprint,state,revision,evidence_json FROM cases WHERE id=? AND project_id=?").get(caseId, projectId);
  if (!row) throw new Error("CASE_NOT_FOUND");
  return row as Record<string, unknown>;
}

export interface RaiseResult { readonly caseView: CaseView; readonly merged: boolean }

/** 提出异常：fingerprint为去重键（如任务+异常类型的稳定摘要）。存在同指纹未决case→合并（evidence追加），否则新建。 */
export function raiseIssueWithin(db: Parameters<Parameters<Store["transaction"]>[0]>[0], input: { readonly id: unknown; readonly projectId: unknown; readonly taskId?: unknown; readonly ownerRoleId?: unknown; readonly fingerprint: unknown; readonly evidence: unknown }, now: number): RaiseResult {
  clock(now);
  const id = text(input.id, "ID", 128);
  const projectId = text(input.projectId, "PROJECT", 128);
  const taskId = input.taskId === undefined || input.taskId === null ? null : text(input.taskId, "TASK", 128);
  const ownerRoleId = input.ownerRoleId === undefined || input.ownerRoleId === null ? null : text(input.ownerRoleId, "OWNER", 128);
  const fingerprint = text(input.fingerprint, "FINGERPRINT", 256);
  if (input.evidence === undefined || typeof input.evidence !== "object" || Array.isArray(input.evidence)) throw new Error("INVALID_CASE_EVIDENCE");
  {
    if (!db.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)) throw new Error("CASE_PROJECT_NOT_FOUND");
    if (taskId !== null && !db.prepare("SELECT 1 FROM tasks WHERE id=? AND project_id=?").get(taskId, projectId)) throw new Error("CASE_TASK_NOT_FOUND");
    if (ownerRoleId !== null && !db.prepare("SELECT 1 FROM roles WHERE id=? AND project_id=?").get(ownerRoleId, projectId)) throw new Error("CASE_ROLE_NOT_FOUND");
    const open = db.prepare("SELECT id,project_id,task_id,owner_role_id,fingerprint,state,revision,evidence_json FROM cases WHERE fingerprint=? AND project_id=? AND state NOT IN ('resolved','escalated') ORDER BY revision LIMIT 1").get(fingerprint, projectId) as Record<string, unknown> | undefined;
    if (open !== undefined) {
      const evidence = JSON.parse(String(open.evidence_json)) as unknown[];
      evidence.push({ raisedAt: now, byCase: id, evidence: input.evidence });
      db.prepare("UPDATE cases SET evidence_json=?,revision=revision+1 WHERE id=? AND project_id=?").run(JSON.stringify(evidence), String(open.id), projectId);
      const updated = db.prepare("SELECT id,project_id,task_id,owner_role_id,fingerprint,state,revision FROM cases WHERE id=? AND project_id=?").get(String(open.id), projectId) as Record<string, unknown>;
      return { caseView: viewOf(updated), merged: true };
    }
    db.prepare("INSERT INTO cases(id,project_id,task_id,owner_role_id,fingerprint,state,revision,evidence_json) VALUES(?,?,?,?,?,'open',1,?)").run(id, projectId, taskId, ownerRoleId, fingerprint, JSON.stringify([{ raisedAt: now, byCase: id, evidence: input.evidence }]));
    const row = db.prepare("SELECT id,project_id,task_id,owner_role_id,fingerprint,state,revision FROM cases WHERE id=? AND project_id=?").get(id, projectId) as Record<string, unknown>;
    return { caseView: viewOf(row), merged: false };
  }
}

export function raiseIssue(store: Store, input: Parameters<typeof raiseIssueWithin>[1], now: number): RaiseResult {
  return store.transaction(db => raiseIssueWithin(db, input, now));
}

/** 状态机白名单；全部转移要求expectedRevision匹配（乐观并发）。 */
const transitions: Record<CaseState, readonly CaseState[]> = {
  open: ["assigned", "resolved"],
  assigned: ["deciding", "monitoring", "resolved"],
  deciding: ["applying", "escalated", "resolved"],
  applying: ["monitoring", "resolved"],
  monitoring: ["resolved"],
  resolved: [],
  escalated: [],
};

function transitionWithin(store: Store, projectId: string, caseId: string, next: CaseState, expectedRevision: number, ownerRoleId: string | undefined, evidenceAppend: unknown | undefined, now: number): CaseView {
  clock(now);
  return store.transaction(db => transitionWithinDb(db, projectId, caseId, next, expectedRevision, ownerRoleId, evidenceAppend, now));
}

/** db级状态转移（供角色不可用升级等单事务组合复用）。 */
function transitionWithinDb(db: Parameters<Parameters<Store["transaction"]>[0]>[0], projectId: string, caseId: string, next: CaseState, expectedRevision: number, ownerRoleId: string | undefined, evidenceAppend: unknown | undefined, now: number): CaseView {
  {
    const row = getRowDb(db, projectId, caseId);
    const current = String(row.state) as CaseState;
    if (Number(row.revision) !== expectedRevision) throw new Error("CASE_REVISION_CONFLICT");
    if (current === next) throw new Error("CASE_STATE_UNCHANGED");
    if (!transitions[current]?.includes(next)) throw new Error("CASE_TRANSITION_REJECTED");
    if (ownerRoleId !== undefined) {
      if (!db.prepare("SELECT 1 FROM roles WHERE id=? AND project_id=?").get(ownerRoleId, projectId)) throw new Error("CASE_ROLE_NOT_FOUND");
      db.prepare("UPDATE cases SET owner_role_id=? WHERE id=? AND project_id=?").run(ownerRoleId, caseId, projectId);
    }
    let evidenceUpdate = "";
    const params: (string | number)[] = [];
    if (evidenceAppend !== undefined) {
      const evidence = JSON.parse(String(row.evidence_json)) as unknown[];
      evidence.push({ at: now, state: next, evidence: evidenceAppend });
      evidenceUpdate = ",evidence_json=?";
      params.push(JSON.stringify(evidence));
    }
    params.push(next, caseId, projectId);
    db.prepare(`UPDATE cases SET revision=revision+1${evidenceUpdate ? evidenceUpdate : ""},state=? WHERE id=? AND project_id=?`).run(...params);
    return viewOf(getRowDb(db, projectId, caseId));
  }
}

function getRowDb(db: Parameters<Parameters<Store["transaction"]>[0]>[0], projectId: string, caseId: string): Record<string, unknown> {
  const row = db.prepare("SELECT id,project_id,task_id,owner_role_id,fingerprint,state,revision,evidence_json FROM cases WHERE id=? AND project_id=?").get(caseId, projectId);
  if (!row) throw new Error("CASE_NOT_FOUND");
  return row as Record<string, unknown>;
}

/** 指派处理者：open→assigned。 */
export function assignIssue(store: Store, projectId: string, caseId: string, ownerRoleId: string, expectedRevision: number, now: number): CaseView {
  return transitionWithin(store, projectId, caseId, "assigned", expectedRevision, ownerRoleId, undefined, now);
}
/** 升级给管理者：deciding→escalated（证据附升级说明）。 */
export function escalateIssue(store: Store, projectId: string, caseId: string, expectedRevision: number, evidence: unknown, now: number): CaseView {
  return transitionWithin(store, projectId, caseId, "escalated", expectedRevision, undefined, evidence, now);
}
/** 解决：各未决状态→resolved（证据附解决说明）。 */
export function resolveIssue(store: Store, projectId: string, caseId: string, expectedRevision: number, evidence: unknown, now: number): CaseView {
  return transitionWithin(store, projectId, caseId, "resolved", expectedRevision, undefined, evidence, now);
}
/** 过程推进（deciding/applying/monitoring）：带证据的状态推进。 */
export function progressIssue(store: Store, projectId: string, caseId: string, next: Extract<CaseState, "deciding" | "applying" | "monitoring">, expectedRevision: number, evidence: unknown, now: number): CaseView {
  return transitionWithin(store, projectId, caseId, next, expectedRevision, undefined, evidence, now);
}

export function readIssue(store: Store, projectId: string, caseId: string): CaseView & { readonly evidence: readonly unknown[] } {
  const row = getRow(store, projectId, caseId);
  return Object.freeze({ ...viewOf(row), evidence: JSON.parse(String(row.evidence_json)) as readonly unknown[] });
}

export function listOpenIssues(store: Store, projectId: string): readonly CaseView[] {
  return Object.freeze((store.db.prepare("SELECT id,project_id,task_id,owner_role_id,fingerprint,state,revision FROM cases WHERE project_id=? AND state NOT IN ('resolved','escalated') ORDER BY revision").all(projectId) as Record<string, unknown>[]).map(viewOf));
}

export interface UnavailableRoleEscalation {
  readonly escalated: readonly string[];
  readonly routedToDeciding: readonly string[];
}

/** T033：角色不可用时其承办事项沿有限路径升级（A048）。状态机即升级路径上限：
 * open→assigned→deciding→escalated逐步推进（不可跳级），证据记owner不可用；按指纹聚合不逐条日志轰炸管理者。 */
export function escalateUnavailableRoleCases(store: Store, input: { readonly projectId: string; readonly roleId: string }, now: number): UnavailableRoleEscalation {
  clock(now);
  const evidence = { reason: "owner-role-unavailable", roleId: input.roleId };
  return store.transaction(db => {
    const role = db.prepare("SELECT desired_state FROM roles WHERE id=? AND project_id=?").get(input.roleId, input.projectId) as { desired_state: string } | undefined;
    if (!role) throw new Error("CASE_ROLE_NOT_FOUND");
    const open = db.prepare("SELECT id,state,revision FROM cases WHERE project_id=? AND owner_role_id=? AND state NOT IN ('resolved','escalated') ORDER BY id").all(input.projectId, input.roleId) as { id: string; state: string; revision: number }[];
    const escalated: string[] = [];
    const routedToDeciding: string[] = [];
    for (const entry of open) {
      let state = String(entry.state);
      let revision = Number(entry.revision);
      if (state === "open") {
        transitionWithinDb(db, input.projectId, String(entry.id), "assigned", revision, undefined, undefined, now);
        revision += 1; state = "assigned";
      }
      if (state === "assigned") {
        transitionWithinDb(db, input.projectId, String(entry.id), "deciding", revision, undefined, undefined, now);
        revision += 1; state = "deciding";
        routedToDeciding.push(String(entry.id));
      }
      if (state === "deciding") {
        transitionWithinDb(db, input.projectId, String(entry.id), "escalated", revision, undefined, evidence, now);
        escalated.push(String(entry.id));
      }
      // applying/monitoring不强行升级——走各自退出条件（升级路径有限）
    }
    return { escalated, routedToDeciding };
  });
}

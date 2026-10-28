/** T068：目标变更hold与来源权威。authenticated_user来源必须来自已认证用户主体（伪造→FORGED_USER_SOURCE，不提升授权）；
 * 未知范围（scope_known=0）先限制新自动动作（dispatch-guard DISPATCH_HELD消费）；负责人裁决（await_user→resolved）
 * 只调整hold影响范围——不解除用户暂停、不提升任何授权。 */
import type { Store } from "@projectorch/persistence";

export interface GoalHoldView {
  readonly id: string;
  readonly projectId: string;
  readonly revision: number;
  readonly sourceKind: "authenticated_user" | "role_forwarded" | "native_unverified" | "kernel";
  readonly affectedTaskIds: readonly string[];
  readonly scopeKnown: boolean;
  readonly state: "pending" | "resolved" | "awaiting_user";
}

const text = (value: unknown, label: string, max: number): string => {
  if (typeof value !== "string" || !value || value.length > max || /[\r\n\0]/.test(value)) throw new Error(`INVALID_HOLD_${label}`);
  return value;
};
const clock = (now: number): void => { if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_HOLD_TIME"); };

export type HoldPrincipal = { readonly kind: "authenticated_user" } | { readonly kind: "bound_agent"; readonly roleId: string } | { readonly kind: "kernel" };

function viewOf(row: Record<string, unknown>): GoalHoldView {
  return Object.freeze({ id: String(row.id), projectId: String(row.project_id), revision: Number(row.revision), sourceKind: String(row.source_kind) as GoalHoldView["sourceKind"], affectedTaskIds: Object.freeze(JSON.parse(String(row.affected_tasks_json)) as string[]), scopeKnown: Number(row.scope_known) === 1, state: String(row.state) as GoalHoldView["state"] });
}

export function raiseGoalHold(store: Store, input: { readonly id: unknown; readonly projectId: unknown; readonly sourceKind: unknown; readonly principal: HoldPrincipal; readonly provenance: unknown; readonly affectedTaskIds: readonly string[]; readonly scopeKnown: boolean }, now: number): GoalHoldView {
  clock(now);
  const id = text(input.id, "ID", 128);
  const projectId = text(input.projectId, "PROJECT", 128);
  if (input.provenance === undefined || typeof input.provenance !== "object" || Array.isArray(input.provenance)) throw new Error("INVALID_HOLD_PROVENANCE");
  if (!Array.isArray(input.affectedTaskIds) || input.affectedTaskIds.some(t => typeof t !== "string")) throw new Error("INVALID_HOLD_SCOPE");
  const sourceKind = input.sourceKind;
  if (!["authenticated_user", "role_forwarded", "native_unverified", "kernel"].includes(sourceKind as string)) throw new Error("INVALID_HOLD_SOURCE");
  const sourceKindText = sourceKind as string;
  // 来源权威：authenticated_user必须来自用户主体（代理冒充=FORGED_USER_SOURCE）；role_forwarded必须来自绑定代理
  if (sourceKind === "authenticated_user" && input.principal.kind !== "authenticated_user") throw new Error("FORGED_USER_SOURCE");
  if (sourceKind === "role_forwarded" && input.principal.kind !== "bound_agent") throw new Error("FORGED_FORWARDED_SOURCE");
  return store.transaction(db => {
    if (!db.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)) throw new Error("HOLD_PROJECT_NOT_FOUND");
    db.prepare("INSERT INTO goal_holds(id,project_id,revision,source_kind,provenance_json,affected_tasks_json,scope_known,state) VALUES(?,?,0,?,?,?,?,'pending')").run(id, projectId, sourceKindText, JSON.stringify({ ...input.provenance as Record<string, unknown>, principalKind: input.principal.kind }), JSON.stringify(input.affectedTaskIds), input.scopeKnown ? 1 : 0);
    return viewOf(db.prepare("SELECT * FROM goal_holds WHERE id=?").get(id) as Record<string, unknown>);
  });
}

/** 负责人裁决：pending→awaiting_user（升级用户）；awaiting_user/pending→resolved（可带裁决后的影响范围）。
 * 解除hold不触碰projects.user_paused，也不改变任何授权面。 */
export function adjudicateGoalHold(store: Store, input: { readonly projectId: string; readonly holdId: string; readonly expectedRevision: number; readonly decision: "await_user" | "resolve"; readonly affectedTaskIds?: readonly string[]; readonly principal: HoldPrincipal }, now: number): GoalHoldView {
  clock(now);
  return store.transaction(db => {
    const row = db.prepare("SELECT * FROM goal_holds WHERE id=? AND project_id=?").get(input.holdId, input.projectId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("HOLD_NOT_FOUND");
    if (Number(row.revision) !== input.expectedRevision) throw new Error("HOLD_REVISION_CONFLICT");
    const current = String(row.state);
    if (current === "resolved") throw new Error("HOLD_ALREADY_RESOLVED");
    if (input.decision === "await_user") {
      if (current !== "pending") throw new Error("HOLD_TRANSITION_REJECTED");
      db.prepare("UPDATE goal_holds SET state='awaiting_user',revision=revision+1,provenance_json=? WHERE id=?").run(JSON.stringify({ adjudicatedBy: input.principal.kind, at: now }), input.holdId);
    } else {
      if (input.principal.kind === "bound_agent" && String(row.source_kind) === "authenticated_user" && Number(row.scope_known) === 0) throw new Error("HOLD_SCOPE_NOT_ADJUDICABLE_BY_AGENT");
      const scope = input.affectedTaskIds === undefined ? String(row.affected_tasks_json) : JSON.stringify(input.affectedTaskIds);
      db.prepare("UPDATE goal_holds SET state='resolved',revision=revision+1,affected_tasks_json=? WHERE id=?").run(scope, input.holdId);
    }
    return viewOf(db.prepare("SELECT * FROM goal_holds WHERE id=?").get(input.holdId) as Record<string, unknown>);
  });
}

export function readGoalHold(store: Store, projectId: string, holdId: string): GoalHoldView {
  const row = store.db.prepare("SELECT * FROM goal_holds WHERE id=? AND project_id=?").get(holdId, projectId);
  if (!row) throw new Error("HOLD_NOT_FOUND");
  return viewOf(row as Record<string, unknown>);
}

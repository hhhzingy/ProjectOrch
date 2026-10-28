import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Store } from "@projectorch/persistence";
import { reserveChangesetCommand, commitCommandReceipt, type Receipt } from "@projectorch/persistence/commands";
import { canonicalJson } from "@projectorch/persistence/outbox";
import { parseContract, type ContractRegistry } from "@projectorch/contracts";
import { applyChangesetWithin, ChangesetFailure } from "@projectorch/domain/changesets";
import { templateInside, isWellFormedPathTemplate } from "@projectorch/domain/policy";
import { readProjectPolicy } from "../auth/project-policy.js";
import { authorizeUserAction } from "../auth/policy-check.js";
import { enqueueWorkflowCandidatesWithin } from "../execution/workflow-intents.js";

type Changeset = ContractRegistry["changeset"];
export const readUserPolicy = readProjectPolicy;

/** 共享引用一致性检查；调用者必须先完成各自身份和逐操作授权，不在此授予用户权限。 */
export function validateChangesetReferences(db: DatabaseSync, input: Changeset): void {
  const policy = readUserPolicy(db, input.projectId);
  const scopes = new Map<string, readonly string[]>((db.prepare("SELECT id,scope_paths_json FROM roles WHERE project_id=?").all(input.projectId)).map(row => [String(row.id), JSON.parse(String(row.scope_paths_json)) as string[]]));
  for (const operation of input.operations) {
    if (operation.type === "role.update" && operation.permissionProfileRevision !== undefined && operation.permissionProfileId === undefined) throw new Error("INVALID_PROFILE_REVISION_WITHOUT_ID");
    if (operation.type === "role.update" && db.prepare("SELECT 1 FROM role_bindings WHERE project_id=? AND role_id=? AND ended_at IS NULL").get(input.projectId, operation.roleId)) throw new Error("CAPABILITY_UNSUPPORTED:bound_role_reconfiguration");
    if (operation.type === "plan.revise") throw new Error(`CAPABILITY_UNSUPPORTED:${operation.type}`);
    if ((operation.type === "role.pause" || operation.type === "role.disable" || operation.type === "role.enable") && operation.currentWorkPolicy !== "finish") throw new Error("CAPABILITY_UNSUPPORTED:currentWorkPolicy");
    if (operation.type === "role.create" || (operation.type === "role.update" && operation.permissionProfileId !== undefined)) {
      const roleId = operation.type === "role.create" ? operation.localRef : operation.roleId;
      const scopePaths = operation.type === "role.create" ? operation.scopePaths : scopes.get(roleId) ?? [];
      const profile = policy.profiles.find(p => p.id === operation.permissionProfileId);
      if (!profile || profile.revision !== operation.permissionProfileRevision) throw new Error("POLICY_PROFILE_REVISION_CONFLICT");
      if (profile.roleIds.length > 0 && !profile.roleIds.includes(roleId)) throw new Error("POLICY_PROFILE_ROLE_OUT_OF_SCOPE");
      if (scopePaths.some(path => !isWellFormedPathTemplate(path)) || !templateInside([...profile.readPaths, ...profile.writePaths], scopePaths)) throw new Error("POLICY_PROFILE_PATH_OUT_OF_SCOPE");
      scopes.set(roleId, scopePaths);
    }
    let proposed: ContractRegistry["task-spec"] | undefined;
    if (operation.type === "task.create" || operation.type === "task.spec.revise") proposed = operation.spec;
    else if (operation.type === "task.dependencies.replace") {
      const task = db.prepare("SELECT goal,inputs_json,outputs_json,acceptance_json FROM tasks WHERE id=? AND project_id=?").get(operation.taskId, input.projectId);
      // 批内刚创建的任务由前序task.create校验；实际应用时按序读取完整规格。
      if (task) proposed = parseContract("task-spec", { goal: task.goal, inputArtifacts: JSON.parse(String(task.inputs_json)), outputRequirements: JSON.parse(String(task.outputs_json)), acceptance: JSON.parse(String(task.acceptance_json)), dependencies: operation.dependencies });
    }
    if (proposed) {
      const names = new Set<string>();
      for (const output of proposed.outputRequirements) {
        if (names.has(output.name)) throw new Error("DUPLICATE_OUTPUT_NAME");
        names.add(output.name);
      }
      for (const ref of proposed.inputArtifacts) {
        if (!db.prepare("SELECT 1 FROM artifacts WHERE id=? AND project_id=? AND version=?").get(ref.artifactId, input.projectId, ref.version)) throw new Error("INPUT_ARTIFACT_NOT_FOUND");
      }
      for (const rule of proposed.acceptance) {
        if (rule.mode === "designated_reviewer" && !scopes.has(rule.reviewerRoleId)) throw new Error("REVIEWER_ROLE_NOT_FOUND");
        if (rule.mode === "automated_check" && !db.prepare("SELECT 1 FROM check_definitions WHERE project_id=? AND id=? AND version=? AND enabled=1").get(input.projectId, rule.checkDefinitionId, rule.checkVersion)) throw new Error("CHECK_UNAVAILABLE");
      }
    }
  }
}

export function applyChangesetForUser(store: Store, principalId: string, raw: unknown, now: number): Receipt {
  if (typeof principalId !== "string" || !principalId || principalId.length > 128) throw new Error("UNAUTHENTICATED");
  const input = parseContract("changeset", JSON.parse(canonicalJson(raw)));
  return store.transaction(db => {
    if (!authorizeUserAction({ action: "change.apply", targetProjectId: input.projectId, kind: "write" }).allowed) throw new Error("FORBIDDEN");
    if (!db.prepare("SELECT 1 FROM projects WHERE id=?").get(input.projectId)) throw new Error("PROJECT_NOT_FOUND");
    const reservation = reserveChangesetCommand(db, principalId, randomUUID(), input, now);
    if (reservation.replay) return reservation.receipt;
    validateChangesetReferences(db, input);
    return applyReservedChangesetWithin(db,principalId,reservation.commandId,input,now);
  });
}

/** 已完成用户或逐操作Agent授权、引用校验和来源预约后的共享事务体；不在这里授予用户权限。 */
export function applyReservedChangesetWithin(db:DatabaseSync,principalId:string,commandId:string,input:Changeset,now:number):Receipt{
    if(!db.isTransaction)throw new Error('CHANGESET_TRANSACTION_REQUIRED');
    let failure: ChangesetFailure | null = null;
    let planRevision = input.expectedPlanRevision;
    try { planRevision = applyChangesetWithin(db, commandId, input, now).planRevision; }
    catch (error) { if (!(error instanceof ChangesetFailure)) throw error; failure = error; }
    const entities: { localRef: string; entityType: "role" | "task" | "case"; id: string; revision: number; version: null }[] = [];
    if (!failure) {
      for (const operation of input.operations) {
        const kind = operation.type.startsWith("role.") ? "role" : operation.type.startsWith("task.") ? "task" : "case";
        const id = String("localRef" in operation ? operation.localRef : "roleId" in operation && kind === "role" ? operation.roleId : "taskId" in operation ? operation.taskId : "caseId" in operation ? operation.caseId : "");
        const table = kind === "role" ? "roles" : kind === "task" ? "tasks" : "cases";
        const revision = Number(db.prepare(`SELECT revision FROM ${table} WHERE id=? AND project_id=?`).get(id, input.projectId)?.revision);
        if (!entities.some(entity => entity.id === id && entity.entityType === kind)) entities.push({ localRef: id, entityType: kind, id, revision, version: null });
      }
      db.prepare("INSERT INTO events(id,project_id,type,entity_id,entity_revision,causation_id,body_json,occurred_at) VALUES(?,?,'changeset.applied',?,?,?,?,?)")
        .run(randomUUID(), input.projectId, input.projectId, planRevision, commandId, canonicalJson({ changesetId: `cs-${commandId}`, planRevision, entities }), now);
      enqueueWorkflowCandidatesWithin(db, input.projectId, commandId, now);
    }
    const lastEventSequence = Number(db.prepare("SELECT COALESCE(MAX(sequence),0) AS n FROM events WHERE project_id=?").get(input.projectId)?.n);
    return commitCommandReceipt(db, principalId, commandId, {
      requestId: input.requestId, projectId: input.projectId, commandId, status: failure ? "failed" : "completed",
      receiptUrl: `/api/v1/commands/${commandId}/receipt`, entityIds: entities, lastEventSequence,
      error: failure ? { code: /CONFLICT/.test(failure.message) ? "REVISION_CONFLICT" : "INVALID_STATE", message: failure.message.slice(0, 512), requestId: input.requestId, retryable: false } : null,
    });
}

/** T017准备切片：生产命令服务。把合同命令（用户生命周期类与首次接入类）接入授权、幂等命令管线、事件与Outbox；处理器在命令事务内完成域变更、事件追加与回执。 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CommandServices } from "./index.js";
import { authorizeUserAction } from "../auth/policy-check.js";
import { pauseProjectWithin, resumeProjectWithin, readProjectWithin } from "@projectorch/domain/projects";
import { bootstrapRoleWithin } from "@projectorch/domain/bootstrap";
import { enqueueOutbox } from "@projectorch/persistence/outbox";
import { enqueueWorkflowCandidatesWithin } from "../execution/workflow-intents.js";

type LifecycleCommand = { readonly type: "project.pause" | "project.resume" | "role.bootstrap"; readonly requestId: string; readonly projectId: string; readonly payload: Record<string, unknown> };

const supported: ReadonlyMap<string, { readonly action: string; readonly kind: "control" }> = new Map([
  ["project.pause", { action: "project.pause", kind: "control" }],
  ["project.resume", { action: "project.resume", kind: "control" }],
  ["role.bootstrap", { action: "role.bootstrap", kind: "control" }],
]);

function appendEvent(db: DatabaseSync, input: { readonly projectId: string; readonly type: string; readonly entityId: string; readonly entityRevision: number; readonly causationId: string; readonly body: Record<string, unknown>; readonly occurredAt: number }): number {
  db.prepare("INSERT INTO events(id,project_id,type,entity_id,entity_revision,causation_id,body_json,occurred_at) VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(), input.projectId, input.type, input.entityId, input.entityRevision, input.causationId, JSON.stringify(input.body), input.occurredAt);
  return Number(db.prepare("SELECT COALESCE(MAX(sequence),0) AS n FROM events WHERE project_id=?").get(input.projectId)?.n);
}

function receiptInput(command: LifecycleCommand, commandId: string, effect: { readonly userPaused: boolean; readonly revision: number }, lastEventSequence: number): Record<string, unknown> {
  return {
    requestId: command.requestId, projectId: command.projectId, commandId, status: "completed",
    receiptUrl: `/api/v1/commands/${commandId}/receipt`,
    entityIds: [{ localRef: command.projectId, entityType: "project", id: command.projectId, revision: effect.revision, version: null }],
    error: null, lastEventSequence,
  };
}

/** 用户生命周期命令：授权走用户主体（Agent对这些动作被策略层保留，永远拒绝）；域变更、事件、Outbox与回执同事务。 */
export function lifecycleCommandServices(now: () => number = Date.now): CommandServices {
  return {
    authorize: (db, principalId, command) => {
      void db;
      if (typeof principalId !== "string" || !principalId) return false;
      const spec = supported.get(command.type);
      if (!spec) return false;
      return authorizeUserAction({ action: spec.action, targetProjectId: command.projectId, kind: spec.kind }).allowed;
    },
    handlers: new Map([
      ["project.pause", (db, commandId, command) => {
        const input = command as unknown as LifecycleCommand;
        const snapshot = pauseProjectWithin(db, input.projectId, now());
        const lastEventSequence = appendEvent(db, { projectId: input.projectId, type: "project.paused", entityId: input.projectId, entityRevision: snapshot.revision, causationId: commandId, body: { userPaused: true, reason: input.payload.reason, currentWorkPolicy: input.payload.currentWorkPolicy }, occurredAt: now() });
        enqueueOutbox(db, { id: randomUUID(), commandId, operationKey: `project.paused:${input.projectId}:${snapshot.revision}`, payload: { event: "project.paused", projectId: input.projectId, revision: snapshot.revision }, nextAttemptAt: now() });
        return receiptInput(input, commandId, { userPaused: true, revision: snapshot.revision }, lastEventSequence);
      }],
      ["project.resume", (db, commandId, command) => {
        const input = command as unknown as LifecycleCommand;
        const expectedRevision = input.payload.expectedRevision;
        if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("INVALID_RESUME_REVISION");
        if (readProjectWithin(db, input.projectId).revision !== expectedRevision) throw new Error("PROJECT_REVISION_CONFLICT");
        const snapshot = resumeProjectWithin(db, input.projectId, now());
        const lastEventSequence = appendEvent(db, { projectId: input.projectId, type: "project.resumed", entityId: input.projectId, entityRevision: snapshot.revision, causationId: commandId, body: { userPaused: false, reason: input.payload.reason }, occurredAt: now() });
        enqueueOutbox(db, { id: randomUUID(), commandId, operationKey: `project.resumed:${input.projectId}:${snapshot.revision}`, payload: { event: "project.resumed", projectId: input.projectId, revision: snapshot.revision }, nextAttemptAt: now() });
        enqueueWorkflowCandidatesWithin(db, input.projectId, commandId, now());
        return receiptInput(input, commandId, { userPaused: false, revision: snapshot.revision }, lastEventSequence);
      }],
      // T067首次接入：同requestId重试经管线幂等回放（回执丢失可恢复）；未startup核验前binding_state保持unbound
      ["role.bootstrap", (db, commandId, command) => {
        const input = command as unknown as LifecycleCommand;
        const p = input.payload;
        const principalId = String((db.prepare("SELECT source_principal_id FROM commands WHERE id=?").get(commandId) as { source_principal_id: string }).source_principal_id);
        for (const [key, type] of [["localRef", "string"], ["name", "string"], ["charter", "string"], ["permissionProfileId", "string"]] as const) {
          if (typeof p[key] !== type) throw new Error(`INVALID_BOOTSTRAP_${key.toUpperCase()}`);
        }
        for (const key of ["permissionProfileRevision", "expectedPolicyRevision"] as const) {
          if (typeof p[key] !== "number" || !Number.isSafeInteger(p[key]) || p[key] < 0) throw new Error(`INVALID_BOOTSTRAP_${key.toUpperCase()}`);
        }
        if (p.sessionRef === undefined || typeof p.sessionRef !== "object" || p.sessionRef === null) throw new Error("INVALID_BOOTSTRAP_SESSIONREF");
        const result = bootstrapRoleWithin(db, { projectId: input.projectId, localRef: String(p.localRef), name: String(p.name), charter: String(p.charter), permissionProfileId: String(p.permissionProfileId), permissionProfileRevision: Number(p.permissionProfileRevision), expectedPolicyRevision: Number(p.expectedPolicyRevision), principalId, requestId: input.requestId }, now());
        const lastEventSequence = appendEvent(db, { projectId: input.projectId, type: "role.bootstrapped", entityId: result.role.id, entityRevision: result.role.revision, causationId: commandId, body: { roleId: result.role.id, replay: result.replay, permissionProfileId: result.role.permissionProfileId }, occurredAt: now() });
        return {
          requestId: input.requestId, projectId: input.projectId, commandId, status: "completed",
          receiptUrl: `/api/v1/commands/${commandId}/receipt`,
          entityIds: [{ localRef: result.role.id, entityType: "role", id: result.role.id, revision: result.role.revision, version: null }],
          error: null, lastEventSequence,
        };
      }],
    ]),
  };
}

/** 网关错误映射辅助：业务拒绝409、合同/请求非法400、未认证401、越权403。 */
export function commandErrorStatus(message: string): 400 | 401 | 403 | 409 {
  if (/UNAUTHENTICATED|CSRF/.test(message)) return 401;
  if (/FORBIDDEN|USER_RESERVED|PROJECT_ISOLATION|ROLE_NOT_ENABLED|PROJECT_PAUSED|WRONG_REVIEWER|UNTRUSTED_USER|SELF_REVIEW/.test(message)) return 403;
  if (/PROJECT_ALREADY_PAUSED|PROJECT_NOT_PAUSED|PROJECT_REVISION_CONFLICT|PROJECT_NOT_FOUND|IDEMPOTENCY_CONFLICT|STALE_SPEC|RESULT_NOT_CURRENT|RESULT_EXECUTION_NOT_CONFIRMED|ACCEPTANCE_|RULE_ALREADY_ACCEPTED/.test(message)) return 409;
  return 400;
}

import { randomUUID } from "node:crypto";
import type { Store } from "@projectorch/persistence";
import { canonicalJson, enqueueOutbox } from "@projectorch/persistence/outbox";

/** 只创建有版本的内部评估意图；不是执行回执。重复来源保留首次因果关系。 */
export function enqueueWorkflowCandidatesWithin(db: Store["db"], projectId: string, commandId: string, now: number, taskIds?: readonly string[],configurationRecheck=false): number {
  if (!db.isTransaction || !Number.isSafeInteger(now) || now < 0) throw new Error("WORKFLOW_TRANSACTION_REQUIRED");
  if (!db.prepare("SELECT 1 FROM commands WHERE id=? AND project_id=?").get(commandId, projectId)) throw new Error("WORKFLOW_COMMAND_PROJECT_MISMATCH");
  const selected = taskIds === undefined ? null : new Set(taskIds);
  const rows = db.prepare("SELECT id,revision,spec_revision FROM tasks WHERE project_id=? AND role_id IS NOT NULL AND state IN ('draft','ready') ORDER BY id").all(projectId);
  let count = 0;
  for (const task of rows) {
    if (selected && !selected.has(String(task.id))) continue;
    const payload = { schemaVersion: 2, event: "workflow.evaluate", projectId, taskId: String(task.id), taskRevision: Number(task.revision), specRevision: Number(task.spec_revision) };
    if(configurationRecheck){
      const pending=db.prepare("SELECT id,payload_json FROM outbox WHERE state='pending' AND json_extract(payload_json,'$.event')='workflow.evaluate' AND json_extract(payload_json,'$.projectId')=? AND json_extract(payload_json,'$.taskId')=? AND json_extract(payload_json,'$.taskRevision')=? AND json_extract(payload_json,'$.specRevision')=? ORDER BY id LIMIT 1").get(projectId,String(task.id),Number(task.revision),Number(task.spec_revision));
      if(pending){
        if(pending.payload_json!==canonicalJson(payload))throw new Error('WORKFLOW_IDEMPOTENCY_CONFLICT');
        db.prepare("UPDATE outbox SET next_attempt_at=MIN(next_attempt_at,?) WHERE id=? AND state='pending'").run(now,String(pending.id));continue;
      }
    }
    const key = `workflow.task:${projectId}:${String(task.id)}:${Number(task.revision)}:${Number(task.spec_revision)}${configurationRecheck?`:configuration:${commandId}`:''}`;
    const existing = db.prepare("SELECT payload_json,state FROM outbox WHERE operation_key=?").get(key);
    if (existing) {
      if (existing.payload_json !== canonicalJson(payload)) throw new Error("WORKFLOW_IDEMPOTENCY_CONFLICT");
      // 用户恢复/变更触发重新核验，但不重新投递已准备或已丢弃的原候选。
      if (existing.state === "pending") db.prepare("UPDATE outbox SET next_attempt_at=MIN(next_attempt_at,?) WHERE operation_key=?").run(now, key);
      continue;
    }
    enqueueOutbox(db, { id: randomUUID(), commandId, operationKey: key, payload, nextAttemptAt: now }); count++;
  }
  return count;
}

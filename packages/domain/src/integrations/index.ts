/** R018准备切片：集成交付域。请求=目标版本+成果引用+检查清单（全部须为已登记成果）→pending；
 * 过程=pending→integrating→verified/failed（检查结果记录）；verified要求全部checks通过。
 * 整合责任与目标版本绑定（R018）；非Git项目以成果记录为准。 */
import type { Store } from "@projectorch/persistence";

export interface IntegrationView {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly targetVersion: string;
  readonly state: "pending" | "integrating" | "verified" | "failed";
  readonly artifacts: readonly string[];
  readonly checks: readonly { readonly name: string; readonly description: string }[];
}

const text = (value: unknown, label: string, max: number): string => {
  if (typeof value !== "string" || !value || value.length > max || /[\r\n\0]/.test(value)) throw new Error(`INVALID_INTEGRATION_${label}`);
  return value;
};
const clock = (now: number): void => { if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_INTEGRATION_TIME"); };

function viewOf(row: Record<string, unknown>): IntegrationView {
  const parsed = JSON.parse(String(row.checks_json)) as unknown;
  const checks: readonly { name: string; description: string }[] = Array.isArray(parsed)
    ? (parsed as readonly { name: string; description: string }[])
    : (parsed as { checks?: readonly { name: string; description: string }[] }).checks ?? [];
  return Object.freeze({ id: String(row.id), projectId: String(row.project_id), taskId: String(row.task_id), targetVersion: String(row.target_version), state: String(row.state) as IntegrationView["state"], artifacts: JSON.parse(String(row.artifacts_json)) as readonly string[], checks: Object.freeze(checks) });
}

/** 请求集成：全部artifactId必须已登记且归属同一项目（成果引用闭环，R018）；检查清单非空。 */
export function requestIntegration(store: Store, input: { readonly id: unknown; readonly projectId: unknown; readonly taskId: unknown; readonly targetVersion: unknown; readonly artifactIds: readonly unknown[]; readonly checks: readonly unknown[] }, now: number): IntegrationView {
  clock(now);
  const id = text(input.id, "ID", 128);
  const projectId = text(input.projectId, "PROJECT", 128);
  const taskId = text(input.taskId, "TASK", 128);
  const targetVersion = text(input.targetVersion, "TARGET", 128);
  if (!Array.isArray(input.artifactIds) || input.artifactIds.length === 0 || input.artifactIds.length > 128) throw new Error("INVALID_INTEGRATION_ARTIFACTS");
  if (!Array.isArray(input.checks) || input.checks.length === 0 || input.checks.length > 64) throw new Error("INVALID_INTEGRATION_CHECKS");
  const artifactIds = input.artifactIds.map(value => text(value, "ARTIFACT", 128));
  const checks = input.checks.map(check => {
    if (!check || typeof check !== "object" || Array.isArray(check)) throw new Error("INVALID_INTEGRATION_CHECKS");
    const record = check as Record<string, unknown>;
    return { name: text(record.name, "CHECK_NAME", 128), description: text(record.description, "CHECK_DESC", 16384) };
  });
  return store.transaction(db => {
    if (!db.prepare("SELECT 1 FROM tasks WHERE id=? AND project_id=?").get(taskId, projectId)) throw new Error("INTEGRATION_TASK_NOT_FOUND");
    for (const artifactId of artifactIds) {
      if (!db.prepare("SELECT 1 FROM artifacts WHERE id=? AND project_id=?").get(artifactId, projectId)) throw new Error(`INTEGRATION_ARTIFACT_NOT_FOUND:${artifactId}`);
    }
    db.prepare("INSERT INTO integrations(id,project_id,task_id,target_version,artifacts_json,checks_json,state) VALUES(?,?,?,?,?,?,'pending')").run(id, projectId, taskId, targetVersion, JSON.stringify(artifactIds), JSON.stringify({ checks, runs: [] }));
    const row = db.prepare("SELECT id,project_id,task_id,target_version,artifacts_json,checks_json,state FROM integrations WHERE id=? AND project_id=?").get(id, projectId) as Record<string, unknown>;
    return viewOf(row);
  });
}

export interface IntegrationCheckResult { readonly name: string; readonly passed: boolean; readonly detail?: string }
function transition(store: Store, projectId: string, integrationId: string, next: "integrating" | "verified" | "failed", checkResults: readonly IntegrationCheckResult[] | undefined, now: number): IntegrationView {
  clock(now);
  return store.transaction(db => {
    const row = db.prepare("SELECT id,project_id,task_id,target_version,artifacts_json,checks_json,state FROM integrations WHERE id=? AND project_id=?").get(integrationId, projectId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("INTEGRATION_NOT_FOUND");
    const current = String(row.state);
    const allowed: Record<string, readonly string[]> = { pending: ["integrating"], integrating: ["verified", "failed"], verified: [], failed: ["integrating"] };
    if (!allowed[current]?.includes(next)) throw new Error("INTEGRATION_TRANSITION_REJECTED");
    const parsed = JSON.parse(String(row.checks_json)) as { checks: readonly { name: string; description: string }[]; runs: readonly unknown[] };
    const definitions = Array.isArray(parsed) ? parsed : parsed.checks;
    const runs = Array.isArray(parsed) ? [] : parsed.runs;
    if (next === "verified") {
      const results: readonly IntegrationCheckResult[] = checkResults ?? [];
      for (const check of definitions) {
        const result = results.find(r => r.name === check.name);
        if (!result || result.passed !== true) throw new Error(`INTEGRATION_CHECK_NOT_PASSED:${check.name}`);
      }
    }
    const artifacts = JSON.parse(String(row.artifacts_json)) as readonly string[];
    const newRuns = checkResults !== undefined ? [...runs, { state: next, at: now, results: checkResults }] : runs;
    db.prepare("UPDATE integrations SET state=?,checks_json=? WHERE id=? AND project_id=?").run(next, JSON.stringify({ checks: definitions, runs: newRuns }), integrationId, projectId);
    const updated = db.prepare("SELECT id,project_id,task_id,target_version,artifacts_json,checks_json,state FROM integrations WHERE id=? AND project_id=?").get(integrationId, projectId) as Record<string, unknown>;
    void artifacts;
    return viewOf(updated);
  });
}

export function startIntegration(store: Store, projectId: string, integrationId: string, now: number): IntegrationView {
  return transition(store, projectId, integrationId, "integrating", undefined, now);
}
/** 核验完成：全部检查通过才verified（任一未过→failed，可重新integrating）。 */
export function completeIntegration(store: Store, projectId: string, integrationId: string, checkResults: readonly IntegrationCheckResult[], now: number): IntegrationView {
  return transition(store, projectId, integrationId, "verified", checkResults, now);
}
export function failIntegration(store: Store, projectId: string, integrationId: string, checkResults: readonly IntegrationCheckResult[], now: number): IntegrationView {
  return transition(store, projectId, integrationId, "failed", checkResults, now);
}
export function retryIntegration(store: Store, projectId: string, integrationId: string, now: number): IntegrationView {
  return transition(store, projectId, integrationId, "integrating", undefined, now);
}
export function readIntegration(store: Store, projectId: string, integrationId: string): IntegrationView {
  const row = store.db.prepare("SELECT id,project_id,task_id,target_version,artifacts_json,checks_json,state FROM integrations WHERE id=? AND project_id=?").get(integrationId, projectId);
  if (!row) throw new Error("INTEGRATION_NOT_FOUND");
  return viewOf(row as Record<string, unknown>);
}

import { randomUUID } from "node:crypto";
import type { Store } from "@projectorch/persistence";
import type { ContractRegistry } from "@projectorch/contracts";
import type { AcceptancePrincipal } from "@projectorch/domain/results";
import { readArtifactRecord, verifyArtifactContent, readFileFingerprint } from "@projectorch/domain/artifacts";
import { assertGitArtifactSource } from "@projectorch/domain/artifacts/git";
import { readProject } from "@projectorch/domain/projects";
import { evaluateStartConditions } from "@projectorch/domain/tasks";
import { acceptTaskWithin } from "../tools/task-workflow.js";
import { enqueueWorkflowCandidatesWithin } from "../execution/workflow-intents.js";

type Payload = Extract<ContractRegistry["command"], { type: "task.accept" }>["payload"];

/** 仅供已认证命令管线；调用方先授权，Agent另提供逐成果路径检查。 */
export function taskAcceptanceWithin(store: Store, principal: AcceptancePrincipal, projectId: string, payload: Payload, commandId: string, requestId: string, now: number, authorizeEvidence: (path: string) => void): { readonly receipt: Record<string, unknown>; readonly tool: Record<string, unknown> } {
  const db = store.db;
  if (!db.isTransaction) throw new Error("ACCEPTANCE_TRANSACTION_REQUIRED");
  const root = readProject(store, projectId).canonicalRoot;
  const verifyEvidence = (id: string, prior = false) => {
    const artifact = readArtifactRecord(store, projectId, id);
    if (artifact.pathRef.startsWith("git:")) { assertGitArtifactSource(store, projectId, id, authorizeEvidence); return; }
    authorizeEvidence(artifact.pathRef);
    if (!artifact.sha256 || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error("ACCEPTANCE_EVIDENCE_HASH_REQUIRED");
    if (!verifyArtifactContent(store, projectId, id, root, readFileFingerprint).ok) throw new Error(prior ? "ACCEPTANCE_PRIOR_EVIDENCE_CHANGED" : "ACCEPTANCE_EVIDENCE_CONTENT_CHANGED");
  };
  for (const id of payload.evidenceArtifactIds) verifyEvidence(id);
  const value = acceptTaskWithin(store, principal, projectId, payload, now);
  if (value.accepted) for (const record of db.prepare("SELECT evidence_json FROM result_rule_decisions WHERE project_id=? AND result_id=? AND decision='accept'").all(projectId, payload.resultId)) {
    const evidence = JSON.parse(String(record.evidence_json)) as { artifactIds: string[] };
    for (const id of evidence.artifactIds) verifyEvidence(id, true);
  }
  if (value.accepted) {
    const required = JSON.parse(String(db.prepare("SELECT outputs_json FROM tasks WHERE id=? AND project_id=?").get(payload.taskId, projectId)?.outputs_json)) as { name: string; kind: string }[];
    const outputs: unknown = JSON.parse(String(db.prepare("SELECT outputs_json FROM results WHERE id=? AND project_id=?").get(payload.resultId, projectId)?.outputs_json));
    if (!Array.isArray(outputs) || new Set(required.map(item => item.name)).size !== required.length) throw new Error("ACCEPTANCE_OUTPUTS_AMBIGUOUS");
    const seen = new Set<string>();
    for (const output of outputs as unknown[]) {
      if (!output || typeof output !== "object" || !("outputName" in output) || !("artifactId" in output) || !("version" in output) || typeof output.outputName !== "string" || typeof output.artifactId !== "string" || typeof output.version !== "string" || seen.has(output.outputName) || !required.some(item => item.name === output.outputName)) throw new Error("ACCEPTANCE_OUTPUTS_INVALID");
      seen.add(output.outputName);
      const artifact = readArtifactRecord(store, projectId, output.artifactId);
      if (artifact.taskId !== payload.taskId || artifact.taskRevision !== payload.taskRevision || artifact.version !== output.version) throw new Error("ACCEPTANCE_OUTPUT_SOURCE_MISMATCH");
      const git = artifact.pathRef.startsWith("git:");
      if ((required.find(item => item.name === output.outputName)?.kind === "git_commit") !== git) throw new Error("ACCEPTANCE_OUTPUT_KIND_MISMATCH");
      if (git) { assertGitArtifactSource(store, projectId, artifact.id, authorizeEvidence); continue; }
      authorizeEvidence(artifact.pathRef);
      if (!verifyArtifactContent(store, projectId, artifact.id, root, readFileFingerprint).ok) throw new Error("ACCEPTANCE_OUTPUT_CONTENT_CHANGED");
    }
    if (required.some(item => !seen.has(item.name))) throw new Error("ACCEPTANCE_OUTPUTS_MISSING");
  }
  const emit = (type: string, id: string, revision: number, body: unknown) => db.prepare("INSERT INTO events(id,project_id,type,entity_id,entity_revision,causation_id,body_json,occurred_at) VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(), projectId, type, id, revision, commandId, JSON.stringify(body), now);
  emit(value.accepted ? "task.accepted" : "task.rule_decided", value.taskId, value.revision, { resultId: payload.resultId, decisionId: value.decisionId, ruleId: payload.ruleId, decision: payload.decision, reviewerPrincipalId: principal.id, reviewerKind: principal.kind });
  const project = readProject(store, projectId);
  const held = db.prepare("SELECT 1 FROM goal_holds WHERE project_id=? AND state IN ('pending','awaiting_user')").get(projectId);
  if (value.accepted && !project.userPaused && !held) {
    const downstream = db.prepare("SELECT DISTINCT t.id,t.revision FROM tasks t JOIN task_dependencies d ON d.task_id=t.id AND d.project_id=t.project_id WHERE t.project_id=? AND d.prerequisite_id=? AND t.state='draft' ORDER BY t.id").all(projectId, value.taskId);
    for (const task of downstream) if (evaluateStartConditions(store, projectId, String(task.id)).ready) {
      db.prepare("UPDATE tasks SET state='ready',revision=revision+1 WHERE id=? AND project_id=?").run(String(task.id), projectId);
      emit("task.ready", String(task.id), Number(task.revision) + 1, { predecessorId: value.taskId });
      enqueueWorkflowCandidatesWithin(db, projectId, commandId, now, [String(task.id)]);
    }
  }
  const sequence = Number(db.prepare("SELECT COALESCE(MAX(sequence),0) AS n FROM events WHERE project_id=?").get(projectId)?.n);
  return { receipt: { requestId, projectId, commandId, status: "completed", receiptUrl: `/api/v1/commands/${commandId}/receipt`, entityIds: [{ localRef: value.taskId, entityType: "task", id: value.taskId, revision: value.revision, version: null }], error: null, lastEventSequence: sequence }, tool: value };
}

import type { Store } from "@projectorch/persistence";
import { parseContract } from "@projectorch/contracts";
import { readArtifactRecord } from "@projectorch/domain/artifacts";
import { readArtifactChunk } from "@projectorch/domain/artifacts/content";
import { assertAgentPrincipalCurrent, type AgentPrincipal } from "../auth/agent-credential.js";
import { authorizeAgentAction } from "../auth/policy-check.js";

export function artifactContentForAgent(store: Store, principal: AgentPrincipal, input: unknown, now: number, connection: () => void) {
  return store.transaction(() => {
    connection(); assertAgentPrincipalCurrent(store, principal, now);
    const query = parseContract("query", { schemaVersion: 2, type: "artifact.content", payload: input });
    if (query.type !== "artifact.content") throw new Error("FORBIDDEN");
    const record = readArtifactRecord(store, principal.projectId, query.payload.artifactId);
    if (record.taskId !== null && !authorizeAgentAction(store, principal, undefined, { action: "task.read", targetProjectId: principal.projectId, kind: "read", path: `tasks/${record.taskId}` }, now).allowed) throw new Error("ARTIFACT_NOT_FOUND");
    return readArtifactChunk(store, principal.projectId, record.id, query.payload.version, query.payload.offset, path => {
      if (!authorizeAgentAction(store, principal, undefined, { action: "artifact.read", targetProjectId: principal.projectId, kind: "read", path }, now).allowed) throw new Error("ARTIFACT_NOT_FOUND");
    });
  });
}

import { createHash, randomUUID } from "node:crypto";
import type { Store } from "@projectorch/persistence";
import { parseContract } from "@projectorch/contracts";
import { canonicalJson } from "@projectorch/persistence/outbox";
import { commitCommandReceipt } from "@projectorch/persistence/commands";
import { canonicalRoot, createProjectWithin } from "@projectorch/domain/projects";
import { parsePermissionProfile } from "@projectorch/domain/policy";

/** 仅供已认证本机用户或其显式配对控制入口；调用方负责授权，普通Agent不调用此入口。 */
export function createProjectForUser(store: Store, principalId: string, hostId: string, raw: unknown, now: number,assertAuthorized?:()=>void): Record<string, unknown> {
  const input = parseContract("project-create", JSON.parse(canonicalJson(raw)));
  if (input.hostId !== hostId) throw new Error("PROJECT_HOST_MISMATCH");
  const root = canonicalRoot(input.rootPath);
  const profileIds = new Set<string>();
  for (const profile of input.initialPolicy.profiles) {
    parsePermissionProfile(profile);
    if (profileIds.has(profile.id)) throw new Error("DUPLICATE_POLICY_PROFILE");
    profileIds.add(profile.id);
  }
  const payload = { ...input, rootPath: root };
  const serialized = canonicalJson(payload);
  const hash = createHash("sha256").update(serialized).digest("hex");
  return store.transaction(db => {
    assertAuthorized?.();
    if (db.prepare("SELECT 1 FROM commands WHERE source_principal_id=? AND request_id=?").get(principalId, input.requestId)) {
      const prior = db.prepare("SELECT request_hash,receipt_json FROM global_requests WHERE principal_id=? AND request_id=?").get(principalId, input.requestId);
      if (!prior || prior.request_hash !== hash) throw new Error("IDEMPOTENCY_CONFLICT");
      return parseContract("receipt", JSON.parse(String(prior.receipt_json)));
    }
    const existing = db.prepare("SELECT request_hash,receipt_json FROM global_requests WHERE principal_id=? AND request_id=?").get(principalId, input.requestId);
    if (existing) {
      if (existing.request_hash !== hash) throw new Error("IDEMPOTENCY_CONFLICT");
      return parseContract("receipt", JSON.parse(String(existing.receipt_json)));
    }
    if (db.prepare("SELECT 1 FROM projects WHERE host_id=? AND canonical_root=? COLLATE NOCASE").get(hostId, root)) throw new Error("PROJECT_ROOT_OCCUPIED");
    const projectId = randomUUID(); const commandId = randomUUID();
    createProjectWithin(db, { id: projectId, name: input.name, hostId, canonicalRoot: root, objective: input.objective }, now);
    const policy = canonicalJson(input.initialPolicy);
    db.prepare("UPDATE projects SET policy_revision=?,policy_json=? WHERE id=?").run(input.initialPolicy.revision, policy, projectId);
    db.prepare("INSERT INTO policy_revisions(project_id,revision,policy_json,authorized_user_id) VALUES(?,?,?,?)").run(projectId, input.initialPolicy.revision, policy, principalId);
    db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES(?,?,?,?,?,'project.create',?,'stored',?)").run(commandId, projectId, principalId, input.requestId, hash, serialized, now);
    db.prepare("INSERT INTO events(id,project_id,type,entity_id,entity_revision,causation_id,body_json,occurred_at) VALUES(?,?,'project.created',?,1,?,'{}',?)").run(randomUUID(), projectId, projectId, commandId, now);
    const sequence = Number(db.prepare("SELECT MAX(sequence) AS n FROM events WHERE project_id=?").get(projectId)?.n);
    const receipt = commitCommandReceipt(db, principalId, commandId, { requestId: input.requestId, projectId, commandId, status: "completed", receiptUrl: `/api/v1/commands/${commandId}/receipt`, entityIds: [{ localRef: projectId, entityType: "project", id: projectId, revision: 1, version: null }], error: null, lastEventSequence: sequence });
    db.prepare("INSERT INTO global_requests(principal_id,request_id,request_hash,project_id,state,receipt_json) VALUES(?,?,?,?,'completed',?)").run(principalId, input.requestId, hash, projectId, canonicalJson(receipt));
    return receipt;
  });
}

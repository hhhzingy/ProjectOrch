import type { DatabaseSync } from "node:sqlite";
import { parseContract, type ContractRegistry } from "@projectorch/contracts";
import { parsePermissionProfile } from "@projectorch/domain/policy";

/** 从当前持久策略解析权限，不能由工具配置快照授予额外能力。 */
export function readProjectPolicy(db: DatabaseSync, projectId: string): ContractRegistry["policy"] {
  const row = db.prepare("SELECT policy_json,policy_revision FROM projects WHERE id=?").get(projectId);
  if (!row) throw new Error("PROJECT_NOT_FOUND");
  const policy = parseContract("policy", JSON.parse(String(row.policy_json)));
  if (policy.revision !== row.policy_revision) throw new Error("POLICY_REVISION_CONFLICT");
  const names = new Set<string>();
  for (const profile of policy.profiles) {
    parsePermissionProfile(profile);
    if (names.has(profile.id)) throw new Error("DUPLICATE_POLICY_PROFILE");
    names.add(profile.id);
  }
  return policy;
}

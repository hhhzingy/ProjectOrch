/** Git只读提交核验与不可变仓库来源；不推送、不改工作树，不将SHA-1标成SHA-256。 */
import path from "node:path";
import { realpathSync } from "node:fs";
import type { Store } from "@projectorch/persistence";
import { registerGitArtifactWithin, assertGitArtifactSource } from "./git-source.js";

export { inspectCommit, repositoryScope, type GitCommitEvidence } from "./git-inspect.js";
export {inspectRepository,verifyCommitGraph,gitRead} from './git-inspect.js';
export { registerGitArtifactWithin, assertGitArtifactSource } from "./git-source.js";

/** 兼容受信域调用；仓库必须在项目根内，登记固化为相对来源和完整SHA。 */
export function registerGitArtifact(store: Store, input: { readonly id: unknown; readonly projectId: unknown; readonly taskId?: unknown; readonly repoRoot: unknown; readonly revision: unknown }, now: number) {
  if (typeof input.id !== "string" || typeof input.projectId !== "string" || typeof input.repoRoot !== "string" || !path.isAbsolute(input.repoRoot) || typeof input.revision !== "string") throw new Error("INVALID_GIT_REPO_ROOT");
  const project = store.db.prepare("SELECT canonical_root FROM projects WHERE id=?").get(input.projectId);
  if (!project) throw new Error("ARTIFACT_PROJECT_NOT_FOUND");
  const relative = path.relative(realpathSync.native(String(project.canonical_root)), realpathSync.native(input.repoRoot)).split(path.sep).join("/") || ".";
  return store.transaction(() => registerGitArtifactWithin(store, { id: input.id as string, projectId: input.projectId as string, taskId: input.taskId, repositoryPath: relative, revision: input.revision as string }, now));
}

/** 旧调用可核对期望仓库，但不能用任意新仓库替换已登记来源。 */
export function verifyGitArtifact(store: Store, projectId: string, artifactId: string, repoRoot?: string) {
  try {
    const verified = assertGitArtifactSource(store, projectId, artifactId);
    if (repoRoot !== undefined && path.relative(realpathSync.native(repoRoot), verified.identity.repository.path) !== "") return { ok: false as const, reason: "GIT_REPOSITORY_CHANGED" };
    return { ok: true as const, evidence: verified.evidence };
  } catch (error) {
    const message = String((error as Error).message);
    return { ok: false as const, reason: message === "GIT_REPOSITORY_CHANGED" ? "GIT_REPOSITORY_CHANGED" : message === "CAPABILITY_UNSUPPORTED" ? "GIT_SOURCE_MISSING" : "GIT_COMMIT_UNRESOLVABLE" };
  }
}

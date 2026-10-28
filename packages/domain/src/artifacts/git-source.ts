import type { Store } from "@projectorch/persistence";
import { registerArtifactWithin, readArtifactRecord } from "./index.js";
import { inspectRepository, inspectCommit, verifyCommitGraph, repositoryScope, checkedGitScope } from "./git-inspect.js";

function projectRoot(store: Store, projectId: string): string {
  const project = store.db.prepare("SELECT canonical_root FROM projects WHERE id=?").get(projectId);
  if (!project) throw new Error("ARTIFACT_PROJECT_NOT_FOUND");
  return String(project.canonical_root);
}
export function registerGitArtifactWithin(store: Store, input: { readonly id: string; readonly projectId: string; readonly taskId?: unknown; readonly taskRevision?: unknown; readonly repositoryPath: string; readonly revision: string }, now: number, authorizeScope: (path: string) => void = () => {}) {
  if (!store.db.isTransaction) throw new Error("GIT_TRANSACTION_REQUIRED");
  authorizeScope = checkedGitScope(authorizeScope);
  authorizeScope(repositoryScope(input.repositoryPath));
  const root = projectRoot(store, input.projectId);
  const identity = inspectRepository(root, input.repositoryPath, authorizeScope);
  const evidence = inspectCommit(identity.repository.path, input.revision);
  const tree = verifyCommitGraph(identity.repository.path, evidence.commitSha);
  if (JSON.stringify(identity) !== JSON.stringify(inspectRepository(root, input.repositoryPath, authorizeScope))) throw new Error("GIT_REPOSITORY_CHANGED");
  const artifact = registerArtifactWithin(store.db, { id: input.id, projectId: input.projectId, taskId: input.taskId, taskRevision: input.taskRevision, pathRef: `git:${evidence.commitSha}`, version: evidence.commitSha }, now);
  store.db.prepare("INSERT INTO artifact_git_sources(artifact_id,project_id,repository_path,identity_json,commit_sha,tree_sha,evidence_json,registered_at) VALUES(?,?,?,?,?,?,?,?)").run(artifact.id, input.projectId, input.repositoryPath, JSON.stringify(identity), evidence.commitSha, tree, JSON.stringify(evidence), now);
  return { ...artifact, git: evidence, repositoryPath: input.repositoryPath };
}

/** 文件系统访问前核验登记范围；旧裸引用不推断仓库。 */
export function assertGitArtifactSource(store: Store, projectId: string, artifactId: string, authorizeScope: (path: string) => void = () => {}) {
  authorizeScope = checkedGitScope(authorizeScope);
  const artifact = readArtifactRecord(store, projectId, artifactId);
  const source = store.db.prepare("SELECT * FROM artifact_git_sources WHERE artifact_id=? AND project_id=?").get(artifactId, projectId);
  if (!artifact.pathRef.startsWith("git:") || !source) throw new Error("CAPABILITY_UNSUPPORTED");
  const repositoryPath = String(source.repository_path);
  authorizeScope(repositoryScope(repositoryPath));
  const identity = inspectRepository(projectRoot(store, projectId), repositoryPath, authorizeScope);
  if (JSON.stringify(identity) !== source.identity_json) throw new Error("GIT_REPOSITORY_CHANGED");
  if (artifact.pathRef !== `git:${String(source.commit_sha)}` || artifact.version !== source.commit_sha) throw new Error("GIT_SOURCE_TARGET_MISMATCH");
  const evidence = inspectCommit(identity.repository.path, String(source.commit_sha));
  if (verifyCommitGraph(identity.repository.path, evidence.commitSha) !== source.tree_sha || JSON.stringify(evidence) !== source.evidence_json) throw new Error("GIT_SOURCE_EVIDENCE_CHANGED");
  if (JSON.stringify(identity) !== JSON.stringify(inspectRepository(projectRoot(store, projectId), repositoryPath, authorizeScope))) throw new Error("GIT_REPOSITORY_CHANGED");
  return { repositoryPath, evidence, treeSha: String(source.tree_sha), identity };
}

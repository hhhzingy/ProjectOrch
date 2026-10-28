import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import path from "node:path";
import { isWellFormedRelativePath } from "../policy/index.js";

export interface GitCommitEvidence { readonly commitSha: string; readonly author: string; readonly authoredAt: string; readonly subject: string }
const sha = /^[0-9a-f]{40}$/;

/** 只调用固定Git只读子命令；不继承Git目录/替代对象/凭据助手等环境注入，不联网补对象。 */
export function gitRead(repo: string, args: readonly string[]): Buffer {
  const env: Record<string, string> = {};
  for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "COMSPEC", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key] as string;
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" });
  try { return execFileSync("git", ["--no-pager", "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=", "-c", "protocol.allow=never", "-C", repo, ...args], { env, stdio: ["ignore", "pipe", "pipe"], timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true }); }
  catch { throw new Error("GIT_READ_FAILED"); }
}
const text = (repo: string, args: readonly string[]) => gitRead(repo, args).toString("utf8").trim();
function verifyObject(repo: string, type: "commit" | "tree", id: string): void {
  const bytes = gitRead(repo, ["cat-file", type, id]);
  if (createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex") !== id) throw new Error("GIT_OBJECT_HASH_MISMATCH");
}
export function inspectCommit(repoRoot: string, revision: string): GitCommitEvidence {
  if (typeof revision !== "string" || !revision || revision.length > 128 || /[\r\n\0]/.test(revision)) throw new Error("INVALID_GIT_REVISION");
  let id: string;
  try { id = text(repoRoot, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]); } catch { throw new Error("GIT_COMMIT_NOT_FOUND"); }
  if (!sha.test(id)) throw new Error("GIT_OBJECT_FORMAT_UNSUPPORTED");
  verifyObject(repoRoot, "commit", id);
  const fields = text(repoRoot, ["show", "--no-show-signature", "--no-decorate", "-s", "--format=%an%x00%aI%x00%s", id]).split("\0");
  const [author, authoredAt, subject] = fields;
  if (fields.length !== 3 || author === undefined || authoredAt === undefined || subject === undefined) throw new Error("GIT_METADATA_INCOMPLETE");
  return { commitSha: id, author, authoredAt, subject };
}
export const repositoryScope = (relative: string): string => relative === "." ? "repositories/root" : relative;
export function checkedGitScope(authorizeScope: (path: string) => void): (path: string) => void {
  if (typeof authorizeScope !== "function" || authorizeScope.constructor.name === "AsyncFunction") throw new Error("GIT_SCOPE_CHECK_REQUIRED");
  return target => {
    const result: unknown = authorizeScope(target);
    if (result && typeof (result as { then?: unknown }).then === "function") { void Promise.resolve(result).catch(() => undefined); throw new Error("GIT_SCOPE_CHECK_REQUIRED"); }
    if (result !== undefined) throw new Error("GIT_SCOPE_CHECK_REQUIRED");
  };
}
function contained(root: string, target: string): boolean { const rel = path.relative(root, target); return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`)); }
function identity(directory: string) { const stat = statSync(directory, { bigint: true }); if (!stat.isDirectory()) throw new Error("GIT_DIRECTORY_REQUIRED"); return { path: directory, device: String(stat.dev), inode: String(stat.ino) }; }
function assertObjectStore(objects: string): void {
  const pending = [objects], deadline = Date.now() + 10000;
  while (pending.length) {
    const directory = pending.pop(); if (!directory) break;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (Date.now() > deadline) throw new Error("GIT_OBJECT_SCAN_LIMIT");
      const filename = path.join(directory, entry.name), stat = lstatSync(filename);
      if (stat.isSymbolicLink()) throw new Error("GIT_OBJECT_LINK_UNSUPPORTED");
      if (stat.isDirectory()) pending.push(filename);
      else if (!stat.isFile()) throw new Error("GIT_OBJECT_FILE_REQUIRED");
    }
  }
}
export function inspectRepository(projectRoot: string, relative: string, authorizeScope: (path: string) => void = () => {}) {
  const checkScope = checkedGitScope(authorizeScope);
  if (relative !== "." && !isWellFormedRelativePath(relative)) throw new Error("INVALID_GIT_REPOSITORY_PATH");
  const root = realpathSync.native(projectRoot), repo = realpathSync.native(path.resolve(root, relative));
  if (!contained(root, repo)) throw new Error("GIT_REPOSITORY_OUTSIDE_PROJECT");
  checkScope(repositoryScope(relative));
  checkScope(repositoryScope(path.relative(root, repo).split(path.sep).join("/") || "."));
  const gitDir = realpathSync.native(text(repo, ["rev-parse", "--absolute-git-dir"]));
  const commonDir = realpathSync.native(text(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const objects = realpathSync.native(path.join(commonDir, "objects"));
  if (![gitDir, commonDir, objects].every(dir => contained(root, dir))) throw new Error("GIT_METADATA_OUTSIDE_PROJECT");
  const scopeFor = (target: string) => repositoryScope(path.relative(root, target).split(path.sep).join("/") || ".");
  // 共享Git目录/对象库跨出已授权checkout时，必须另有其实际路径授权。
  if (!contained(repo, commonDir)) checkScope(scopeFor(commonDir));
  if (!contained(repo, gitDir) && !contained(commonDir, gitDir)) checkScope(scopeFor(gitDir));
  if (!contained(repo, objects) && !contained(commonDir, objects)) checkScope(scopeFor(objects));
  assertObjectStore(objects);
  const alternates = path.join(objects, "info", "alternates");
  if (existsSync(alternates) && readFileSync(alternates).length !== 0) throw new Error("GIT_ALTERNATES_UNSUPPORTED");
  const bare = text(repo, ["rev-parse", "--is-bare-repository"]);
  const top = bare === "true" ? gitDir : realpathSync.native(text(repo, ["rev-parse", "--show-toplevel"]));
  if (path.relative(repo, top) !== "") throw new Error("GIT_REPOSITORY_ROOT_REQUIRED");
  if (text(repo, ["rev-parse", "--show-object-format"]) !== "sha1") throw new Error("GIT_OBJECT_FORMAT_UNSUPPORTED");
  return { repository: identity(repo), gitDirectory: identity(gitDir), commonDirectory: identity(commonDir), objects: identity(objects), canonicalRelativePath: path.relative(root, repo).split(path.sep).join("/") || ".", objectFormat: "sha1" as const };
}
export function verifyCommitGraph(repo: string, id: string): string {
  const tree = text(repo, ["rev-parse", "--verify", `${id}^{tree}`]);
  if (!sha.test(tree)) throw new Error("GIT_TREE_INVALID");
  verifyObject(repo, "tree", tree);
  // 固定只读对象完整性检查，不执行工作树测试、hook、构建或签名程序。
  gitRead(repo, ["fsck", "--strict", "--no-dangling", "--no-reflogs", "--no-progress", "--no-references", id]);
  return tree;
}

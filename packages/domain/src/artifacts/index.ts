/** T029准备切片：成果登记与范围读取。登记=项目内相对路径+版本+可选哈希/字节数（不可变版本证据，A042）；
 * 解析=词法+真实路径双重边界（逃逸/重解析点拒绝，A043）；核验=当前内容哈希与登记比对，缺失/漂移明确报告而非静默替换。 */
import { createHash } from "node:crypto";
import { lstatSync, realpathSync, openSync, closeSync, fstatSync, readSync, constants } from "node:fs";
import path from "node:path";
import type { Store } from "@projectorch/persistence";
import { isWellFormedRelativePath,isRuntimeMetadataPath } from "../policy/index.js";

export interface ArtifactRecord {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string | null;
  readonly taskRevision: number | null;
  readonly version: string;
  readonly pathRef: string;
  readonly sha256: string | null;
  readonly byteSize: number | null;
}

const text = (value: unknown, label: string, max: number): string => {
  if (typeof value !== "string" || !value || value.length > max || /[\r\n\0]/.test(value)) throw new Error(`INVALID_ARTIFACT_${label}`);
  return value;
};

/** 登记成果：pathRef必须是项目内相对路径（策略层单一语法）；sha256为64位十六进制或省略；同一(id,project)唯一。事务内变体供命令runner复用。 */
export function registerArtifactWithin(db: Parameters<Parameters<Store["transaction"]>[0]>[0], input: { readonly id: unknown; readonly projectId: unknown; readonly taskId?: unknown; readonly taskRevision?: unknown; readonly version: unknown; readonly pathRef: unknown; readonly sha256?: unknown; readonly byteSize?: unknown }, now: number): ArtifactRecord {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_ARTIFACT_TIME");
  const SHA_ONLY = /^[0-9a-f]{40}$/;
  const id = text(input.id, "ID", 128);
  const projectId = text(input.projectId, "PROJECT", 128);
  const taskId = input.taskId === undefined || input.taskId === null ? null : text(input.taskId, "TASK", 128);
  const version = text(input.version, "VERSION", 128);
  const pathRef = text(input.pathRef, "PATHREF", 2048);
  if(isRuntimeMetadataPath(pathRef))throw Error('ARTIFACT_RUNTIME_METADATA_REFUSED');
  // 双引用命名空间：项目内相对路径，或git:<40位完整SHA>（git成果无文件路径）
  if (!(pathRef.startsWith("git:") && SHA_ONLY.test(pathRef.slice(4))) && !isWellFormedRelativePath(pathRef)) throw new Error("INVALID_ARTIFACT_PATHREF");
  const sha256 = input.sha256 === undefined || input.sha256 === null ? null : (() => { const value = text(input.sha256, "SHA", 64); if (!/^[a-f0-9]{64}$/.test(value) && !/^[0-9a-f]{40}$/.test(value)) throw new Error("INVALID_ARTIFACT_SHA"); return value; })(); // 40位=git提交引用（T041）
  const byteSize = input.byteSize === undefined || input.byteSize === null ? null : (() => { if (typeof input.byteSize !== "number" || !Number.isSafeInteger(input.byteSize) || input.byteSize < 0) throw new Error("INVALID_ARTIFACT_SIZE"); return input.byteSize; })();
  if (!db.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)) throw new Error("ARTIFACT_PROJECT_NOT_FOUND");
  // 登记不读取文件字节；已有多链接文件明确不支持，历史登记在读取时再次核验。
  if (!pathRef.startsWith('git:')) {
    const root = db.prepare('SELECT canonical_root FROM projects WHERE id=?').get(projectId);
    let existing: import('node:fs').Stats | undefined;
    try { existing = lstatSync(path.resolve(String(root?.canonical_root), pathRef)); }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
    if (existing?.isFile() && existing.nlink !== 1) throw Error('ARTIFACT_HARDLINK_UNSUPPORTED');
  }
  const task = taskId === null ? null : db.prepare("SELECT spec_revision FROM tasks WHERE id=? AND project_id=?").get(taskId, projectId);
  if (taskId !== null && !task) throw new Error("ARTIFACT_TASK_NOT_FOUND");
  const taskRevision = task === null ? null : Number(task?.spec_revision);
  if (input.taskRevision !== undefined && (taskRevision === null || !Number.isSafeInteger(input.taskRevision) || input.taskRevision !== taskRevision)) throw new Error("ARTIFACT_TASK_REVISION_STALE");
  db.prepare("INSERT INTO artifacts(id,project_id,task_id,version,path_ref,sha256,byte_size,task_revision) VALUES(?,?,?,?,?,?,?,?)").run(id, projectId, taskId, version, pathRef, sha256, byteSize, taskRevision);
  return Object.freeze({ id, projectId, taskId, taskRevision, version, pathRef, sha256, byteSize });
}

export function registerArtifact(store: Store, input: Parameters<typeof registerArtifactWithin>[1], now: number): ArtifactRecord {
  return store.transaction(db => registerArtifactWithin(db, input, now));
}

export function readArtifactRecord(store: Store, projectId: string, artifactId: string): ArtifactRecord {
  const row = store.db.prepare("SELECT id,project_id,task_id,task_revision,version,path_ref,sha256,byte_size FROM artifacts WHERE id=? AND project_id=?").get(artifactId, projectId);
  if (!row) throw new Error("ARTIFACT_NOT_FOUND");
  const record = row as Record<string, unknown>;
  return Object.freeze({ id: String(record.id), projectId: String(record.project_id), taskId: record.task_id === null ? null : String(record.task_id), taskRevision: record.task_revision === null ? null : Number(record.task_revision), version: String(record.version), pathRef: String(record.path_ref), sha256: record.sha256 === null ? null : String(record.sha256), byteSize: record.byte_size === null ? null : Number(record.byte_size) });
}

export type BoundaryCheck = { readonly ok: true; readonly absolutePath: string } | { readonly ok: false; readonly reason: "ESCAPES_PROJECT_ROOT" | "UNRESOLVED" | 'RUNTIME_METADATA_REFUSED' };

/** 路径边界（A043）：projectRoot必须是canonicalRoot产物；词法拼接后，文件或其最近存在祖先经realpath解析不得逃逸项目根（拒绝junction/符号链接越界）。 */
export function resolveWithinProject(projectRoot: string, relativePath: string): BoundaryCheck {
  if(isRuntimeMetadataPath(relativePath))return {ok:false,reason:'RUNTIME_METADATA_REFUSED'};
  if (!isWellFormedRelativePath(relativePath)) return { ok: false, reason: "ESCAPES_PROJECT_ROOT" };
  const normalizedRoot = projectRoot.endsWith("\\") || projectRoot.endsWith("/") ? projectRoot : projectRoot + "\\";
  let rootReal: string;
  try { rootReal = realpathSync.native(normalizedRoot); } catch { return { ok: false, reason: "UNRESOLVED" }; }
  const absolute = normalizedRoot + relativePath.replaceAll("/", "\\");
  // 自文件向上找最近存在祖先做真实解析（文件可尚未创建）
  let cursor = absolute;
  const tails: string[] = [];
  for (;;) {
    try { lstatSync(cursor); break; } catch { const parent = cursor.replace(/[\\/]([^\\/]+)[\\/]?$/, ""); if (parent === cursor || parent.length < rootReal.length) { cursor = ""; break; } tails.unshift(cursor.slice(parent.length + 1)); cursor = parent; }
  }
  if (!cursor) return { ok: false, reason: "UNRESOLVED" };
  let resolved: string;
  try { resolved = realpathSync.native(cursor); } catch { return { ok: false, reason: "UNRESOLVED" }; }
  for (const tail of tails) resolved = resolved + "\\" + tail;
  const rootCanonical = rootReal.endsWith("\\") ? rootReal : rootReal + "\\";
  if (!resolved.startsWith(rootCanonical)) return { ok: false, reason: "ESCAPES_PROJECT_ROOT" };
  if(isRuntimeMetadataPath(resolved.slice(rootCanonical.length)))return {ok:false,reason:'RUNTIME_METADATA_REFUSED'};
  return { ok: true, absolutePath: resolved };
}

export type ContentCheck = { readonly ok: true; readonly sha256: string; readonly byteSize: number } | { readonly ok: false; readonly reason: "MISSING_CONTENT" | "CONTENT_DIVERGED"; readonly observedSha256: string | null; readonly observedByteSize: number | null };

/** 内容核验（A042）：读当前文件哈希与登记值比对；缺失=MISSING_CONTENT；漂移=CONTENT_DIVERGED（登记版本证据保持不变，不静默替换）。 */
export function verifyArtifactContent(store: Store, projectId: string, artifactId: string, projectRoot: string, read: (absolutePath: string) => { readonly sha256: string; readonly byteSize: number } | null): ContentCheck {
  const record = readArtifactRecord(store, projectId, artifactId);
  if (record.sha256 === null) throw new Error("ARTIFACT_NO_REGISTERED_HASH");
  const boundary = resolveWithinProject(projectRoot, record.pathRef);
  if (!boundary.ok) return { ok: false, reason: "MISSING_CONTENT", observedSha256: null, observedByteSize: null };
  const observed = read(boundary.absolutePath);
  if (observed === null) return { ok: false, reason: "MISSING_CONTENT", observedSha256: null, observedByteSize: null };
  if (observed.sha256 !== record.sha256) return { ok: false, reason: "CONTENT_DIVERGED", observedSha256: observed.sha256, observedByteSize: observed.byteSize };
  return { ok: true, sha256: observed.sha256, byteSize: observed.byteSize };
}

/** 受信读取实现：整文件SHA-256与字节数（真实文件访问层的规范化与重解析复核由正式任务在此语义上实现）。 */
export function readFileFingerprint(absolutePath: string): { readonly sha256: string; readonly byteSize: number } | null {
  let fd: number | undefined;
  try {
    if(isRuntimeMetadataPath(absolutePath)||isRuntimeMetadataPath(realpathSync.native(absolutePath)))return null;
    const before=lstatSync(absolutePath,{bigint:true});
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n)return null;
    fd=openSync(absolutePath,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
    const same=(a:typeof before,b:typeof before)=>a.isFile()&&b.isFile()&&a.nlink===1n&&b.nlink===1n&&a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.ctimeNs===b.ctimeNs&&a.mtimeNs===b.mtimeNs;
    const opened=fstatSync(fd,{bigint:true});if(!same(before,opened))return null;
    const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let bytes=0;const deadline=Date.now()+10000;
    for(;;){if(Date.now()>deadline)return null;const length=readSync(fd,buffer,0,buffer.length,null);if(!length)break;bytes+=length;if(bytes>64*1024*1024)return null;hash.update(buffer.subarray(0,length));}
    const after=fstatSync(fd,{bigint:true}),named=lstatSync(absolutePath,{bigint:true});
    if(!same(opened,after)||!same(after,named)||BigInt(bytes)!==after.size)return null;
    return {sha256:hash.digest('hex'),byteSize:bytes};
  } catch { return null; }
  finally {if(fd!==undefined)closeSync(fd);}
}

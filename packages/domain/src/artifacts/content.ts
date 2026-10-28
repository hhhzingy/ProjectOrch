import { createHash } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, lstatSync, realpathSync, readSync, type BigIntStats } from "node:fs";
import path from "node:path";
import type { Store } from "@projectorch/persistence";
import { parseContract, type ContractRegistry } from "@projectorch/contracts";
import { isWellFormedRelativePath,isRuntimeMetadataPath } from "../policy/index.js";
import { readArtifactRecord } from "./index.js";
import { assertGitArtifactSource } from "./git-source.js";
import { gitRead } from "./git-inspect.js";

export const artifactChunkBytes = 49152;
function hasControls(value: string): boolean {
  for (let i = 0; i < value.length; i++) { const code = value.charCodeAt(i); if (code < 32 && ![9, 10, 12, 13].includes(code)) return true; }
  return false;
}
function text(bytes: Uint8Array): boolean {
  try { return !hasControls(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); } catch { return false; }
}
function chunk(id: string, version: string, offset: number, size: number, captured: Buffer, utf8: boolean, sha256: string): ContractRegistry["artifact-chunk"] {
  let count = Math.min(artifactChunkBytes, captured.length);
  if (utf8) {
    if (captured.length > 0 && ((captured[0] as number) & 0xc0) === 0x80) throw new Error("INVALID_ARTIFACT_OFFSET");
    while (count < captured.length && ((captured[count] as number) & 0xc0) === 0x80) count--;
  }
  const bytes = captured.subarray(0, count);
  return parseContract("artifact-chunk", { artifactId: id, version, offset, content: utf8 ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) : bytes.toString("base64"), encoding: utf8 ? "utf8" : "base64", nextOffset: offset + count < size ? offset + count : null, sha256 });
}
function scopeCheck(check: (path: string) => void) {
  if (typeof check !== "function" || check.constructor.name === "AsyncFunction") throw new Error("ARTIFACT_SCOPE_CHECK_REQUIRED");
  return (target: string) => {
    const result: unknown = check(target);
    if (result && typeof (result as { then?: unknown }).then === "function") { void Promise.resolve(result).catch(() => undefined); throw new Error("ARTIFACT_SCOPE_CHECK_REQUIRED"); }
    if (result !== undefined) throw new Error("ARTIFACT_SCOPE_CHECK_REQUIRED");
  };
}
const sameStat = (a: BigIntStats, b: BigIntStats) => a.isFile() && b.isFile() && a.nlink === 1n && b.nlink === 1n && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** 仅供已认证事务；登记版本及完整哈希成立后才返回本次读取的分片。 */
export function readArtifactChunk(store: Store, projectId: string, artifactId: string, version: string, offset: number, authorize: (path: string) => void): ContractRegistry["artifact-chunk"] {
  if (!store.db.isTransaction) throw new Error("ARTIFACT_READ_TRANSACTION_REQUIRED");
  const check = scopeCheck(authorize), record = readArtifactRecord(store, projectId, artifactId);
  if(isRuntimeMetadataPath(record.pathRef))throw Error('ARTIFACT_RUNTIME_METADATA_REFUSED');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("INVALID_ARTIFACT_OFFSET");
  if (record.pathRef.startsWith("git:")) {
    const verified = assertGitArtifactSource(store, projectId, artifactId, check);
    if (version !== record.version) throw new Error("ARTIFACT_VERSION_CONFLICT");
    const bytes = gitRead(verified.identity.repository.path, ["cat-file", "commit", record.version]);
    if (offset > bytes.length) throw new Error("INVALID_ARTIFACT_OFFSET");
    if (createHash("sha1").update(`commit ${bytes.length}\0`).update(bytes).digest("hex") !== record.version) throw new Error("ARTIFACT_CONTENT_CHANGED");
    return chunk(artifactId, version, offset, bytes.length, bytes.subarray(offset, offset + artifactChunkBytes + 4), text(bytes), createHash("sha256").update(bytes).digest("hex"));
  }
  check(record.pathRef);
  if (version !== record.version) throw new Error("ARTIFACT_VERSION_CONFLICT");
  if (!record.sha256 || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error("ARTIFACT_HASH_REQUIRED");
  if (!isWellFormedRelativePath(record.pathRef)) throw new Error("ARTIFACT_NOT_FOUND");
  const project = store.db.prepare("SELECT canonical_root FROM projects WHERE id=?").get(projectId);
  if (!project) throw new Error("ARTIFACT_NOT_FOUND");
  let fd: number | undefined;
  try {
    const root = realpathSync.native(String(project.canonical_root));
    if(isRuntimeMetadataPath(root))throw Error('ARTIFACT_RUNTIME_METADATA_REFUSED');
    const resolve = () => {
      const absolute = realpathSync.native(path.resolve(root, record.pathRef)), relative = path.relative(root, absolute);
      if(isRuntimeMetadataPath(relative))throw Error('ARTIFACT_RUNTIME_METADATA_REFUSED');
      if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("ARTIFACT_NOT_FOUND");
      check(relative.split(path.sep).join("/")); return absolute;
    };
    const filename = resolve(), before = lstatSync(filename, { bigint: true });
    if (!before.isFile()) throw new Error("ARTIFACT_NOT_FOUND");
    if (before.nlink !== 1n) throw new Error("ARTIFACT_HARDLINK_UNSUPPORTED");
    fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameStat(before, opened) || resolve() !== filename || !sameStat(opened, lstatSync(filename, { bigint: true }))) throw new Error("ARTIFACT_CONTENT_CHANGED");
    const size = Number(opened.size);
    if (!Number.isSafeInteger(size)) throw new Error("ARTIFACT_READ_LIMIT");
    if (offset > size) throw new Error("INVALID_ARTIFACT_OFFSET");
    if (record.byteSize !== null && record.byteSize !== size) throw new Error("ARTIFACT_CONTENT_CHANGED");
    const digest = createHash("sha256"), buffer = Buffer.alloc(65536), captured: Buffer[] = [], decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const deadline = Date.now() + 10000; let position = 0, utf8 = true;
    for (;;) {
      if (Date.now() > deadline) throw new Error("ARTIFACT_READ_LIMIT");
      const count = readSync(fd, buffer, 0, buffer.length, position); if (count === 0) break;
      const bytes = buffer.subarray(0, count); digest.update(bytes);
      if (utf8) try { if (hasControls(decoder.decode(bytes, { stream: true }))) utf8 = false; } catch { utf8 = false; }
      const from = Math.max(position, offset), to = Math.min(position + count, offset + artifactChunkBytes + 4);
      if (to > from) captured.push(Buffer.from(bytes.subarray(from - position, to - position)));
      position += count;
    }
    if (utf8) try { decoder.decode(); } catch { utf8 = false; }
    const hash = digest.digest("hex"), after = fstatSync(fd, { bigint: true });
    if (position !== size || hash !== record.sha256 || !sameStat(opened, after) || resolve() !== filename || !sameStat(after, lstatSync(filename, { bigint: true }))) throw new Error("ARTIFACT_CONTENT_CHANGED");
    return chunk(artifactId, version, offset, size, Buffer.concat(captured), utf8, hash);
  } catch (error) {
    if (error instanceof Error && /^(ARTIFACT_|INVALID_ARTIFACT_OFFSET)/.test(error.message)) throw error;
    throw new Error("ARTIFACT_NOT_FOUND");
  } finally { if (fd !== undefined) closeSync(fd); }
}

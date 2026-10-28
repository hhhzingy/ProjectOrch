/** T050准备切片：备份迁移与回滚。backup=VACUUM INTO一致快照（含WAL下安全）+integrity_check+迁移版本记录；
 * verify=备份文件integrity_check+user_version与当前迁移数一致；
 * restore=主库关闭前提下：备份integrity通过→覆盖主库→重开校验；任一步失败保留原文件副本（.prerestore）供人工回退。仅文件级操作，不含增量同步。 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultMigrations } from "./index.js";

const SQLITE_META = /sqlite_(master|sequence|stat1|autoindex)/i;

function integrityOk(db: DatabaseSync): boolean {
  const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined;
  return row?.integrity_check === "ok";
}

export interface BackupResult {
  readonly backupPath: string;
  readonly userVersion: number;
  readonly tables: number;
  readonly bytes: number;
}

/** 一致快照备份：store须处于打开状态（VACUUM INTO在只读连接上执行一致读）。 */
export function backupStore(store: { readonly db: DatabaseSync }, targetPath: string, now: number): BackupResult {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_BACKUP_TIME");
  if (typeof targetPath !== "string" || !targetPath.endsWith(".sqlite")) throw new Error("INVALID_BACKUP_TARGET");
  if (fs.existsSync(targetPath)) throw new Error("BACKUP_TARGET_EXISTS");
  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(path.dirname(resolved))) throw new Error("BACKUP_DIR_MISSING");
  store.db.prepare("VACUUM INTO ?").run(resolved);
  const probe = new DatabaseSync(resolved, { readOnly: true });
  try {
    if (!integrityOk(probe)) throw new Error("BACKUP_INTEGRITY_FAILED");
    const userVersion = Number(probe.prepare("PRAGMA user_version").get()?.user_version);
    const tables = Number(probe.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()?.n);
    if (userVersion !== defaultMigrations().length) throw new Error("BACKUP_VERSION_MISMATCH");
    const bytes = fs.statSync(resolved).size;
    return Object.freeze({ backupPath: resolved, userVersion, tables, bytes });
  } finally { probe.close(); }
}

export interface VerifyResult {
  readonly integrity: boolean;
  readonly userVersion: number;
  readonly expectedUserVersion: number;
  readonly foreignKeyViolations: number;
}

/** 备份校验：integrity+版本一致+外键完整性（foreign_key_check空）。 */
export function verifyBackup(backupPath: string): VerifyResult {
  if (!fs.existsSync(backupPath)) throw new Error("BACKUP_MISSING");
  const probe = new DatabaseSync(backupPath, { readOnly: true });
  try {
    const foreignKeyViolations = probe.prepare("PRAGMA foreign_key_check").all().length;
    return Object.freeze({
      integrity: integrityOk(probe),
      userVersion: Number(probe.prepare("PRAGMA user_version").get()?.user_version),
      expectedUserVersion: defaultMigrations().length,
      foreignKeyViolations,
    });
  } finally { probe.close(); }
}

export interface RestoreResult {
  readonly restored: boolean;
  readonly userVersion: number;
  readonly prerollbackCopy: string | null;
}

/** 恢复：mainPath必须无打开连接（调用方先stop内核）；备份校验通过后覆盖主库，原文件保留.prerestore副本；
 * 校验或覆盖失败→抛出且不触碰主库（.prerestore副本可用于人工回退，由测试验证失败路径不破坏主库）。 */
export function restoreFromBackup(backupPath: string, mainPath: string, now: number): RestoreResult {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_BACKUP_TIME");
  if (fs.existsSync(mainPath + "-wal") || fs.existsSync(mainPath + "-shm")) throw new Error("MAIN_STORE_APPEARS_OPEN");
  const verification = verifyBackup(backupPath);
  if (!verification.integrity || verification.foreignKeyViolations > 0) throw new Error("BACKUP_VERIFY_FAILED");
  if (verification.userVersion !== verification.expectedUserVersion) throw new Error("BACKUP_VERSION_MISMATCH");
  let prerollbackCopy: string | null = null;
  if (fs.existsSync(mainPath)) {
    prerollbackCopy = mainPath + ".prerestore";
    fs.copyFileSync(mainPath, prerollbackCopy);
  }
  try {
    fs.copyFileSync(backupPath, mainPath);
    // 覆盖后重开校验：不通过则从.prerestore回滚
    const reopened = new DatabaseSync(mainPath);
    try {
      if (!integrityOk(reopened)) throw new Error("RESTORE_VERIFY_FAILED");
      const userVersion = Number(reopened.prepare("PRAGMA user_version").get()?.user_version);
      if (userVersion !== verification.expectedUserVersion) throw new Error("RESTORE_VERSION_MISMATCH");
      return { restored: true, userVersion, prerollbackCopy };
    } finally { reopened.close(); }
  } catch (error) {
    if (prerollbackCopy !== null && fs.existsSync(prerollbackCopy)) fs.copyFileSync(prerollbackCopy, mainPath);
    throw error;
  }
}

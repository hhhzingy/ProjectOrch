/** T050：升级前检查与恢复收口。preflight=只读打开主库报告当前/目标版本与待迁移清单（不执行迁移）；
 * rollbackFromBackup=恢复覆盖+写rollback记录（时间/来源/结果哈希，"从备份恢复有记录"）；
 * pendingActionsAfterRestore=恢复后待核对清单：未结消息与在途attempt须人工核对后才继续投递/执行——
 * 投递泵本身只显式调用，恢复不会自动重放副作用，这里给核对入口。 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Store } from "@projectorch/persistence";
import { defaultMigrations } from "@projectorch/persistence";
import { restoreFromBackup } from "@projectorch/persistence/backup";

export interface PreflightReport {
  readonly mainPath: string;
  readonly databaseExists: boolean;
  readonly currentVersion: number;
  readonly targetVersion: number;
  readonly pendingMigrations: readonly { version: number; name: string }[];
  readonly walPresent: boolean;
  readonly migrationBackups: readonly string[];
  readonly ready: boolean;
  readonly blockers: readonly string[];
}

/** 只读迁移前检查：报告现状与风险，绝不写库。库不存在=全新初始化（ready，无阻塞项）。 */
export function upgradePreflight(mainPath: string): PreflightReport {
  const databaseExists = existsSync(mainPath);
  const migrations = defaultMigrations();
  const targetVersion = migrations.length;
  const blockers: string[] = [];
  const migrationBackups = existsSync(`${mainPath}.backups`)
    ? readdirSync(`${mainPath}.backups`).filter(f => f.endsWith(".sqlite")).map(f => path.join(`${mainPath}.backups`, f))
    : [];
  if (!databaseExists) return { mainPath, databaseExists, currentVersion: 0, targetVersion, pendingMigrations: migrations.map(m => ({ version: m.version, name: m.name })), walPresent: false, migrationBackups, ready: true, blockers };
  const db = new DatabaseSync(mainPath, { readOnly: true });
  try {
    const currentVersion = Number(db.prepare("PRAGMA user_version").get()?.user_version);
    if (currentVersion > targetVersion) blockers.push(`DATABASE_NEWER_THAN_APPLICATION: 库版本${currentVersion}高于程序版本${targetVersion}，须先升级程序`);
    const ledger = db.prepare("SELECT version,name FROM schema_migrations ORDER BY version").all() as { version: number; name: string }[];
    if (ledger.length !== currentVersion) blockers.push(`MIGRATION_LEDGER_MISMATCH: 账本${ledger.length}条与版本${currentVersion}不符`);
    const pendingMigrations = migrations.filter(m => m.version > currentVersion).map(m => ({ version: m.version, name: m.name }));
    return { mainPath, databaseExists, currentVersion, targetVersion, pendingMigrations, walPresent: existsSync(`${mainPath}-wal`), migrationBackups, ready: blockers.length === 0, blockers };
  } finally { db.close(); }
}

export interface RollbackRecord {
  readonly rolledBackAt: number;
  readonly backupPath: string;
  readonly mainPath: string;
  readonly restoredVersion: number;
  readonly prerollbackCopy: string | null;
  readonly backupSha256: string;
}

/** 从备份回滚主库并落记录文件（mainPath+'.rollback-history.jsonl' 追加一行）。主库必须已关闭。 */
export function rollbackFromBackup(backupPath: string, mainPath: string, now: number): RollbackRecord {
  const restored = restoreFromBackup(backupPath, mainPath, now);
  const backupSha256 = createHash("sha256").update(readFileSync(backupPath)).digest("hex");
  const record: RollbackRecord = { rolledBackAt: now, backupPath, mainPath, restoredVersion: restored.userVersion, prerollbackCopy: restored.prerollbackCopy, backupSha256 };
  appendFileSync(`${mainPath}.rollback-history.jsonl`, JSON.stringify(record) + "\n");
  return record;
}

export interface PendingActionsReport {
  readonly heldMessages: readonly { id: string; projectId: string; toRoleId: string; state: string }[];
  readonly inFlightAttempts: readonly { id: string; projectId: string; taskId: string; state: string }[];
  readonly note: string;
}

/** 恢复后核对清单：未结消息与在途attempt逐条列出，供人工核对外部执行结果后决策继续/作废。 */
export function pendingActionsAfterRestore(store: Store): PendingActionsReport {
  const heldMessages = store.db.prepare("SELECT id, project_id AS projectId, to_role_id AS toRoleId, state FROM messages WHERE state IN ('stored','queued') ORDER BY created_at, id").all() as unknown as { id: string; projectId: string; toRoleId: string; state: string }[];
  const inFlightAttempts = store.db.prepare("SELECT id, project_id AS projectId, task_id AS taskId, state FROM attempts WHERE state IN ('dispatching','running','waiting_input','unknown') ORDER BY id").all() as unknown as { id: string; projectId: string; taskId: string; state: string }[];
  return { heldMessages, inFlightAttempts, note: "恢复后未自动投递/执行：以下条目须先核对外部原生侧实际结果，再决定继续或作废；核对通过前不调用投递泵。" };
}

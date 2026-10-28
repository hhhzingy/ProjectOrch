import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statfsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export interface StoreOptions {
  /** 仅限受信应用启动代码；不接受 Web/Agent 提供的 SQL。 */
  readonly migrations?: readonly Migration[];
  readonly busyTimeoutMs?: number;
}

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const APPLICATION_ID = 0x504f5243;
export const defaultMigrations = (): readonly Migration[] => [
  { version: 1, name: "initial_v2", sql: readFileSync(new URL("../migrations/001_initial.sql", import.meta.url), "utf8") },
  { version: 2, name: "source_provenance", sql: readFileSync(new URL("../migrations/002_provenance.sql", import.meta.url), "utf8") },
  { version: 3, name: "browser_sessions", sql: readFileSync(new URL("../migrations/003_browser_sessions.sql", import.meta.url), "utf8") },
  { version: 4, name: "agent_credentials", sql: readFileSync(new URL("../migrations/004_agent_credentials.sql", import.meta.url), "utf8") },
  { version: 5, name: "kernel_lock", sql: readFileSync(new URL("../migrations/005_kernel_lock.sql", import.meta.url), "utf8") },
  { version: 6, name: "bootstrap_ledger", sql: readFileSync(new URL("../migrations/006_bootstrap_ledger.sql", import.meta.url), "utf8") },
  { version: 7, name: "result_execution_provenance", sql: readFileSync(new URL("../migrations/007_result_execution_provenance.sql", import.meta.url), "utf8") },
  { version: 8, name: "native_control_requests", sql: readFileSync(new URL("../migrations/008_native_control_requests.sql", import.meta.url), "utf8") },
  { version: 9, name: "dependency_provenance", sql: readFileSync(new URL("../migrations/009_dependency_provenance.sql", import.meta.url), "utf8") },
  { version: 10, name: "task_workflow", sql: readFileSync(new URL("../migrations/010_task_workflow.sql", import.meta.url), "utf8") },
  { version: 11, name: "execution_dispatches", sql: readFileSync(new URL("../migrations/011_execution_dispatches.sql", import.meta.url), "utf8") },
  { version: 12, name: "workflow_evaluations", sql: readFileSync(new URL("../migrations/012_workflow_evaluations.sql", import.meta.url), "utf8") },
  { version: 13, name: "agent_command_sources", sql: readFileSync(new URL("../migrations/013_agent_command_sources.sql", import.meta.url), "utf8") },
  { version: 14, name: "git_artifact_sources", sql: readFileSync(new URL("../migrations/014_git_artifact_sources.sql", import.meta.url), "utf8") },
  { version: 15, name: "task_revision_impacts", sql: readFileSync(new URL("../migrations/015_task_revision_impacts.sql", import.meta.url), "utf8") },
  { version: 16, name: "role_model_preference", sql: readFileSync(new URL("../migrations/016_role_model_preference.sql", import.meta.url), "utf8") },
  { version: 17, name: "durable_operations", sql: readFileSync(new URL("../migrations/017_durable_operations.sql", import.meta.url), "utf8") },
  { version: 18, name: "adoption_verification", sql: readFileSync(new URL("../migrations/018_adoption_verification.sql", import.meta.url), "utf8") },
  { version: 19, name: "model_effective", sql: readFileSync(new URL("../migrations/019_model_effective.sql", import.meta.url), "utf8") },
  { version: 20, name: "model_configuration_versions", sql: readFileSync(new URL("../migrations/020_model_configuration_versions.sql", import.meta.url), "utf8") },
  { version: 21, name: "workflow_lookup_indexes", sql: readFileSync(new URL("../migrations/021_workflow_lookup_indexes.sql", import.meta.url), "utf8") },
  { version: 22, name: "question_contract_metadata", sql: readFileSync(new URL("../migrations/022_question_contract_metadata.sql", import.meta.url), "utf8") },
  { version: 23, name: "role_turn_credentials", sql: readFileSync(new URL("../migrations/023_role_turn_credentials.sql", import.meta.url), "utf8") },
  { version: 24, name: "handover_consumptions", sql: readFileSync(new URL("../migrations/024_handover_consumptions.sql", import.meta.url), "utf8") },
  { version: 25, name: "check_definition_authorizations", sql: readFileSync(new URL("../migrations/025_check_definition_authorizations.sql", import.meta.url), "utf8") },
  { version: 26, name: "integration_verification", sql: readFileSync(new URL("../migrations/026_integration_verification.sql", import.meta.url), "utf8") },
  { version: 27, name: "native_write_effects", sql: readFileSync(new URL("../migrations/027_native_write_effects.sql", import.meta.url), "utf8") },
];

/** 只接受包含 WAL-reset 修复的主线版本，保守拒绝未经核验的旧支线回补。 */
export function assertSafeSqliteVersion(version: string): void {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m || Number(m[1]) !== 3 || Number(m[2]) < 51 || (Number(m[2]) === 51 && Number(m[3]) < 3)) {
    throw new Error(`SQLITE_VERSION_UNSAFE: ${version}; requires >=3.51.3 within SQLite 3`);
  }
}

export function localDatabasePath(input: string): string {
  if (!path.isAbsolute(input) || /^(?:\\\\|\/\/)/.test(input)) throw new Error("LOCAL_DISK_REQUIRED");
  const parent = realpathSync(path.dirname(input));
  const full = path.join(parent, path.basename(input));
  if (/^(?:\\\\|\/\/)/.test(parent)) throw new Error("LOCAL_DISK_REQUIRED");
  if (existsSync(full) && (!lstatSync(full).isFile() || lstatSync(full).isSymbolicLink())) throw new Error("REGULAR_DATABASE_FILE_REQUIRED");
  if (process.platform === "win32") {
    const shell=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const type = execFileSync(shell, ["-NoProfile", "-NonInteractive", "-Command", "([System.IO.DriveInfo]::new($env:PROJECTORCH_STORAGE_ROOT)).DriveType.ToString()"], {
      env: { ...process.env, PROJECTORCH_STORAGE_ROOT: path.parse(parent).root }, encoding: "utf8", windowsHide: true,timeout:10000,maxBuffer:4096,
    }).trim();
    if (type !== "Fixed") throw new Error("LOCAL_FIXED_DISK_REQUIRED");
  } else {
    const type = statfsSync(parent).type;
    if ([0x6969, 0xff534d42, 0x517b].includes(type)) throw new Error("LOCAL_DISK_REQUIRED");
  }
  return full;
}

function validateMigrations(migrations: readonly Migration[]): void {
  for (const [i, m] of migrations.entries()) {
    if (m.version !== i + 1 || !m.name || !m.sql.trim()) throw new Error("INVALID_MIGRATION_SEQUENCE");
  }
  if (!migrations.length) throw new Error("EMPTY_MIGRATIONS");
}

function schemaVersion(db: DatabaseSync): number {
  return Number(db.prepare("PRAGMA user_version").get()?.user_version);
}

function verifyLedger(db: DatabaseSync, migrations: readonly Migration[]): number {
  const version = schemaVersion(db);
  if (!Number.isSafeInteger(version) || version < 0) throw new Error("INVALID_DATABASE_VERSION");
  if (version > migrations.length) throw new Error("DATABASE_NEWER_THAN_APPLICATION");
  const applicationId = Number(db.prepare("PRAGMA application_id").get()?.application_id);
  if (!version) {
    // VIEW 等对象也属于用户资产；GLOB 保留字面下划线，不漏掉 sqliteAsset 之类的合法用户名称。
    const objects = db.prepare("SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all();
    if (objects.length || applicationId !== 0) throw new Error("UNRECOGNIZED_DATABASE");
    return version;
  }
  if (applicationId !== APPLICATION_ID) throw new Error("UNRECOGNIZED_DATABASE");
  const rows = db.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all();
  if (rows.length !== version) throw new Error("MIGRATION_LEDGER_MISMATCH");
  for (const [i, row] of rows.entries()) {
    const m = migrations[i];
    if (!m || row.version !== m.version || row.name !== m.name || row.checksum !== hash(m.sql)) throw new Error("MIGRATION_CHECKSUM_MISMATCH");
  }
  return version;
}

export class Store {
  readonly db: DatabaseSync;
  readonly filename: string;
  readonly sqliteVersion: string;
  readonly migrationBackup: string | null;
  #closed = false;
  #transaction = false;
  #transactionGuard: ((db: DatabaseSync) => void) | undefined;

  /** 由 openStore 完成路径、版本和迁移校验后构造。 */
  constructor(db: DatabaseSync, filename: string, sqliteVersion: string, migrationBackup: string | null) {
    this.db = db;
    this.filename = filename;
    this.sqliteVersion = sqliteVersion;
    this.migrationBackup = migrationBackup;
  }

  /** 内核取得锁后安装一次；每个业务事务取得写锁后重验归属，不能被后续调用替换或移除。 */
  installTransactionGuard(guard: (db: DatabaseSync) => void): void {
    if (this.#closed || this.#transaction || this.db.isTransaction || this.#transactionGuard || typeof guard !== "function" || guard.constructor.name === "AsyncFunction") throw new Error("INVALID_TRANSACTION_GUARD");
    this.#transactionGuard = guard;
  }

  transaction<T>(action: (db: DatabaseSync) => T): T {
    if (this.#closed) throw new Error("STORE_CLOSED");
    if (this.#transaction || this.db.isTransaction) throw new Error("NESTED_TRANSACTION_FORBIDDEN");
    if (action.constructor.name === "AsyncFunction") throw new Error("ASYNC_TRANSACTION_FORBIDDEN");
    this.db.exec("BEGIN IMMEDIATE");
    this.#transaction = true;
    try {
      const guarded: unknown = this.#transactionGuard?.(this.db);
      if (guarded && typeof (guarded as { then?: unknown }).then === "function") {
        this.db.exec("ROLLBACK"); this.#transaction = false; this.close();
        void Promise.resolve(guarded).catch(() => undefined);
        throw new Error("ASYNC_TRANSACTION_GUARD_FORBIDDEN");
      }
      const result = action(this.db);
      if (result && typeof (result as { then?: unknown }).then === "function") {
        // 关闭连接，避免误传 Promise 的异步续体在回滚后继续写入。
        this.db.exec("ROLLBACK");
        this.#transaction = false;
        this.close();
        void Promise.resolve(result).catch(() => undefined);
        throw new Error("ASYNC_TRANSACTION_FORBIDDEN");
      }
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (!this.#closed && this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.#transaction = false;
    }
  }

  close(): void {
    if (this.#closed) return;
    if (this.#transaction || this.db.isTransaction) throw new Error("CLOSE_DURING_TRANSACTION");
    this.db.close();
    this.#closed = true;
  }
}

export function openStore(input: string, options: StoreOptions = {}): Store {
  const filename = localDatabasePath(input);
  const existed = existsSync(filename);
  const migrations = options.migrations ?? defaultMigrations();
  validateMigrations(migrations);
  const timeout = options.busyTimeoutMs ?? 2500;
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 30_000) throw new Error("INVALID_BUSY_TIMEOUT");
  const db = new DatabaseSync(filename, { timeout, enableForeignKeyConstraints: true, allowExtension: false, enableDoubleQuotedStringLiterals: false });
  try {
    const sqliteVersion = String(db.prepare("SELECT sqlite_version() AS version").get()?.version);
    assertSafeSqliteVersion(sqliteVersion);
    const initialVersion = verifyLedger(db, migrations);
    let migrationBackup: string | null = null;
    if (initialVersion < migrations.length && existed) {
      const dir = `${filename}.backups`;
      if (existsSync(dir) && (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink())) throw new Error("UNSAFE_BACKUP_DIRECTORY");
      mkdirSync(dir, { recursive: true });
      migrationBackup = path.join(dir, `before-v${migrations.length}-${randomUUID()}.sqlite`);
      db.prepare("VACUUM INTO ?").run(migrationBackup);
    }
    const mode = db.prepare("PRAGMA journal_mode=WAL").get()?.journal_mode;
    if (mode !== "wal") throw new Error("WAL_UNAVAILABLE");
    db.exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;");
    if (initialVersion < migrations.length) {
      db.exec("BEGIN EXCLUSIVE");
      try {
        const current = verifyLedger(db, migrations);
        if (!current) {
          db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT");
          db.exec(`PRAGMA application_id=${APPLICATION_ID}`);
        }
        for (const m of migrations.slice(current)) {
          db.exec(m.sql);
          db.prepare("INSERT INTO schema_migrations VALUES(?,?,?,?)").run(m.version, m.name, hash(m.sql), Date.now());
          db.exec(`PRAGMA user_version=${m.version}`);
        }
        if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("MIGRATION_FOREIGN_KEY_FAILURE");
        db.exec("COMMIT");
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    }
    return new Store(db, filename, sqliteVersion, migrationBackup);
  } catch (error) {
    db.close();
    throw error;
  }
}

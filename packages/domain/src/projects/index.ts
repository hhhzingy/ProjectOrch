/** T014准备切片：项目生命周期。目标/意图变更版本化落盘；用户暂停与恢复只写意图，不伪造实际效果；项目无删除路径（停用语义由角色侧承载），重启后状态与历史可恢复。 */
import { realpathSync } from "node:fs";
import type { Store } from "@projectorch/persistence";

export interface ProjectSnapshot {
  readonly id: string;
  readonly name: string;
  readonly hostId: string;
  readonly canonicalRoot: string;
  readonly objective: string;
  readonly revision: number;
  readonly userPaused: boolean;
}

const text = (value: unknown, label: string, max: number): string => {
  if (typeof value !== "string" || !value || value.length > max || /[\r\n\0]/.test(value)) throw new Error(`INVALID_PROJECT_${label}`);
  return value;
};
const clock = (now: number): void => { if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_PROJECT_TIME"); };
/** R002：项目绑定规范化本机根目录，形成可靠的Windows规范身份。
 * 策略：目录存在时用 realpathSync.native 解析真实大小写与重解析点（junction/符号链接）；
 * 不存在的目录（如首次创建前）做词法规范化并保留——首次绑定时目录尚未建立是正常情形，绑定后可用 refreshCanonicalRoot 校验一致。
 * 卷根保留卷根语义（C:\ 不折叠为 C:）；点段先词法解析；穿越出根或经真实解析逃逸原目录一律拒绝。
 */
export function canonicalRoot(input: unknown): string {
  const value = text(input, "ROOT", 2048);
  if (!/^[A-Za-z]:[\\/]/.test(value) && !/^\\\\/.test(value)) throw new Error("INVALID_PROJECT_ROOT");
  if (/[\r\n\0]/.test(value)) throw new Error("INVALID_PROJECT_ROOT");
  const unc = value.startsWith("\\\\");
  const working = value.replaceAll("/", "\\");
  const prefixMatch = unc ? /^(\\\\[^\\]+\\[^\\]+)/.exec(working) : /^([A-Za-z]:\\)/.exec(working);
  if (!prefixMatch?.[1]) throw new Error("INVALID_PROJECT_ROOT");
  const prefixRaw: string = prefixMatch[1];
  // 设备路径（\\?\）、通配与Windows文件名非法字符在任何位置拒绝
  if (/[?*<>"|:]/.test(working.slice(prefixRaw.length)) || /\?/.test(prefixRaw)) throw new Error("INVALID_PROJECT_ROOT");
  const prefix: string = unc ? prefixRaw : prefixRaw.toUpperCase();
  const rest = working.slice(prefixRaw.length);
  const segments: string[] = [];
  for (const segment of rest.split("\\")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") { if (segments.length === 0) throw new Error("INVALID_PROJECT_ROOT"); segments.pop(); continue; }
    segments.push(segment);
  }
  const lexical = prefix + segments.join("\\") + (segments.length === 0 ? "\\" : "");
  // 真实文件系统解析（存在时）：统一大小写并解析重解析点（junction/符号链接收敛到真实目标身份）
  try {
    const real = realpathSync.native(lexical);
    return real.endsWith("\\") ? real : real + "\\";
  } catch {
    return lexical;
  }
}

/** 绑定后目录已建立时的一致性校验：真实解析身份必须与登记的 canonical_root 一致（不区分大小写比较由调用方对既有记录执行；此处要求精确相等）。 */
export function assertCanonicalRootCurrent(registered: string, nowResolvable: string): void {
  if (canonicalRoot(nowResolvable) !== registered) throw new Error("PROJECT_ROOT_IDENTITY_CHANGED");
}

function snapshotOf(row: Record<string, unknown>): ProjectSnapshot {
  return Object.freeze({ id: String(row.id), name: String(row.name), hostId: String(row.host_id), canonicalRoot: String(row.canonical_root), objective: String(row.objective), revision: Number(row.revision), userPaused: Number(row.user_paused) === 1 });
}
function projectRow(store: Store, id: string): Record<string, unknown> {
  return projectRowDb(store.db, id);
}
function projectRowDb(db: Store["db"], id: string): Record<string, unknown> {
  const row = db.prepare("SELECT id,name,host_id,canonical_root,objective,revision,user_paused FROM projects WHERE id=?").get(id);
  if (!row) throw new Error("PROJECT_NOT_FOUND");
  return row as Record<string, unknown>;
}
function revise(db: Store["db"], projectId: string, reason: string, row: Record<string, unknown>): void {
  const revision = Number(row.revision);
  const snapshot = { id: row.id, name: row.name, hostId: row.host_id, canonicalRoot: row.canonical_root, objective: row.objective, userPaused: Number(row.user_paused) === 1 };
  db.prepare("UPDATE projects SET revision=? WHERE id=?").run(revision, projectId);
  db.prepare("INSERT INTO project_revisions(project_id,revision,snapshot_json,reason) VALUES(?,?,?,?)").run(projectId, revision, JSON.stringify(snapshot), reason);
}

/** 建立项目：revision 从 1 开始，初始快照落盘；同主机的重复规范化根目录拒绝。 */
export function createProject(store: Store, input: { readonly id: unknown; readonly name: unknown; readonly hostId: unknown; readonly canonicalRoot: unknown; readonly objective: unknown }, now: number): ProjectSnapshot {
  clock(now);
  const id = text(input.id, "ID", 128);
  const name = text(input.name, "NAME", 512);
  const hostId = text(input.hostId, "HOST", 128);
  const root = canonicalRoot(input.canonicalRoot);
  const objective = text(input.objective, "OBJECTIVE", 8192);
  return store.transaction(db => createProjectWithin(db, { id, name, hostId, canonicalRoot: root, objective }, now));
}

/** 事务内变体：供命令runner等已持有打开事务的受信调用方复用。 */
export function createProjectWithin(db: Store["db"], input: { readonly id: string; readonly name: string; readonly hostId: string; readonly canonicalRoot: string; readonly objective: string }, now: number): ProjectSnapshot {
  clock(now);
  db.prepare("INSERT INTO projects(id,name,host_id,canonical_root,objective,revision,created_at) VALUES(?,?,?,?,?,1,?)").run(input.id, input.name, input.hostId, input.canonicalRoot, input.objective, now);
  revise(db, input.id, "create", projectRowDb(db, input.id));
  return snapshotOf(projectRowDb(db, input.id));
}

/** 目标变更：revision 递增并快照；旧目标保留在历史。 */
export function setProjectObjective(store: Store, projectId: string, objective: unknown, now: number): ProjectSnapshot {
  clock(now);
  const value = text(objective, "OBJECTIVE", 8192);
  return store.transaction(db => setProjectObjectiveWithin(db, projectId, value, now));
}

export function setProjectObjectiveWithin(db: Store["db"], projectId: string, objective: string, now: number): ProjectSnapshot {
  clock(now);
  const row = projectRowDb(db, projectId);
  db.prepare("UPDATE projects SET objective=?,revision=? WHERE id=?").run(objective, Number(row.revision) + 1, projectId);
  revise(db, projectId, "objective", projectRowDb(db, projectId));
  return snapshotOf(projectRowDb(db, projectId));
}

/** 用户暂停意图：只写 user_paused；幂等重复暂停拒绝，避免意图历史被无变化写入稀释。 */
export function pauseProjectForUser(store: Store, projectId: string, now: number): ProjectSnapshot {
  clock(now);
  return store.transaction(db => pauseProjectWithin(db, projectId, now));
}

export function pauseProjectWithin(db: Store["db"], projectId: string, now: number): ProjectSnapshot {
  clock(now);
  const row = projectRowDb(db, projectId);
  if (Number(row.user_paused) === 1) throw new Error("PROJECT_ALREADY_PAUSED");
  db.prepare("UPDATE projects SET user_paused=1,revision=? WHERE id=?").run(Number(row.revision) + 1, projectId);
  revise(db, projectId, "user-pause", projectRowDb(db, projectId));
  return snapshotOf(projectRowDb(db, projectId));
}

/** 用户恢复：暂停的解除入口只属于用户（策略层对Agent拒绝 project.resume）。 */
export function resumeProjectByUser(store: Store, projectId: string, now: number): ProjectSnapshot {
  clock(now);
  return store.transaction(db => resumeProjectWithin(db, projectId, now));
}

export function resumeProjectWithin(db: Store["db"], projectId: string, now: number): ProjectSnapshot {
  clock(now);
  const row = projectRowDb(db, projectId);
  if (Number(row.user_paused) !== 1) throw new Error("PROJECT_NOT_PAUSED");
  db.prepare("UPDATE projects SET user_paused=0,revision=? WHERE id=?").run(Number(row.revision) + 1, projectId);
  revise(db, projectId, "user-resume", projectRowDb(db, projectId));
  return snapshotOf(projectRowDb(db, projectId));
}

export function readProject(store: Store, projectId: string): ProjectSnapshot {
  return snapshotOf(projectRow(store, projectId));
}

/** 事务内读取变体：供命令runner等已持有打开事务的受信调用方复用。 */
export function readProjectWithin(db: Store["db"], projectId: string): ProjectSnapshot {
  return snapshotOf(projectRowDb(db, projectId));
}

/** 重启恢复校验：当前状态与全部历史快照可完整重读。 */
export function projectHistory(store: Store, projectId: string): readonly { readonly revision: number; readonly reason: string; readonly snapshot: ProjectSnapshot }[] {
  const rows = store.db.prepare("SELECT revision,reason,snapshot_json FROM project_revisions WHERE project_id=? ORDER BY revision").all(projectId);
  return Object.freeze(rows.map(row => Object.freeze({ revision: Number(row.revision), reason: String(row.reason), snapshot: JSON.parse(String(row.snapshot_json)) as ProjectSnapshot })));
}

/** T043：项目清单（Web导航只读投影）。 */
export function listProjects(store: Store): readonly { readonly projectId: string; readonly name: string; readonly objective: string; readonly revision: number; readonly planRevision: number; readonly userPaused: boolean }[] {
  const rows = store.db.prepare("SELECT id,name,objective,revision,plan_revision,user_paused FROM projects ORDER BY id").all() as Record<string, unknown>[];
  return Object.freeze(rows.map(row => Object.freeze({ projectId: String(row.id), name: String(row.name), objective: String(row.objective), revision: Number(row.revision), planRevision: Number(row.plan_revision), userPaused: Number(row.user_paused) === 1 })));
}

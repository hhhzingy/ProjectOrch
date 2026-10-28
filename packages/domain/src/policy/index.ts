/** T013准备切片：项目/动作授权策略核心。纯函数，无存储依赖；授权范围不可自扩大，用户暂停对Agent写动作生效，用户保留动作不可被角色档案获得。 */

/** docs/16：用户控制入口不进入普通Agent工具集合；角色档案请求这些动作一律拒绝。 */
export const USER_RESERVED_ACTIONS: readonly string[] = ["pairing.exchange", "project.create_user", "role.bootstrap", "policy.configure", "check.register", "project.pause", "project.resume", "native.input", "native.stop", "native.approve_user"];

export interface PermissionProfile {
  readonly id: string;
  readonly revision: number;
  readonly actions: readonly string[];
  readonly readPaths: readonly string[];
  readonly writePaths: readonly string[];
  readonly roleIds: readonly string[];
  readonly delegableActions: readonly string[];
  readonly maxDelegationDepth: number;
}

export type Principal =
  | { readonly kind: "local_user" }
  | { readonly kind: "bound_agent"; readonly projectId: string; readonly roleId: string; readonly profile: PermissionProfile; readonly roleDesiredState: "enabled" | "paused" | "disabled"; readonly delegationDepth: number };

export interface ActionRequest {
  readonly action: string;
  readonly targetProjectId: string;
  /** 调用方按合同路由语义声明；内核是声明的唯一来源，策略只消费。 */
  readonly kind: "read" | "write" | "control";
  readonly path?: string;
}

export interface ProjectState {
  readonly userPaused: boolean;
}

export type DenialReason = "UNKNOWN_ACTION" | "USER_RESERVED" | "PROJECT_ISOLATION" | "ROLE_NOT_ENABLED" | "ACTION_NOT_GRANTED" | "PATH_OUT_OF_SCOPE" | "PROJECT_PAUSED" | "DELEGATION_DEPTH_EXCEEDED";

export type Decision =
  | { readonly allowed: true; readonly profileId: string; readonly profileRevision: number }
  | { readonly allowed: false; readonly reason: DenialReason };

const reserved = new Set(USER_RESERVED_ACTIONS);
const nameList = (values: unknown, limit: number, label: string): readonly string[] => {
  if (!Array.isArray(values) || values.length > limit) throw new Error(`POLICY_PROFILE_INVALID_${label.toUpperCase()}`);
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !value || value.length > 128 || /\s/.test(value) || out.includes(value)) throw new Error(`POLICY_PROFILE_INVALID_${label.toUpperCase()}`);
    out.push(value);
  }
  return out;
};
const pathList = (values: unknown): readonly string[] => {
  if (!Array.isArray(values) || values.length > 128) throw new Error("POLICY_PROFILE_INVALID_PATHS");
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !isWellFormedPathTemplate(value) || out.includes(value)) throw new Error("POLICY_PROFILE_INVALID_PATHS");
    out.push(value);
  }
  return out;
};

/** 授权与目标共用的单一相对路径语法：正斜杠分隔、非空段、禁止点段/反斜杠/绝对/盘符/UNC/设备名。 */
export function isWellFormedRelativePath(value: string): boolean {
  return isPathSyntax(value, false);
}
/** 已知Harness/内核运行凭据目录不作为成果内容；只按路径拒绝，不读取或猜测秘密值。 */
export function isRuntimeMetadataPath(value:string):boolean{
 const segments=value.replaceAll('\\','/').toLowerCase().split('/');return segments.some(part=>['.zcode','.codex'].includes(part))||['binding-credentials.json','control-entry.json'].includes(segments.at(-1)??'');
}
/** 授权模板语法：在目标语法之上允许整段"*"通配；点段/反斜杠/绝对形态仍然拒绝。 */
export function isWellFormedPathTemplate(value: string): boolean {
  return isPathSyntax(value, true);
}
function isPathSyntax(value: string, allowSegmentWildcard: boolean): boolean {
  if (!value || value.length > 2048 || /[\r\n\0\\]/.test(value)) return false;
  if (value.startsWith("/") || value.includes("//")) return false;
  if (/^[a-zA-Z]:/.test(value) || value.startsWith("~")) return false;
  for (const segment of value.split("/")) {
    if (!segment || segment === "." || segment === "..") return false;
    if (segment === "*" && allowSegmentWildcard) continue;
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(segment)) return false;
    if (/[:*?"<>|]/.test(segment)) return false;
  }
  return true;
}

/** 结构校验并冻结角色权限档案；含用户保留动作的档案直接拒绝（授权范围不可自扩大）。 */
export function parsePermissionProfile(input: unknown): PermissionProfile {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("POLICY_PROFILE_INVALID_TYPE");
  const raw = input as Record<string, unknown>;
  const id = raw.id;
  const revision = raw.revision;
  if (typeof id !== "string" || !id || id.length > 128) throw new Error("POLICY_PROFILE_INVALID_ID");
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) throw new Error("POLICY_PROFILE_INVALID_REVISION");
  const actions = nameList(raw.actions, 128, "actions");
  for (const action of actions) if (reserved.has(action)) throw new Error("POLICY_PROFILE_USER_RESERVED");
  const delegableActions = nameList(raw.delegableActions, 128, "delegable");
  for (const action of delegableActions) {
    if (reserved.has(action)) throw new Error("POLICY_PROFILE_USER_RESERVED");
    if (!actions.includes(action)) throw new Error("POLICY_PROFILE_DELEGATION_NOT_HELD");
  }
  const maxDelegationDepth = raw.maxDelegationDepth;
  if (typeof maxDelegationDepth !== "number" || !Number.isSafeInteger(maxDelegationDepth) || maxDelegationDepth < 0 || maxDelegationDepth > 16) throw new Error("POLICY_PROFILE_INVALID_DEPTH");
  return Object.freeze({ id, revision, actions, readPaths: pathList(raw.readPaths), writePaths: pathList(raw.writePaths), roleIds: nameList(raw.roleIds, 128, "roleIds"), delegableActions, maxDelegationDepth });
}

/** 段级通配（单段"*"）；目标路径必须先通过 isWellFormedRelativePath，否则一律不匹配。 */
export function pathMatches(patterns: readonly string[], path: string | undefined): boolean {
  if (path === undefined) return true;
  if (typeof path !== "string" || !isWellFormedRelativePath(path)) return false;
  const segments = path.split("/");
  for (const pattern of patterns) {
    const parts = pattern.split("/");
    if (parts.length !== segments.length) continue;
    let matched = true;
    for (let i = 0; i < parts.length; i++) if (parts[i] !== "*" && parts[i] !== segments[i]) { matched = false; break; }
    if (matched) return true;
  }
  return false;
}

/** 决策顺序：主体合法 → 动作合法 → 用户保留 → 角色状态 → 项目隔离 → 暂停 → 档案授权 → 路径范围。用户主体不受项目暂停限制（暂停的解除入口本身是用户动作）。 */
export function authorize(principal: Principal, request: ActionRequest, project: ProjectState): Decision {
  if (!principal || typeof principal !== "object" || !["local_user", "bound_agent"].includes(principal.kind)) throw new Error("POLICY_PRINCIPAL_INVALID");
  if (principal.kind === "bound_agent" && (typeof principal.projectId !== "string" || !principal.projectId || typeof principal.roleId !== "string" || !principal.roleId || !principal.profile || !["enabled", "paused", "disabled"].includes(principal.roleDesiredState))) throw new Error("POLICY_PRINCIPAL_INVALID");
  if (!project || typeof project !== "object" || typeof project.userPaused !== "boolean") throw new Error("POLICY_PRINCIPAL_INVALID");
  if (!request || typeof request.action !== "string" || !request.action || !["read", "write", "control"].includes(request.kind) || typeof request.targetProjectId !== "string" || !request.targetProjectId) return { allowed: false, reason: "UNKNOWN_ACTION" };
  if (principal.kind === "local_user") return { allowed: true, profileId: "local_user", profileRevision: 0 };
  if (reserved.has(request.action)) return { allowed: false, reason: "USER_RESERVED" };
  if (principal.roleDesiredState !== "enabled") return { allowed: false, reason: "ROLE_NOT_ENABLED" };
  if (principal.projectId !== request.targetProjectId) return { allowed: false, reason: "PROJECT_ISOLATION" };
  if (project.userPaused && request.kind !== "read") return { allowed: false, reason: "PROJECT_PAUSED" };
  if (!principal.profile.actions.includes(request.action)) return { allowed: false, reason: "ACTION_NOT_GRANTED" };
  if (request.path !== undefined && !pathMatches(request.kind === "read" ? principal.profile.readPaths : principal.profile.writePaths, request.path)) return { allowed: false, reason: "PATH_OUT_OF_SCOPE" };
  return { allowed: true, profileId: principal.profile.id, profileRevision: principal.profile.revision };
}

export type GrantValidation = { readonly valid: true } | { readonly valid: false; readonly reason: DenialReason };

/** 模板包含：子模板匹配的每个具体路径都必须落在父模板范围内（父段"*"覆盖任意子段；父段字面量必须与子段一致；子段"*"宽于父段字面量则拒绝）。 */
export function templateInside(parent: readonly string[], child: readonly string[]): boolean {
  for (const childPattern of child) {
    let covered = false;
    for (const parentPattern of parent) {
      const parentSegments = parentPattern.split("/");
      const childSegments = childPattern.split("/");
      if (parentSegments.length !== childSegments.length) continue;
      let ok = true;
      for (let i = 0; i < parentSegments.length; i++) {
        if (parentSegments[i] === "*") continue;
        if (childSegments[i] === "*" || parentSegments[i] !== childSegments[i]) { ok = false; break; }
      }
      if (ok) { covered = true; break; }
    }
    if (!covered) return false;
  }
  return true;
}

/** 子档案不得超出父档案可委派集合，路径与再委派范围同样收窄；用户保留动作永不进入委派链。 */
export function validateGrant(parent: PermissionProfile, child: PermissionProfile, childDepth: number): GrantValidation {
  if (!Number.isSafeInteger(childDepth) || childDepth < 0) return { valid: false, reason: "DELEGATION_DEPTH_EXCEEDED" };
  if (childDepth > parent.maxDelegationDepth) return { valid: false, reason: "DELEGATION_DEPTH_EXCEEDED" };
  for (const action of child.actions) {
    if (reserved.has(action)) return { valid: false, reason: "USER_RESERVED" };
    if (!parent.delegableActions.includes(action)) return { valid: false, reason: "ACTION_NOT_GRANTED" };
  }
  for (const path of child.readPaths) if (!templateInside(parent.readPaths, [path])) return { valid: false, reason: "PATH_OUT_OF_SCOPE" };
  for (const path of child.writePaths) if (!templateInside(parent.writePaths, [path])) return { valid: false, reason: "PATH_OUT_OF_SCOPE" };
  for (const action of child.delegableActions) if (!child.actions.includes(action) || !parent.delegableActions.includes(action)) return { valid: false, reason: "ACTION_NOT_GRANTED" };
  if (child.maxDelegationDepth > parent.maxDelegationDepth - childDepth) return { valid: false, reason: "DELEGATION_DEPTH_EXCEEDED" };
  return { valid: true };
}

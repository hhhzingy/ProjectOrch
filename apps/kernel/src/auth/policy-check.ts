/** 持久策略适配：逐调用读取角色/绑定/项目及当前权限档案；可选缓存快照只作一致性约束，不授予权限。 */
import type { Store } from "@projectorch/persistence";
import { authorize, parsePermissionProfile, type ActionRequest, type Decision, type PermissionProfile, type Principal } from "@projectorch/domain/policy";
import type { AgentPrincipal } from "./agent-credential.js";
import { readProjectPolicy } from "./project-policy.js";
import { canonicalJson } from "@projectorch/persistence/outbox";
import { pathMatches } from "@projectorch/domain/policy";

export interface AgentSubjectState {
  readonly roleDesiredState: "enabled" | "paused" | "disabled";
  readonly projectUserPaused: boolean;
  readonly bindingState: string;
}

/** 仅核对主体当前仍然成立：有效绑定、代次一致、角色与项目仍存在。不解析档案。 */
export function loadAgentSubjectState(store: Store, principal: AgentPrincipal, now: number): AgentSubjectState {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("POLICY_CHECK_INVALID_TIME");
  const row = store.db.prepare(`SELECT r.desired_state AS roleState, r.binding_state AS bindingState, p.user_paused AS paused
    FROM role_bindings b
    JOIN roles r ON r.id=b.role_id AND r.project_id=b.project_id
    JOIN projects p ON p.id=b.project_id
    WHERE b.id=? AND b.project_id=? AND b.epoch=? AND b.ended_at IS NULL AND b.role_id=?`).get(principal.bindingId, principal.projectId, principal.bindingEpoch, principal.roleId);
  if (!row) throw new Error("POLICY_SUBJECT_NOT_ACTIVE");
  const roleState = String(row.roleState);
  if (!["enabled", "paused", "disabled"].includes(roleState)) throw new Error("POLICY_SUBJECT_INVALID_STATE");
  return Object.freeze({ roleDesiredState: roleState as AgentSubjectState["roleDesiredState"], projectUserPaused: Number(row.paused) === 1, bindingState: String(row.bindingState) });
}

/** Agent动作决策：主体状态与项目暂停在决策时点重读，防止颁发后状态漂移。 */
export function authorizeAgentAction(store: Store, principal: AgentPrincipal, profileInput: unknown, request: ActionRequest, now: number): Decision {
  const state = loadAgentSubjectState(store, principal, now);
  const snapshot = profileInput === undefined ? undefined : parsePermissionProfile(profileInput);
  const role = store.db.prepare("SELECT permission_profile,permission_profile_revision,scope_paths_json FROM roles WHERE id=? AND project_id=?").get(principal.roleId, principal.projectId);
  if (!role) throw new Error("POLICY_SUBJECT_NOT_ACTIVE");
  const policy = readProjectPolicy(store.db, principal.projectId);
  const definition = policy.profiles.find(entry => entry.id === role.permission_profile && entry.revision === role.permission_profile_revision);
  if (!definition) return { allowed: false, reason: "ACTION_NOT_GRANTED" };
  const profile: PermissionProfile = parsePermissionProfile(definition);
  if (state.bindingState !== "ready" && !["identity", "project.read", "role.read", "task.read", "policy.read", "role.startup_ack"].includes(request.action)) return { allowed: false, reason: "ACTION_NOT_GRANTED" };
  if (snapshot !== undefined && canonicalJson(snapshot) !== canonicalJson(profile)) return { allowed: false, reason: "ACTION_NOT_GRANTED" };
  if (profile.roleIds.length !== 0 && !profile.roleIds.includes(principal.roleId)) return { allowed: false, reason: "ACTION_NOT_GRANTED" };
  const scopes: unknown = JSON.parse(String(role.scope_paths_json));
  if (!Array.isArray(scopes) || scopes.some(path => typeof path !== "string")) throw new Error("POLICY_ROLE_SCOPE_INVALID");
  if (request.path !== undefined && scopes.length > 0 && !pathMatches(scopes, request.path)) return { allowed: false, reason: "PATH_OUT_OF_SCOPE" };
  const subject: Principal = { kind: "bound_agent", projectId: principal.projectId, roleId: principal.roleId, profile, roleDesiredState: state.roleDesiredState, delegationDepth: 0 };
  return authorize(subject, request, { userPaused: state.projectUserPaused });
}

/** 用户动作决策：本机用户不受项目暂停限制；传输层认证由HTTP防护层负责，此函数不做会话判断。 */
export function authorizeUserAction(request: ActionRequest): Decision {
  return authorize({ kind: "local_user" }, request, { userPaused: false });
}

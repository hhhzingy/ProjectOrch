/** DR05（PR2修复第二段）：现有对话接纳（Adopt Existing Conversation）。
 * 用户已有的发起对话（Codex线程/ZCode会话）经控制主体授权被登记为项目负责人：
 * - 保留原生来源标识（SessionRef——已有对话的原生ID），不建替代会话
 * - 接纳后=项目负责人（lead角色绑定至该原生会话，走启动握手后才调度）
 * - 可信授权：控制主体须已配对且声明发起来源（原生ID来自控制主体的受信登记，非模型自报） */
import { createHash, randomUUID } from "node:crypto";
import type { Store } from "@projectorch/persistence";
import type { SessionRef } from "@projectorch/adapter-contract";
import { parseSessionRef } from "@projectorch/adapter-contract";
import type { ControlPrincipal } from "../auth/control-entry.js";

export interface AdoptInput {
  readonly projectId: string;
  readonly roleId: string; // 负责人角色（已存在或同操作创建）
  readonly nativeSession: SessionRef; // 已有对话的原生标识（受信登记——控制主体侧获得，非模型正文）
  readonly principal: ControlPrincipal;
}

export interface AdoptResult {
  readonly adopted: boolean;
  readonly leadRole: string;
  readonly nativeConversationId: string;
  readonly bindingId: string;
  readonly startupAckRequired: boolean;
}

/** 接纳：lead角色绑定到已有原生会话（不建替代）。幂等（同会话重复接纳返回同一绑定）。
 * 接纳后binding_state=provisioning——必须走既有completeStartupAck握手才可调度（章程不是鉴权）。 */
export function adoptExistingConversation(store: Store, input: AdoptInput, now: number): AdoptResult {
  const session = parseSessionRef(input.nativeSession);
  if (!["codex", "zcode"].includes(session.harnessId)) throw new Error("ADOPT_HARNESS_UNSUPPORTED");
  if (input.principal.projectId !== null && input.principal.projectId !== input.projectId) throw new Error("ADOPT_PROJECT_MISMATCH");
  return store.transaction(db => {
    // 角色（lead）必须已存在（由bootstrap或项目创建流程建立——接纳不做角色创建）
    const role = db.prepare("SELECT id,binding_state,desired_state FROM roles WHERE id=? AND project_id=?").get(input.roleId, input.projectId) as { id: string; binding_state: string; desired_state: string } | undefined;
    if (!role) throw new Error("ADOPT_ROLE_NOT_FOUND");
    if (role.desired_state !== "enabled") throw new Error("ADOPT_ROLE_NOT_ENABLED");
    // 幂等：该角色已有活跃绑定且绑定到同一原生会话→返回既有
    const existing = db.prepare("SELECT b.id,b.epoch,s.harness_id,s.host_id,s.profile_id,s.native_conversation_id,s.native_workspace_id FROM role_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.project_id=? AND b.role_id=? AND b.ended_at IS NULL").get(input.projectId, input.roleId);
    if (existing && existing.harness_id===session.harnessId && existing.host_id===session.hostId && existing.profile_id===session.profileId && existing.native_conversation_id===session.nativeConversationId && String(existing.native_workspace_id??'')===(session.nativeWorkspaceId??'')) {
      return { adopted: true, leadRole: input.roleId, nativeConversationId: session.nativeConversationId, bindingId: String(existing.id), startupAckRequired: role.binding_state !== "ready" };
    }
    if (existing) throw new Error("ADOPT_ROLE_ALREADY_BOUND_TO_OTHER_SESSION"); // 不同会话=需先接替（succeedBinding），不走接纳
    // 会话登记（原生ID来自受信登记）
    const sessionId = `sess-adopt-${randomUUID().slice(0, 12)}`;
    // verified_origin=0：控制主体声明的原生ID未经内核侧确认——虚构ID同样可登记，但保持受限：
    // startup_ack 拒绝ready，直到真实原生交互（resume回执匹配该会话）完成核验（markNativeSessionVerified）。
    db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id,native_workspace_id,verified_origin) VALUES(?,?,?,?,?,?,0)").run(sessionId, session.harnessId, session.hostId, session.profileId, session.nativeConversationId,session.nativeWorkspaceId??'');
    const bindingId = `bnd-adopt-${randomUUID().slice(0, 12)}`;
    db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES(?,?,?,?,1,?)").run(bindingId, input.projectId, input.roleId, sessionId, now);
    db.prepare("UPDATE roles SET binding_state='provisioning' WHERE id=? AND project_id=? AND binding_state='unbound'").run(input.roleId, input.projectId);
    // 首次显式接纳负责人登记初始角色；四个后续角色额度不把原负责人重复计为动态角色。
    if(!db.prepare('SELECT 1 FROM project_bootstrap WHERE project_id=?').get(input.projectId))db.prepare("INSERT INTO project_bootstrap(project_id,role_id,principal_id,request_id,state) VALUES(?,?,?,?,'provisioning')").run(input.projectId,input.roleId,input.principal.principalId,`adopt-${bindingId}`);
    // 审计事件
    db.prepare("INSERT INTO events(id,project_id,type,entity_id,entity_revision,causation_id,body_json,occurred_at) VALUES(?,?,?,?,1,?,?,?)").run(randomUUID(), input.projectId, "conversation.adopted", bindingId, bindingId, JSON.stringify({ roleId: input.roleId, harnessId: session.harnessId, nativeConversationId: session.nativeConversationId, principal: input.principal.principalId, note: "已有对话接纳为负责人——保留原生ID，未建替代会话" }), now);
    return { adopted: true, leadRole: input.roleId, nativeConversationId: session.nativeConversationId, bindingId, startupAckRequired: true, nativeVerificationRequired: true };
  });
}

/** 查询接纳状态（监督用） */
export function readAdoption(store: Store, projectId: string, roleId: string): { readonly adopted: boolean; readonly nativeConversationId: string | null; readonly bindingState: string | null } {
  const row = store.db.prepare("SELECT r.binding_state, s.native_conversation_id FROM roles r LEFT JOIN role_bindings b ON b.role_id=r.id AND b.project_id=r.project_id AND b.ended_at IS NULL LEFT JOIN sessions s ON s.id=b.session_id WHERE r.id=? AND r.project_id=?").get(roleId, projectId) as { binding_state: string; native_conversation_id: string | null } | undefined;
  if (!row) throw new Error("ADOPT_ROLE_NOT_FOUND");
  return { adopted: row.native_conversation_id !== null, nativeConversationId: row.native_conversation_id === null ? null : String(row.native_conversation_id), bindingState: String(row.binding_state) };
}

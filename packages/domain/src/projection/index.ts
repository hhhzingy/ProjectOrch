/** T022准备切片：历史投影。从events权威表重放构建各实体投影状态（项目/角色/任务/消息），
 * 并与实际表比对验证——重放结果应与当前状态一致（事件完整性校验，A034/A038域的投影基础）。
 * 事件由受信命令管线写入（T017已实现）；本模块只读。 */
import type { Store } from "@projectorch/persistence";

export interface ProjectProjection {
  readonly skippedUnknown: number;
  readonly projectId: string;
  readonly eventWatermark: number;
  readonly objective: string | null;
  readonly userPaused: boolean | null;
  readonly roleStates: Readonly<Record<string, { readonly desiredState: string; readonly revision: number }>>;
  readonly taskStates: Readonly<Record<string, { readonly state: string; readonly revision: number }>>;
  readonly messageStates: Readonly<Record<string, { readonly state: string; readonly revision: number }>>;
}

/** 重放事件构建投影：project.paused/resumed→项目；role.*与task.*按entityId归类；message状态从消息事件推导。
 * 未知事件类型跳过（前向兼容），但计数报告。 */
export function buildProjection(store: Store, projectId: string, fromSequence = 0): ProjectProjection {
  const rows = store.db.prepare("SELECT sequence,type,entity_id,entity_revision,body_json FROM events WHERE project_id=? AND sequence>? ORDER BY sequence").all(projectId, fromSequence) as { sequence: number; type: string; entity_id: string; entity_revision: number; body_json: string }[];
  let objective: string | null = null;
  let userPaused: boolean | null = null;
  let watermark = fromSequence;
  let skippedUnknown = 0;
  const roleStates: Record<string, { desiredState: string; revision: number }> = {};
  const taskStates: Record<string, { state: string; revision: number }> = {};
  const messageStates: Record<string, { state: string; revision: number }> = {};
  for (const row of rows) {
    watermark = Number(row.sequence);
    const body = JSON.parse(String(row.body_json)) as Record<string, unknown>;
    switch (String(row.type)) {
      case "project.paused": objective = typeof body.reason === "string" ? objective : objective; userPaused = true; break;
      case "project.resumed": userPaused = false; break;
      case "role.enabled": case "role.paused": case "role.disabled": {
        const entityId = String(row.entity_id);
        const state = String(row.type).split(".").at(1);
        if (state !== undefined) roleStates[entityId] = { desiredState: state, revision: Number(row.entity_revision) };
        break;
      }
      case "task.ready": case "task.cancelled": case "task.assigned": {
        const entityId = String(row.entity_id);
        const state = String(row.type).split(".").at(1);
        if (state !== undefined) taskStates[entityId] = { state, revision: Number(row.entity_revision) };
        break;
      }
      case "message.delivered": case "message.acknowledged": case "message.resolved": {
        const entityId = String(row.entity_id);
        const state = String(row.type).split(".").at(1);
        if (state !== undefined) messageStates[entityId] = { state, revision: Number(row.entity_revision) };
        break;
      }
      default: skippedUnknown += 1;
    }
  }
  return Object.freeze({ projectId, eventWatermark: watermark, objective, userPaused, roleStates: Object.freeze(roleStates), taskStates: Object.freeze(taskStates), messageStates: Object.freeze(messageStates), skippedUnknown });
}

export interface ProjectionDiff {
  readonly consistent: boolean;
  readonly differences: readonly string[];
}

/** 与实际表比对：投影状态应与当前表状态一致（事件驱动写入的实体）。仅比对事件驱动的字段。 */
export function verifyProjection(store: Store, projectId: string): ProjectionDiff {
  const projection = buildProjection(store, projectId);
  const differences: string[] = [];
  const projectRow = store.db.prepare("SELECT user_paused FROM projects WHERE id=?").get(projectId) as { user_paused: number } | undefined;
  if (!projectRow) throw new Error("PROJECTION_PROJECT_NOT_FOUND");
  if (projection.userPaused !== null && projection.userPaused !== (Number(projectRow.user_paused) === 1)) differences.push(`projects.user_paused: projection=${projection.userPaused}`);
  for (const [roleId, projected] of Object.entries(projection.roleStates)) {
    const row = store.db.prepare("SELECT desired_state,revision FROM roles WHERE id=? AND project_id=?").get(roleId, projectId) as { desired_state: string; revision: number } | undefined;
    if (!row) differences.push(`roles.${roleId}: 实体已不存在`);
    else if (row.desired_state !== projected.desiredState) differences.push(`roles.${roleId}.desired_state: projection=${projected.desiredState} actual=${row.desired_state}`);
  }
  for (const [taskId, projected] of Object.entries(projection.taskStates)) {
    const row = store.db.prepare("SELECT state FROM tasks WHERE id=? AND project_id=?").get(taskId, projectId) as { state: string } | undefined;
    if (!row) differences.push(`tasks.${taskId}: 实体已不存在`);
    else if (row.state !== projected.state) differences.push(`tasks.${taskId}.state: projection=${projected.state} actual=${row.state}`);
  }
  for (const [messageId, projected] of Object.entries(projection.messageStates)) {
    const row = store.db.prepare("SELECT state FROM messages WHERE id=? AND project_id=?").get(messageId, projectId) as { state: string } | undefined;
    if (!row) differences.push(`messages.${messageId}: 实体已不存在`);
    else if (row.state !== projected.state) differences.push(`messages.${messageId}.state: projection=${projected.state} actual=${row.state}`);
  }
  return Object.freeze({ consistent: differences.length === 0, differences: Object.freeze(differences) });
}

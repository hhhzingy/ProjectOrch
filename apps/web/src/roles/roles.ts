/** T043：角色状态视图（纯逻辑）。期望(desired)与观测(binding)状态分开展示；
 * 状态以文本+符号双编码表达（不以颜色独立表达）；停用角色保留在列且历史可查。 */

export interface RoleRow {
  readonly roleId: string;
  readonly name: string;
  readonly desiredState: string;
  readonly bindingState: string;
}

/** 期望与观测分列——不做合并推断；观测值未就绪明确标示而非猜测。 */
export function roleDisplayRows(roles: readonly RoleRow[]): readonly { readonly roleId: string; readonly label: string; readonly desiredText: string; readonly observedText: string; readonly glyph: string }[] {
  return roles.map(role => {
    const desiredText = DESIRED_TEXT[role.desiredState] ?? role.desiredState;
    const observedText = OBSERVED_TEXT[role.bindingState] ?? role.bindingState;
    return { roleId: role.roleId, label: `${role.name} (${role.roleId})`, desiredText, observedText, glyph: OBSERVED_GLYPH[role.bindingState] ?? "○" };
  });
}

/** 停用/暂停角色历史仍可查：历史行文本人输出（不用颜色承载语义）。 */
export function historyDisplayRows(history: readonly { readonly revision: number; readonly snapshot: { readonly desiredState: string; readonly bindingState: string } }[]): readonly { readonly revision: number; readonly text: string }[] {
  return history.map(entry => ({
    revision: entry.revision,
    text: `#${entry.revision} 期望=${DESIRED_TEXT[entry.snapshot.desiredState] ?? entry.snapshot.desiredState} 观测=${OBSERVED_TEXT[entry.snapshot.bindingState] ?? entry.snapshot.bindingState}`,
  }));
}

const DESIRED_TEXT: Record<string, string> = { enabled: "启用（期望）", paused: "暂停（期望）", disabled: "停用（期望）" };
const OBSERVED_TEXT: Record<string, string> = { unbound: "未绑定（观测）", provisioning: "接入中（观测）", ready: "就绪（观测）", error: "异常（观测）" };
const OBSERVED_GLYPH: Record<string, string> = { unbound: "○", provisioning: "◔", ready: "●", error: "✗" };

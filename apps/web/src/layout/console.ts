/** 三栏导航控制器：唯一状态所有者，异步响应必须仍匹配当前选择代次。 */
import { api, type ProjectSummary } from "../api.js";
import { initialState, selectProject, selectRole, withProjects, withRoles, type ProjectNavState } from "../projects/projects.js";
import { historyDisplayRows, roleDisplayRows } from "../roles/roles.js";
import {mountConversation} from '../roles/conversation.js';
export interface Dom {
  readonly storage: Storage;
  readonly projectList: HTMLElement;
  readonly roleList: HTMLElement;
  readonly roleDetail: HTMLElement;
  readonly connectionStatus: HTMLElement;
  readonly scopeHeading: HTMLElement;
}
interface Env { readonly storage: Storage; readonly document: Document; readonly location: Location; readonly onProjectSelected?: (projectId: string | null) => void }
const mounts = new WeakMap<HTMLElement, symbol>();
export async function mountConsole(dom: Dom, env: Env): Promise<void> {
  const mount = Symbol(); mounts.set(dom.projectList, mount);
  const active = () => mounts.get(dom.projectList) === mount;
  let state = initialState(dom.storage);
  let generation = 0;
  let notifiedProject: string | null | undefined;
  const render = () => {
    if (!active()) return;
    renderAll(dom, state, env, next => { if (active()) { state = next; void refresh(); } });
    if (notifiedProject !== state.selection.projectId) { notifiedProject = state.selection.projectId; env.onProjectSelected?.(notifiedProject); }
  };
  const refresh = async () => {
    const epoch = ++generation;
    const projectId = state.selection.projectId;
    dom.roleDetail.replaceChildren();
    render();
    if (projectId === null) return;
    try {
      const roles = (await api.roles(projectId)).roles;
      if (!active() || epoch !== generation || state.selection.projectId !== projectId) return;
      state = withRoles(state, projectId, roles);
      render();
      if (state.selection.roleId !== null) {
        const roleId = state.selection.roleId;
        await renderRoleDetail(dom, state, () => active() && epoch === generation && state.selection.projectId === projectId && state.selection.roleId === roleId);
      }
    } catch { if (active() && epoch === generation) dom.connectionStatus.textContent = "○ 加载失败，请刷新重试"; }
  };
  render();
  try {
    await api.session();
    if (!active()) return;
    dom.connectionStatus.textContent = "◉ 已连接本机";
    const projects = (await api.projects()).projects;
    if (!active()) return;
    state = withProjects(state, projects, dom.storage);
    await refresh();
  } catch {
    if (active()) dom.connectionStatus.textContent = "○ 未连接（配对后可用）";
  }
}
export function renderAll(dom: Dom, state: ProjectNavState, env: Env, onSelect: (next: ProjectNavState) => void): void {
  dom.projectList.replaceChildren(...state.projects.map(project => {
    const item = env.document.createElement("button"); item.type = "button";
    item.className = project.projectId === state.selection.projectId ? "nav-item selected" : "nav-item";
    item.textContent = `${project.name}${project.userPaused ? " [已暂停]" : ""}`;
    item.addEventListener("click", () => onSelect(selectProject(state, project.projectId, dom.storage)));
    return item;
  }));
  const projectId = state.selection.projectId;
  const roles = projectId === null ? [] : state.rolesByProject[projectId] ?? [];
  dom.scopeHeading.textContent = `角色 — 项目 ${state.projects.find(p => p.projectId === projectId)?.name ?? "（未选择项目）"}`;
  dom.roleList.replaceChildren(...roleDisplayRows(roles).map(row => {
    const item = env.document.createElement("button"); item.type = "button";
    item.className = row.roleId === state.selection.roleId ? "nav-item selected" : "nav-item";
    item.textContent = `${row.glyph} ${row.label}`;
    const desired = env.document.createElement("span"); desired.className = "state-desired"; desired.textContent = ` 期望:${row.desiredText}`;
    const observed = env.document.createElement("span"); observed.className = "state-observed"; observed.textContent = ` 绑定:${row.observedText}`;
    item.append(desired, observed);
    item.addEventListener("click", () => onSelect(selectRole(state, row.roleId, dom.storage)));
    return item;
  }));
}
export async function renderRoleDetail(dom: Dom, state: ProjectNavState, isCurrent: () => boolean = () => true): Promise<void> {
  const { projectId, roleId } = state.selection;
  if (projectId === null || roleId === null) { dom.roleDetail.replaceChildren(); return; }
  const history = historyDisplayRows((await api.roleHistory(projectId, roleId)).history);
  if (!isCurrent()) return;
  const heading = dom.roleDetail.ownerDocument.createElement("h3"); heading.textContent = "角色状态历史";
  const rows = history.map(entry => { const line = dom.roleDetail.ownerDocument.createElement("div"); line.textContent = entry.text; return line; });
  dom.roleDetail.replaceChildren(heading, ...rows);
  await mountConversation(dom.roleDetail,projectId,roleId,isCurrent);
}
export type { ProjectSummary };

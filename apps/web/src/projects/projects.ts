/** T043：项目导航状态（纯逻辑，DOM解耦——e2e以状态断言驱动）。
 * 选择持久化于localStorage（刷新可恢复）；项目切换即整组换键，数据不串态。 */

export interface Selection {
  readonly projectId: string | null;
  readonly roleId: string | null;
}

export interface ProjectNavState {
  readonly projects: readonly { readonly projectId: string; readonly name: string; readonly userPaused: boolean }[];
  readonly selection: Selection;
  /** 各项目角色数据按projectId分桶——切换项目即换桶，不串态。 */
  readonly rolesByProject: Readonly<Record<string, readonly { readonly roleId: string; readonly name: string; readonly desiredState: string; readonly bindingState: string }[]>>;
}

const SELECTION_KEY = "projectorch.selection";

export function loadPersistedSelection(storage: { getItem(key: string): string | null }): Selection {
  const raw = storage.getItem(SELECTION_KEY);
  if (!raw) return { projectId: null, roleId: null };
  try {
    const parsed = JSON.parse(raw) as { projectId?: string; roleId?: string };
    return { projectId: typeof parsed.projectId === "string" ? parsed.projectId : null, roleId: typeof parsed.roleId === "string" ? parsed.roleId : null };
  } catch {
    return { projectId: null, roleId: null };
  }
}

export function persistSelection(storage: { setItem(key: string, value: string): void }, selection: Selection): void {
  storage.setItem(SELECTION_KEY, JSON.stringify(selection));
}

export function initialState(storage: { getItem(key: string): string | null }): ProjectNavState {
  return { projects: [], selection: loadPersistedSelection(storage), rolesByProject: {} };
}

/** 项目切换：换选择键+清空角色面板数据源（切换后由loadRoles按新projectId填充）。 */
export function selectProject(state: ProjectNavState, projectId: string, storage: { setItem(key: string, value: string): void }): ProjectNavState {
  const selection: Selection = { projectId, roleId: null };
  persistSelection(storage, selection);
  return { ...state, selection };
}

/** 角色切换：同项目内换角色键。 */
export function selectRole(state: ProjectNavState, roleId: string, storage: { setItem(key: string, value: string): void }): ProjectNavState {
  if (state.selection.projectId === null) return state;
  const selection: Selection = { projectId: state.selection.projectId, roleId };
  persistSelection(storage, selection);
  return { ...state, selection };
}

/** 填充项目清单；若持久化选择的项目已不存在（如数据重置），选择失效回退。 */
export function withProjects(state: ProjectNavState, projects: readonly { readonly projectId: string; readonly name: string; readonly userPaused: boolean }[], storage: { setItem(key: string, value: string): void }): ProjectNavState {
  const exists = projects.some(p => p.projectId === state.selection.projectId);
  if (exists) return { ...state, projects };
  const fallback: Selection = { projectId: projects[0]?.projectId ?? null, roleId: null };
  persistSelection(storage, fallback);
  return { ...state, projects, selection: fallback };
}

/** 填充所选项目的角色（按projectId分桶；其他项目桶不受影响——不串态）。 */
export function withRoles(state: ProjectNavState, projectId: string, roles: readonly { readonly roleId: string; readonly name: string; readonly desiredState: string; readonly bindingState: string }[]): ProjectNavState {
  if (state.selection.projectId !== projectId) return state;
  return { ...state, rolesByProject: { ...state.rolesByProject, [projectId]: roles } };
}

/** 本地控制台入口：首次配对、项目创建及三栏导航。凭据仅由Cookie/内存承载。 */
import { api, ApiError } from "./api.js";
import { mountConsole } from "./layout/console.js";
import { mountManagement } from "./management.js";
import {alphaTeamPolicy,alphaTeamPrompt} from './team-template.js';
const get = <T extends HTMLElement>(id: string): T => { const node = document.getElementById(id); if (!node) throw new Error("PAGE_ELEMENT_MISSING"); return node as T; };
const pairPanel = get<HTMLElement>("pair-panel");
const createPanel = get<HTMLElement>("create-panel");
const status = get<HTMLElement>("connection-status");
const feedback = get<HTMLElement>("feedback");
const pairForm = get<HTMLFormElement>("pair-form");
const createForm = get<HTMLFormElement>("create-form");
let hostId = "";
let pendingCreate: { signature: string; requestId: string } | null = null;
const dom = { storage: window.localStorage, projectList: get<HTMLElement>("project-list"), roleList: get<HTMLElement>("role-list"), roleDetail: get<HTMLElement>("role-detail"), connectionStatus: status, scopeHeading: get<HTMLElement>("scope-heading") };
const selectManagementProject = mountManagement(get<HTMLElement>("management-panel"), () => refreshConsole(), text => { feedback.textContent = text; });
const refreshConsole = () => mountConsole(dom, { storage: window.localStorage, document, location: window.location, onProjectSelected: selectManagementProject });
const errorText = (error: unknown): string => {
  if (error instanceof ApiError) {
    if (error.status === 401) return "会话或安全令牌已失效，请重新配对或刷新后重试。";
    if (error.message === "PROJECT_ROOT_OCCUPIED") return "这个目录已登记为项目，请选择已有项目。";
    if (error.message === "IDEMPOTENCY_CONFLICT") return "请求与先前内容不同，请刷新后核对项目列表。";
    if (error.message === "PAIRING_REJECTED") return "配对信息无效、已使用或已过期，请获取新的配对信息。";
    return "操作未成功，请核对输入后重试。";
  }
  return "连接失败。请确认本地服务仍在运行，然后重试。";
};
async function connect(): Promise<void> {
  const session = await api.session();
  hostId = session.hostId;
  await api.refreshCsrf();
  pairPanel.hidden = true; createPanel.hidden = false;
  await refreshConsole();
}
pairForm.addEventListener("submit", event => {
  event.preventDefault();
  const submit = get<HTMLButtonElement>("pair-submit");
  if (submit.disabled) return;
  submit.disabled = true;
  const code = get<HTMLInputElement>("pair-code");
  const value = code.value; code.value = "";
  void (async () => {
    try { await api.pair(get<HTMLInputElement>("pair-id").value.trim(), value); await connect(); feedback.textContent = "已配对，可以创建或选择项目。"; }
    catch (error) { feedback.textContent = errorText(error); }
    finally { submit.disabled = false; }
  })();
});
createForm.addEventListener("submit", event => {
  event.preventDefault();
  const submit = get<HTMLButtonElement>("create-submit");
  if (submit.disabled) return;
  submit.disabled = true;
  const fields = { name: get<HTMLInputElement>("project-name").value.trim(), rootPath: get<HTMLInputElement>("project-root").value.trim(), objective: get<HTMLTextAreaElement>("project-objective").value.trim() };
  const team=get<HTMLSelectElement>('project-template').value==='alpha-three-role';
  if(team&&!get<HTMLInputElement>('team-confirm').checked){feedback.textContent='请先确认三角色职责、目录读写范围及调用额度边界。';submit.disabled=false;return;}
  const signature = JSON.stringify({...fields,team});
  if (pendingCreate?.signature !== signature) pendingCreate = { signature, requestId: crypto.randomUUID() };
  const requestId = pendingCreate.requestId;
  void (async () => {
    try {
      const created = await api.createProject({ schemaVersion: 2, requestId, hostId, ...fields, initialPolicy: team?alphaTeamPolicy():{
        id: "initial-manual", revision: 0, profiles: [{ id: "reader", revision: 0, actions: ["identity", "project.read", "role.read", "task.read"], readPaths: [], writePaths: [], roleIds: [], delegableActions: [], maxDelegationDepth: 0 }],
        limits: { totalConcurrency: 1, roleConcurrency: 1, maxAttempts: 3, maxCorrectionTurns: 2, maxManagementRounds: 3, maxDynamicRoles: 0, wallTimeMs: 3600000, costCeiling: null, costEnforcement: "unavailable" }, nativeMode: "disabled", writeIsolation: "exclusive_workspace"
      } });
      window.localStorage.setItem("projectorch.selection", JSON.stringify({ projectId: created.projectId, roleId: null }));
      pendingCreate = null; createForm.reset();
      await refreshConsole();
      feedback.textContent = team?'协作项目策略已登记，尚未创建或启动角色。请把下方指令交给已连接ProjectOrch的Harness对话执行。':'项目已保存，可在管理区登记角色和任务。原生自动执行未启用。';
      const instructions=get<HTMLTextAreaElement>('team-instructions');instructions.value=team?alphaTeamPrompt(created.projectId,fields.objective):'';get<HTMLElement>('team-next').hidden=!team;
    } catch (error) { feedback.textContent = errorText(error); }
    finally { submit.disabled = false; }
  })();
});
void connect().catch(error => {
  pairPanel.hidden = false; createPanel.hidden = true;
  status.textContent = "○ 尚未配对";
  if (!(error instanceof ApiError && [401, 403].includes(error.status))) feedback.textContent = errorText(error);
});

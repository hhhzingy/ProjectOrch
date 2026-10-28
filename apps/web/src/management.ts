import { api, ApiError, type ProjectSummary, type RoleStateSummary, type TaskSummary } from "./api.js";
import { reviewPanel } from "./review.js";
import { dependencyEditor } from "./dependency-editor.js";
import { taskReadinessPanel } from "./task-readiness.js";
import {questionPanel} from './questions.js';
const managementDisposers=new WeakMap<HTMLElement,()=>void>();

/** 用户管理入口。所有文本经textContent呈现，选择代次保护跨项目异步读写反馈。 */
export function mountManagement(root: HTMLElement, onChanged: () => Promise<void>, notify: (text: string) => void): (projectId: string | null) => void {
  managementDisposers.get(root)?.();
  const doc = root.ownerDocument;
  let selected: string | null = null;
  let generation = 0;
  let renderRevision=0;
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = ""): HTMLElementTagNameMap[K] => { const node = doc.createElement(tag); node.textContent = text; return node; };
  const label = (form: HTMLElement, name: string, control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) => { const row = element("label", name); control.setAttribute("aria-label", name); row.append(control); form.append(row); return control; };
  const field = (name: string, max: number) => { const input = element("input"); input.name = name; input.maxLength = max; input.required = true; return input; };
  const choices = (options: readonly { id: string; name: string }[]) => { const select = element("select"); for (const option of options) { const node = element("option", option.name); node.value = option.id; select.append(node); } return select; };
  let disposed=false,overviewBusy=false;
  let liveOverview:{projectId:string;epoch:number;table:HTMLTableElement;status:HTMLElement}|null=null,pollController:AbortController|null=null;
  const renderOverview=(table:HTMLTableElement,rows:readonly import('./api.js').OverviewRole[])=>{
    const head=element('tr');for(const name of ['角色','Harness','期望/绑定','模型请求','模型解析/推理','模型观察记录','当前任务','等待原因','下一动作','需处理者']){const th=element('th',name);th.scope='col';head.append(th);}
    const body=rows.map(role=>{const row=element('tr');for(const text of [role.name,role.harnessId??'—',role.desiredState+'/'+role.bindingState,role.modelRequested?.raw??'—',role.modelResolved?String(role.modelResolved.modelId??'待映射')+(role.modelResolved.reasoningLevel?'/'+role.modelResolved.reasoningLevel:''):'—',role.modelEffective?role.modelEffective.modelId+(role.modelEffective.providerId?'（'+role.modelEffective.providerId+'）':''):'尚无权威观察',role.currentTask??'—',role.waitingReason??'—',role.nextAction??'—',role.decisionBy??'—'])row.append(element('td',text));return row;});
    table.replaceChildren(head,...body);
  };
  const pollOverview=async()=>{
    const target=liveOverview;if(disposed||overviewBusy||!target||doc.visibilityState==='hidden'||!root.contains(target.table))return;
    overviewBusy=true;const controller=new AbortController();pollController=controller;const deadline=setTimeout(()=>controller.abort(),10000);
    try{const result=await api.overview(controller.signal);if(!disposed&&target===liveOverview&&target.epoch===generation&&target.projectId===selected&&root.contains(target.table)){renderOverview(target.table,result.projects.find(p=>p.projectId===target.projectId)?.roles??[]);target.status.textContent='监督数据已更新。';}}
    catch{if(!disposed&&target===liveOverview)target.status.textContent='监督连接暂不可用，保留上次记录；可刷新重新核对。';}
    finally{clearTimeout(deadline);if(pollController===controller)pollController=null;overviewBusy=false;}
  };
  const view=doc.defaultView;let interval:number|undefined;
  const startPolling=()=>{if(!disposed&&view&&interval===undefined)interval=view.setInterval(()=>{void pollOverview();},5000);};
  const stopPolling=()=>{if(interval!==undefined)view?.clearInterval(interval);interval=undefined;pollController?.abort();};
  const dispose=()=>{disposed=true;++generation;stopPolling();liveOverview=null;view?.removeEventListener('pagehide',stopPolling);view?.removeEventListener('pageshow',startPolling);};
  managementDisposers.set(root,dispose);view?.addEventListener('pagehide',stopPolling);view?.addEventListener('pageshow',startPolling);startPolling();
  const message = (error: unknown) => error instanceof ApiError && error.status === 409 ? "项目已变化或请求与原内容冲突，请刷新管理区后重新操作。" : error instanceof ApiError && error.status === 403 ? "所选权限档案或范围不允许这项操作。" : "操作未成功。请核对输入；连接中断时可用相同内容重试。";

  async function load(projectId: string, epoch: number): Promise<void> {
    root.replaceChildren(element("p", "正在加载项目管理…"));
    try {
      const [projects, roles, policy, page, overview] = await Promise.all([api.projects(), api.roles(projectId), api.policy(projectId), api.tasks(projectId), api.overview()]);
      if (epoch !== generation || projectId !== selected) return;
      const project = projects.projects.find(p => p.projectId === projectId);
      if (!project) throw new Error("PROJECT_NOT_FOUND");
      render(project, roles.roles, policy.profiles, [...page.items], page.nextCursor, epoch, overview.projects.find(p => p.projectId === projectId)?.roles ?? []);
    } catch (error) {
      if (epoch !== generation) return;
      const refresh = element("button", "重新加载管理区"); refresh.type = "button"; refresh.onclick = () => { void load(projectId, ++generation); };
      root.replaceChildren(element("p", error instanceof ApiError && /REPAIR/.test(error.message) ? "已有任务记录不符合当前合同，需要诊断后继续；原数据已保留。" : "管理区加载失败，请确认本地服务仍在运行。"), refresh);
    }
  }

  function render(project: ProjectSummary, roles: readonly RoleStateSummary[], profiles: readonly { id: string; revision: number }[], tasks: TaskSummary[], nextCursor: string | null, epoch: number, overviewRoles: readonly import("./api.js").OverviewRole[] = []): void {
    const view=++renderRevision;
    const heading = element("h2", `项目管理 — ${project.name}`);
    const note = element("p", "登记角色和任务后可持续修改、查看。角色尚未绑定原生会话时，任务不会自动执行。");
    const refresh = element("button", "刷新管理区"); refresh.type = "button"; refresh.onclick = () => { void load(project.projectId, ++generation); };
    // A120监督总览（只读一屏）：角色/harness/模型三态/当前任务/等待原因/下一动作
    const overview = element("section"); overview.append(element("h3", "监督总览"));
    const table=element('table');renderOverview(table,overviewRoles);
    const overviewStatus=element('p','监督数据每5秒自动更新，编辑表单保持原样。');overviewStatus.setAttribute('role','status');
    overview.append(table,overviewStatus,element("p","观察记录不等于当前配置或推理强度已生效；角色就绪也不代表任务通过全部准入。"));
    liveOverview={projectId:project.projectId,epoch,table,status:overviewStatus};
    const controls = element("fieldset"); const legend = element("legend", "角色与任务操作"); controls.append(legend);
    const roleOptions = [{ id: "", name: "暂不指派" }, ...roles.map(r => ({ id: r.roleId, name: r.name }))];
    let busy = false;
    const action = (form: HTMLFormElement, button: HTMLButtonElement, operations: () => unknown[]) => {
      let request: { signature: string; requestId: string } | null = null;
      form.addEventListener("submit", event => {
        event.preventDefault(); if (busy || epoch !== generation) return;
        const ops = operations(); const signature = JSON.stringify(ops);
        if (request?.signature !== signature) request = { signature, requestId: crypto.randomUUID() };
        const payload = { schemaVersion: 2, requestId: request.requestId, projectId: project.projectId, expectedPlanRevision: project.planRevision, reason: "用户在本地控制台操作", operations: ops };
        busy = true; controls.disabled = true; button.disabled = true;
        void (async () => {
          try {
            await api.applyChanges(payload);
            notify(epoch === generation ? "项目变更已保存。" : "先前项目的变更已保存，可切回查看。");
            await onChanged();
            if (epoch === generation) await load(project.projectId, ++generation);
          } catch (error) { if (epoch === generation) notify(message(error)); }
          finally { busy = false; controls.disabled = false; button.disabled = false; }
        })();
      });
    };

    const roleForm = element("form"); roleForm.append(element("h3", "新建角色"));
    const name = label(roleForm, "角色名称", field("roleName", 256));
    const charter = element("textarea"); charter.required = true; charter.maxLength = 8192; charter.rows = 2;
    label(roleForm, "职责与工作范围", charter);
    const profile = label(roleForm, "权限档案", choices(profiles.map(p => ({ id: p.id, name: `${p.id}（版本 ${p.revision}）` }))));
    const parent = label(roleForm, "上级角色", choices([{ id: "", name: "无上级" }, ...roles.map(r => ({ id: r.roleId, name: r.name }))]));
    const createRole = element("button", "保存角色"); createRole.type = "submit"; createRole.disabled = profiles.length === 0; roleForm.append(createRole);
    const roleId = crypto.randomUUID();
    action(roleForm, createRole, () => [{ type: "role.create", localRef: roleId, name: name.value.trim(), charter: charter.value.trim(), scopePaths: [], permissionProfileId: profile.value, permissionProfileRevision: profiles.find(p => p.id === profile.value)?.revision, ...(parent.value ? { parentRoleId: parent.value } : {}) }]);
    controls.append(roleForm);

    const roleActions = element("div"); roleActions.append(element("h3", "角色意图"));
    for (const role of roles) {
      const desired = { enabled: "启用", paused: "暂停", disabled: "停用" }[role.desiredState];
      const binding = { unbound: "未绑定", provisioning: "接入中", ready: "就绪", error: "异常" }[role.bindingState];
      const row = element("div"); row.className = "compact-actions"; row.append(element("span", `${role.name} · 期望 ${desired} · 绑定 ${binding} `));
      const targets = role.desiredState === "enabled" ? ["pause", "disable"] : role.desiredState === "paused" ? ["enable", "disable"] : ["enable"];
      for (const target of targets) {
        const button = element("button", target === "pause" ? "暂停角色" : target === "disable" ? "停用角色" : "启用角色"); button.type = "submit";
        const one = element("form"); one.append(button);
        action(one, button, () => [{ type: `role.${target}`, roleId: role.roleId, expectedRevision: role.revision, reason: "用户调整角色意图", currentWorkPolicy: "finish" }]);
        row.append(one);
      }
      roleActions.append(row);
    }
    controls.append(roleActions);

    // 模型配置独立版本；读取所选角色同一快照后保存，不复用旧项目或旧版本。
    const modelForm=element('form');modelForm.append(element('h3','角色模型偏好'));
    const modelRole=label(modelForm,'角色',choices(roles.map(r=>({id:r.roleId,name:r.name}))));
    const modelRaw=label(modelForm,'偏好原文（Requested，按原文保存不替换）',field('modelRequested',512)) as HTMLInputElement;
    const modelIdInput=label(modelForm,'模型ID（需官方支持，可选）',field('modelId',128)) as HTMLInputElement;modelIdInput.required=false;
    const modelReasoning=label(modelForm,'推理强度（需官方支持，可选）',field('reasoningLevel',32)) as HTMLInputElement;modelReasoning.required=false;
    const modelNote=element('p','保存不代表生效。既有会话在下个安全轮次尝试官方设置，无法解析或接口拒绝时保持阻塞。原生软件不改动；首次严格模型工厂尚未验证时不发送。');modelForm.append(modelNote);
    const modelVersion=element('p','正在读取模型配置…');modelVersion.setAttribute('role','status');modelForm.append(modelVersion);
    const modelSubmit=element('button','保存模型偏好');modelSubmit.type='submit';modelSubmit.disabled=true;
    const modelReset=element('button','跟随Harness默认模型');modelReset.type='button';modelReset.disabled=true;modelForm.append(modelSubmit,modelReset);
    let modelSnapshot:import('./api.js').ModelPreferenceState|null=null,modelSelectionEpoch=0;
    let modelRequest:{signature:string;requestId:string}|null=null;
    const loadModel=async()=>{
      const roleId=modelRole.value,selectionEpoch=++modelSelectionEpoch;modelSnapshot=null;modelSubmit.disabled=true;modelReset.disabled=true;
      if(!roleId){modelVersion.textContent='暂无角色。';return;}
      try{
        const value=await api.modelPreference(project.projectId,roleId);
        if(epoch!==generation||selectionEpoch!==modelSelectionEpoch||modelRole.value!==roleId||!root.contains(modelForm))return;
        modelSnapshot=value;modelRaw.value=value.requested?.raw??'';modelIdInput.value=value.resolved?.modelId??'';modelReasoning.value=value.resolved?.reasoningLevel??'';
        modelVersion.textContent='配置版本 '+value.modelRevision+'；角色职责版本 '+value.revision+'。';modelSubmit.disabled=false;modelReset.disabled=false;
      }catch{if(epoch===generation&&selectionEpoch===modelSelectionEpoch)modelVersion.textContent='配置读取失败，请刷新管理区后重试；未提交更改。';}
    };
    modelRole.addEventListener('change',()=>{void loadModel();});
    const saveModel=(resetToDefault:boolean)=>{
      if(busy||epoch!==generation||!modelSnapshot||modelSnapshot.roleId!==modelRole.value)return;
      const payload={projectId:project.projectId,roleId:modelRole.value,expectedRevision:modelSnapshot.revision,expectedModelRevision:modelSnapshot.modelRevision,...(resetToDefault?{resetToDefault:true}:{modelRequested:modelRaw.value,...(modelIdInput.value?{modelId:modelIdInput.value}:{}),...(modelReasoning.value?{reasoningLevel:modelReasoning.value}:{})})};
      const signature=JSON.stringify(payload);if(modelRequest?.signature!==signature)modelRequest={signature,requestId:crypto.randomUUID()};
      busy=true;controls.disabled=true;
      void(async()=>{
        try{const saved=await api.setModelPreference({requestId:modelRequest.requestId,...payload});notify((epoch===generation?'模型配置已保存':'先前项目的模型配置已保存')+'（配置版本 '+saved.modelRevision+'）。'+saved.effectiveNote);if(epoch===generation){await onChanged();if(epoch===generation)await load(project.projectId,++generation);}}
        catch(error){if(epoch===generation)notify(error instanceof ApiError&&error.status===409?'角色或配置已变化，请刷新管理区后核对再保存。':message(error));}
        finally{busy=false;controls.disabled=false;}
      })();
    };
    modelForm.addEventListener('submit',event=>{event.preventDefault();saveModel(false);});modelReset.onclick=()=>saveModel(true);controls.append(modelForm);
    // render在同一调用中挂载表单，异步读取结果会核对实际挂载与选择代次。
    void loadModel();

    const taskForm = element("form"); taskForm.append(element("h3", "新建任务"));
    const goal = element("textarea"); goal.required = true; goal.rows = 2; goal.maxLength = 8192; label(taskForm, "任务目标", goal);
    const assignee = label(taskForm, "执行角色", choices(roleOptions));
    const output = label(taskForm, "输出名称", field("outputName", 128)); output.value = "report";
    const description = label(taskForm, "输出要求", field("outputDescription", 1024));
    const acceptance = label(taskForm, "用户验收要求", field("acceptance", 1024));
    const predecessor = label(taskForm, "前置任务", choices([{ id: "", name: "无前置任务" }, ...tasks.map(task => ({ id: task.id, name: task.spec.goal }))]));
    const condition = label(taskForm, "前置条件", choices([{ id: "accepted", name: "指定规格已验收" }, { id: "artifact_available", name: "指定具名成果可用" }]));
    const dependencyOutput = label(taskForm, "前置输出名称（成果条件时填写）", field("dependencyOutput", 128)); dependencyOutput.required = false;
    const updateDependency = () => { dependencyOutput.required = !!predecessor.value && condition.value === "artifact_available"; dependencyOutput.disabled = !dependencyOutput.required; };
    predecessor.onchange = updateDependency; condition.onchange = updateDependency; updateDependency();
    const createTask = element("button", "保存任务"); createTask.type = "submit"; taskForm.append(createTask);
    const taskId = crypto.randomUUID();
    action(taskForm, createTask, () => {
      const pre = tasks.find(task => task.id === predecessor.value);
      return [{ type: "task.create", localRef: taskId, ...(assignee.value ? { assigneeRoleId: assignee.value } : {}), spec: { goal: goal.value.trim(), inputArtifacts: [], outputRequirements: [{ name: output.value.trim(), kind: "report", description: description.value.trim() }], acceptance: [{ ruleId: "user-review", mode: "user", description: acceptance.value.trim() }], dependencies: pre ? [{ taskId: pre.id, requiredTaskRevision: pre.specRevision, condition: condition.value, ...(condition.value === "artifact_available" ? { outputName: dependencyOutput.value.trim() } : {}) }] : [] } }];
    });
    controls.append(taskForm);
    const list = element("div");
    for (const task of tasks) {
      const stateNames: Record<string, string> = { draft: "草稿", ready: "待执行", active: "执行中", waiting: "等待输入", review: "待验收", accepted: "已验收", blocked: "阻塞", cancelled: "已取消" };
      const item = element("article"); item.append(element("h3", task.spec.goal), element("p", `状态 ${stateNames[task.state] ?? task.state} · 规格 ${task.specRevision} · 执行角色 ${roles.find(r => r.roleId === task.roleId)?.name ?? "未指派"}`));
      for (const dependency of task.spec.dependencies) item.append(element("p", `前置：${tasks.find(t => t.id === dependency.taskId)?.spec.goal ?? dependency.taskId} · 规格 ${dependency.requiredTaskRevision} · ${dependency.condition === "accepted" ? "验收" : `成果 ${dependency.outputName ?? "缺名称"}`}`));
      if (["draft", "ready", "blocked"].includes(task.state)) {
        const form = element("form"); form.className = "compact-actions"; const who = label(form, "重新指派给", choices(roleOptions)); who.value = task.roleId ?? "";
        const save = element("button", "保存指派"); save.type = "submit"; form.append(save);
        action(form, save, () => [{ type: "task.assign", taskId: task.id, expectedRevision: task.revision, roleId: who.value || null }]); item.append(form);
      }
      if (task.state !== "cancelled") {
        const dependencyForm = dependencyEditor(doc, task, tasks); action(dependencyForm.form, dependencyForm.submit, dependencyForm.operations); item.append(dependencyForm.root);
        const detail = element("details"), summary = element("summary", "修改任务目标");
        const form = element("form");
        form.append(element("p", "保存后建立新规格，旧成果和受影响后继需要重新核对。输入、输出、验收规则和依赖沿用当前规格。"));
        const revisedGoal = element("textarea"); revisedGoal.required = true; revisedGoal.maxLength = 8192; revisedGoal.rows = 3; revisedGoal.value = task.spec.goal;
        label(form, "新的任务目标", revisedGoal);
        const reason = label(form, "修订理由", field("revisionReason", 1024));
        const inFlight = label(form, "旧执行处理", choices([{ id: "finish_stale", name: "允许旧执行结束，成果按旧规格保留" }, { id: "request_stop", name: "请求停止旧执行，等待原生确认" }]));
        const save = element("button", "保存新规格"); save.type = "submit"; form.append(save);
        action(form, save, () => [{ type: "task.spec.revise", taskId: task.id, expectedRevision: task.revision, expectedSpecRevision: task.specRevision,
          spec: { ...task.spec, goal: revisedGoal.value.trim() }, affectedTaskIds: [], inFlightPolicy: inFlight.value, outputReuse: "none", reason: reason.value.trim() }]);
        detail.append(summary, form); item.append(detail);
      }
      item.append(taskReadinessPanel(doc, task, project.projectId, project.planRevision, tasks, () => epoch === generation, notify));
      item.append(reviewPanel(task.id, () => epoch === generation, notify, async () => { await onChanged(); if (epoch === generation) await load(project.projectId, ++generation); }));
      list.append(item);
    }
    const taskList = element("section"); taskList.append(element("h3", `任务（已加载 ${tasks.length} 项）`), list);
    if (nextCursor) {
      const more = element("button", "加载更多任务"); more.type = "button"; more.onclick = () => {
        more.disabled = true;
        void api.tasks(project.projectId, nextCursor).then(page => { if (epoch === generation) render(project, roles, profiles, [...tasks, ...page.items], page.nextCursor, epoch,overviewRoles); }).catch(error => { if (epoch === generation) { notify(message(error)); more.disabled = false; } });
      }; controls.append(more);
    }
    root.replaceChildren(heading, note, refresh, overview, questionPanel(doc,project.projectId,()=>epoch===generation&&view===renderRevision,notify), controls, taskList);
  }

  return projectId => { if (selected === projectId) return; selected = projectId; const epoch = ++generation; if (projectId === null) root.replaceChildren(element("p", "选择项目后可管理角色与任务。")); else void load(projectId, epoch); };
}

import type { TaskSummary } from "./api.js";

/** 保留所有已有依赖（包括未加载前置）；用户明确保存后才替换，绝不自动追随最新规格。 */
export function dependencyEditor(doc: Document, task: TaskSummary, tasks: readonly TaskSummary[]) {
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => { const result = doc.createElement(tag); result.textContent = text; return result; };
  const label = (parent: HTMLElement, text: string, control: HTMLInputElement | HTMLSelectElement) => { const row = node("label", text); control.setAttribute("aria-label", text); row.append(control); parent.append(row); return control; };
  const choose = (items: readonly { id: string; text: string }[]) => { const select = node("select"); for (const item of items) { const option = node("option", item.text); option.value = item.id; select.append(option); } return select; };
  const root = node("details"), form = node("form"), rows = node("div"); root.append(node("summary", "修改前置条件"));
  form.append(node("p", "保存将建立新规格。请明确选择所需前置规格；原目标、输入、输出和验收规则保留。仅列出当前已加载任务，已有未加载前置会保留。"), rows);
  const selected: { field: HTMLElement; read: () => TaskSummary["spec"]["dependencies"][number] }[] = [];
  const add = node("button", "添加前置条件"); add.type = "button";
  const create = (dependency?: TaskSummary["spec"]["dependencies"][number]) => {
    if (selected.length >= 128) return;
    const field = node("fieldset"); field.append(node("legend", "前置条件"));
    const candidates = tasks.filter(item => item.id !== task.id).map(item => ({ id: item.id, text: item.spec.goal }));
    if (dependency && !candidates.some(item => item.id === dependency.taskId)) candidates.push({ id: dependency.taskId, text: `已有前置（当前列表未加载） ${dependency.taskId}` });
    const target = label(field, "前置任务", choose(candidates)); target.required = true;
    if (dependency) target.value = dependency.taskId;
    const revision = node("input"); revision.type = "number"; revision.required = true; revision.min = "0"; revision.max = String(Number.MAX_SAFE_INTEGER); revision.step = "1";
    revision.value = String(dependency?.requiredTaskRevision ?? tasks.find(item => item.id === target.value)?.specRevision ?? 0); label(field, "所需前置规格", revision);
    const current = node("p");
    const latest = node("button", "使用此前置的最新规格"); latest.type = "button";
    const update = () => { const found = tasks.find(item => item.id === target.value); current.textContent = found ? `当前已加载规格：${found.specRevision}。所需规格由你选择，保存前不会自动更新。` : "此前置不在已加载列表中，请先核对其规格。"; latest.disabled = !found; };
    target.onchange = () => { const found = tasks.find(item => item.id === target.value); if (found) revision.value = String(found.specRevision); update(); };
    latest.onclick = () => { const found = tasks.find(item => item.id === target.value); if (found) revision.value = String(found.specRevision); }; update(); field.append(current, latest);
    const condition = label(field, "依赖条件", choose([{ id: "accepted", text: "指定规格已验收" }, { id: "artifact_available", text: "指定具名成果可用" }])); condition.value = dependency?.condition ?? "accepted";
    const output = node("input"); output.maxLength = 128; output.value = dependency?.outputName ?? ""; label(field, "前置输出名称", output);
    const outputState = () => { output.disabled = condition.value !== "artifact_available"; output.required = !output.disabled; }; condition.onchange = outputState; outputState();
    const remove = node("button", "移除此条件"); remove.type = "button";
    const entry = { field, read: () => ({ taskId: target.value, requiredTaskRevision: Number(revision.value), condition: condition.value, ...(condition.value === "artifact_available" ? { outputName: output.value.trim() } : {}) }) };
    remove.onclick = () => { selected.splice(selected.indexOf(entry), 1); field.remove(); add.disabled = false; };
    field.append(remove); rows.append(field); selected.push(entry); add.disabled = selected.length >= 128;
  };
  for (const dependency of task.spec.dependencies) create(dependency);
  add.onclick = () => create(); form.append(add);
  const reason = node("input"); reason.required = true; reason.maxLength = 1024; label(form, "依赖修订理由", reason);
  const inFlight = label(form, "依赖修订的旧执行处理", choose([{ id: "finish_stale", text: "允许旧执行结束，成果按旧规格保留" }, { id: "request_stop", text: "请求停止旧执行，等待原生确认" }]));
  const submit = node("button", "保存前置条件"); submit.type = "submit"; form.append(submit); root.append(form);
  return { root, form, submit, operations: () => [{ type: "task.dependencies.replace", taskId: task.id, expectedRevision: task.revision, expectedSpecRevision: task.specRevision,
    dependencies: selected.map(item => item.read()), affectedTaskIds: [], inFlightPolicy: inFlight.value, reason: reason.value.trim() }] };
}

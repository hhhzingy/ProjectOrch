import { api, type TaskSummary } from "./api.js";

export function taskReadinessPanel(doc: Document, task: TaskSummary, projectId: string, planRevision: number, tasks: readonly TaskSummary[], current: () => boolean, notify: (message: string) => void): HTMLElement {
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => { const result = doc.createElement(tag); result.textContent = text; return result; };
  const root = node("div"), button = node("button", "查看阻塞与依赖检查"); button.type = "button"; root.append(button);
  button.onclick = () => {
    if (!current() || button.disabled) return; button.disabled = true;
    void api.taskReadiness(task.id).then(data => {
      if (!current()) return;
      if (data.schemaVersion !== 2 || data.taskId !== task.id || data.projectId !== projectId || data.revision !== task.revision || data.specRevision !== task.specRevision || data.planRevision !== planRevision) throw new Error("任务或计划已变化，请刷新管理区后核对。");
      root.replaceChildren(node("h4", "依赖与规格核对"));
      if (data.userPaused) root.append(node("p", "项目已由用户暂停，不会自动启动新执行。"));
      if (data.dependencyReady) root.append(node("p", "当前依赖和规格重核条件已满足；仍需角色就绪、预算和执行准入，不代表AI已启动。"));
      const names: Record<string, string> = { PREREQ_NOT_FOUND: "前置任务不存在", PREREQ_CANCELLED: "前置任务已取消", PREREQ_NOT_ACCEPTED: "前置指定规格尚未验收", PREREQ_OUTPUT_NAME_MISSING: "依赖缺少输出名称", PREREQ_NO_ARTIFACT: "前置指定成果尚不可用", PREREQ_CONDITION_UNSUPPORTED: "依赖条件需要诊断" };
      for (const block of data.blocks) {
        const name = tasks.find(item => item.id === block.taskId)?.spec.goal ?? block.taskId;
        const text = block.reason === "TASK_SPEC_REVALIDATION_REQUIRED" ? `需重核本任务规格：${name} 的规格 ${block.requiredRevision} 变更影响了当前工作。请明确修订本任务，再重新提交和验收。`
          : block.reason === "PREREQ_SPEC_MISMATCH" ? `${name}：所需规格 ${block.requiredRevision}，当前规格 ${block.currentRevision ?? "未知"}。请明确选择需要的前置规格，不会自动改接。`
          : `${name}（所需规格 ${block.requiredRevision}）：${names[block.reason] ?? "需要诊断"}。`;
        root.append(node("p", text));
      }
      for (const attempt of data.unresolvedAttempts) root.append(node("p", `规格 ${attempt.specRevision} 的执行尚未确认结束（${({ dispatching: "正在派发", running: "执行中", waiting_input: "等待输入", unknown: "待原生核对" } as Record<string, string>)[attempt.state] ?? attempt.state}）。修改规格不会释放该执行占位。`));
    }).catch(error => { if (current()) { notify(String((error as Error).message)); button.disabled = false; } });
  };
  return root;
}

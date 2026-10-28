import { api } from "./api.js";
import { artifactViewer } from "./artifact-viewer.js";

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => { const result = document.createElement(tag); result.textContent = text; return result; };

/** 页面代次由项目管理区提供；迟到读取不能覆盖新项目，提交重试保持原requestId。 */
export function reviewPanel(taskId: string, current: () => boolean, notify: (text: string) => void, changed: () => Promise<void>): HTMLElement {
  const root = node("div"), open = node("button", "查看成果与用户验收"); root.className = "task-review"; open.type = "button"; root.append(open);
  open.onclick = () => {
    open.disabled = true;
    void api.taskReview(taskId).then(data => {
      if (!current()) return;
      root.replaceChildren(node("h4", "成果与验收"));
      root.append(node("p", "可读取已登记成果内容；通过时服务端会再次核验。只有用户规则可在这里裁决，原生执行成功仍需服务端确认。"));
      for (const artifact of data.artifacts) {
        const detail = node("details"), summary = node("summary", artifact.path.startsWith("git:") ? `提交 ${artifact.version}` : artifact.path);
        detail.append(summary, artifactViewer(artifact, current, notify)); root.append(detail);
      }
      for (const decision of data.decisions) root.append(node("p", `已有裁决：${decision.ruleId} · ${decision.decision} · ${decision.reviewerPrincipalId}`));
      if (data.results.length === 0) root.append(node("p", "尚无结果，不能验收。"));
      for (const result of data.results) {
        const group = node("fieldset"); group.append(node("legend", `结果 · 规格 ${result.taskRevision}`), node("p", result.summary), node("p", `结果 ${result.outcome} · 资格 ${result.eligibility} · 原生执行 ${result.executionState}`));
        for (const rule of data.task.spec.acceptance.filter(item => item.mode === "user")) {
          const form = node("form"); form.append(node("p", rule.description));
          const decision = node("select"); decision.setAttribute("aria-label", "验收决定");
          for (const [value, text] of [["needs_evidence", "要求补充证据"], ["reject", "退回"], ["accept", "通过此规则"]] as const) { const option = node("option", text); option.value = value; decision.append(option); }
          const reason = node("textarea"); reason.required = true; reason.maxLength = 8192; reason.setAttribute("aria-label", "裁决理由");
          const selected = new Map<string, HTMLInputElement>();
          for (const artifact of data.artifacts.filter(item => item.sha256?.length === 64 || (item.path.startsWith("git:") && item.repositoryPath != null))) { const description = artifact.path.startsWith("git:") ? `仓库 ${artifact.repositoryPath === "." ? "项目根" : artifact.repositoryPath} · 提交 ${artifact.version}` : `${artifact.path} · SHA256 ${artifact.sha256}`; const label = node("label", description), box = node("input"); box.type = "checkbox"; label.prepend(box); selected.set(artifact.id, box); form.append(label); }
          const submit = node("button", "保存用户裁决"); submit.type = "submit";
          let previous: { signature: string; requestId: string } | null = null;
          form.append(decision, reason, submit);
          form.onsubmit = event => {
            event.preventDefault(); if (!current() || submit.disabled) return;
            const payload = { taskId, taskRevision: data.task.specRevision, resultId: result.id, decision: decision.value, reason: reason.value.trim(), evidenceArtifactIds: [...selected].filter(([, box]) => box.checked).map(([id]) => id), ruleId: rule.ruleId };
            if (payload.decision === "accept" && payload.evidenceArtifactIds.length === 0) { notify("通过前请选择已核对的证据。"); return; }
            const signature = JSON.stringify(payload);
            if (previous?.signature !== signature) previous = { signature, requestId: crypto.randomUUID() };
            submit.disabled = true;
            void api.acceptTask({ schemaVersion: 2, requestId: previous.requestId, projectId: data.task.projectId, type: "task.accept", payload }).then(async () => { notify(current() ? "用户裁决已保存。" : "先前项目的用户裁决已保存。"); await changed(); }).catch(error => { if (current()) { notify(String((error as Error).message)); submit.disabled = false; } });
          };
          const already = data.decisions.filter(item => item.resultId === result.id && item.ruleId === rule.ruleId).at(-1)?.decision === "accept";
          const stale = result.taskRevision !== data.task.specRevision || result.eligibility !== "current";
          if (already || stale) { group.append(node("p", already ? "此规则已通过。" : "旧规格或非当前结果仅供查看。")); } else group.append(form);
        }
        root.append(group);
      }
    }).catch(error => { if (current()) { notify(String((error as Error).message)); open.disabled = false; } });
  };
  return root;
}

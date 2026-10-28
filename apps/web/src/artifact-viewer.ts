import { api } from "./api.js";

export function artifactViewer(artifact: { readonly id: string; readonly version: string; readonly path: string }, current: () => boolean, notify: (message: string) => void): HTMLElement {
  const root = document.createElement("div"), button = document.createElement("button"), content = document.createElement("pre");
  root.className = "artifact-viewer"; button.type = "button"; button.textContent = artifact.path.startsWith("git:") ? "读取提交对象" : "读取成果内容";
  root.append(button, content);
  let offset = 0, expectedHash: string | null = null, displayed = 0;
  button.onclick = () => {
    if (!current() || button.disabled) return;
    button.disabled = true;
    void api.artifactContent(artifact.id, artifact.version, offset).then(chunk => {
      if (!current()) return;
      if (chunk.artifactId !== artifact.id || chunk.version !== artifact.version || chunk.offset !== offset || typeof chunk.content !== "string" || !["utf8", "base64"].includes(chunk.encoding) || !/^[a-f0-9]{64}$/.test(chunk.sha256) || (chunk.nextOffset !== null && !Number.isSafeInteger(chunk.nextOffset)) || (expectedHash !== null && expectedHash !== chunk.sha256)) throw new Error("成果版本已变化，请重新打开核对。");
      expectedHash = chunk.sha256;
      if (chunk.encoding === "base64") {
        content.textContent = `二进制成果，当前分片编码为Base64（${chunk.content.length}字符）。完整文件仍可在项目目录核对。\n${chunk.content}`;
      } else content.textContent = (offset === 0 ? "" : content.textContent ?? "") + chunk.content;
      displayed += chunk.content.length;
      if (chunk.nextOffset === null) { button.textContent = offset === 0 && chunk.content === "" ? "空文件，内容已读完" : "内容已读完"; return; }
      if (chunk.nextOffset <= offset) throw new Error("成果分页状态无效，请重新读取。");
      offset = chunk.nextOffset;
      button.textContent = displayed >= 1024 * 1024 ? "已达本页预览上限，请在项目目录核对后续内容" : "读取下一段";
      button.disabled = displayed >= 1024 * 1024;
    }).catch(error => { if (current()) { offset = 0; expectedHash = null; displayed = 0; content.textContent = "未取得可确认内容；请核对版本、权限和文件状态。"; notify(String((error as Error).message)); button.textContent = "从头重新读取"; button.disabled = false; } });
  };
  return root;
}

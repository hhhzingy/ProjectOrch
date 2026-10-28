import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../../apps/web/dist/api.js';
import { artifactViewer } from '../../apps/web/dist/artifact-viewer.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const artifact = { id: 'a', version: 'v1', path: 'report.txt' };
const page = (offset, content, nextOffset, patch = {}) => ({ artifactId: 'a', version: 'v1', offset, content, encoding: 'utf8', nextOffset, sha256: 'a'.repeat(64), ...patch });
function setup(t) {
  const previous = { document: globalThis.document, read: api.artifactContent };
  t.after(() => { globalThis.document = previous.document; api.artifactContent = previous.read; });
  globalThis.document = { createElement: tag => ({ tag, children: [], textContent: '', disabled: false, append(...items) { this.children.push(...items); } }) };
}
test('预览只按服务端字节偏移续页，保留文本并阻止并发重复读取', async t => {
  setup(t); let finish; const requested = [];
  api.artifactContent = (_id, _version, offset) => { requested.push(offset); return new Promise(resolve => { finish = resolve; }); };
  const root = artifactViewer(artifact, () => true, () => {}), [button, pre] = root.children;
  button.onclick(); button.onclick(); assert.deepEqual(requested, [0]);
  finish(page(0, '<script>正文</script>', 20)); await tick();
  button.onclick(); assert.deepEqual(requested, [0, 20]); finish(page(20, '尾🙂', null)); await tick();
  assert.equal(pre.textContent, '<script>正文</script>尾🙂'); assert.equal(button.textContent, '内容已读完'); assert.equal(button.disabled, true);
});
test('哈希变化或读取失败清除预览并从头重读，不混合跨版本内容', async t => {
  setup(t); const requested = [], notices = [];
  api.artifactContent = async (_id, _version, offset) => { requested.push(offset); return requested.length === 1 ? page(0, '旧内容', 10) : requested.length === 2 ? page(10, '不同内容', null, { sha256: 'b'.repeat(64) }) : page(0, '重读', null); };
  const [button, pre] = artifactViewer(artifact, () => true, message => notices.push(message)).children;
  button.onclick(); await tick(); button.onclick(); await tick();
  assert.match(pre.textContent, /未取得可确认内容/); button.onclick(); await tick();
  assert.deepEqual(requested, [0, 10, 0]); assert.equal(pre.textContent, '重读'); assert.equal(notices.length, 1);
});
test('项目切换后的迟到内容不渲染；二进制明确显示编码而不执行', async t => {
  setup(t); let active = true, finish;
  api.artifactContent = () => new Promise(resolve => { finish = resolve; });
  const [button, pre] = artifactViewer(artifact, () => active, () => {}).children;
  button.onclick(); active = false; finish(page(0, '迟到', null)); await tick(); assert.equal(pre.textContent, '');
  api.artifactContent = async () => page(0, 'AP8B', null, { encoding: 'base64' });
  const current = artifactViewer(artifact, () => true, () => {}); current.children[0].onclick(); await tick(); assert.match(current.children[1].textContent, /二进制成果/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewPanel } from '../../apps/web/dist/review.js';
import { api } from '../../apps/web/dist/api.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const data = () => ({ task: { id: 'task', projectId: 'p', specRevision: 1, spec: { acceptance: [{ ruleId: 'user', mode: 'user', description: '核对证据' }] } }, results: [{ id: 'result', taskRevision: 1, outcome: 'succeeded', eligibility: 'current', summary: '<script>不可信正文</script>', executionState: 'succeeded' }], decisions: [], artifacts: [{ id: 'evidence', path: 'report.txt', sha256: 'a'.repeat(64), version: 'a'.repeat(64) }] });
function fixture(t) {
  const previous = { document: globalThis.document, read: api.taskReview, accept: api.acceptTask };
  t.after(() => { globalThis.document = previous.document; api.taskReview = previous.read; api.acceptTask = previous.accept; });
  globalThis.document = { createElement: tag => ({ tag, children: [], textContent: '', value: '', disabled: false, checked: false, append(...items) { this.children.push(...items); }, prepend(...items) { this.children.unshift(...items); }, replaceChildren(...items) { this.children = items; }, setAttribute() {} }) };
}
function all(root, tag) { return [...(root.tag === tag ? [root] : []), ...root.children.flatMap(child => all(child, tag))]; }

test('切换项目后迟到的验收资料不渲染到新页面', async t => {
  fixture(t); let resolve; let active = true;
  api.taskReview = () => new Promise(done => { resolve = done; });
  const panel = reviewPanel('task', () => active, () => {}, async () => {});
  panel.children[0].onclick(); active = false; resolve(data()); await tick();
  assert.equal(all(panel, 'form').length, 0);
});

test('用户未选证据不能通过；网络失败重试保留请求身份且不允许并发重复提交', async t => {
  fixture(t); const requests = []; const messages = []; let changed = 0; let finish;
  api.taskReview = async () => data();
  api.acceptTask = input => { requests.push(input); return new Promise((resolve, reject) => { finish = requests.length === 1 ? () => reject(new Error('NETWORK_UNKNOWN')) : () => resolve({ status: 'completed' }); }); };
  const panel = reviewPanel('task', () => true, text => messages.push(text), async () => { changed++; });
  panel.children[0].onclick(); await tick();
  const form = all(panel, 'form')[0], select = all(form, 'select')[0], reason = all(form, 'textarea')[0], box = all(form, 'input')[0];
  select.value = 'accept'; reason.value = '已检查证据';
  const submit = () => form.onsubmit({ preventDefault() {} });
  submit(); assert.equal(requests.length, 0); assert.match(messages.at(-1), /请选择/);
  box.checked = true; submit(); submit(); assert.equal(requests.length, 1);
  finish(); await tick(); submit(); assert.equal(requests.length, 2);
  assert.equal(requests[0].requestId, requests[1].requestId);
  assert.deepEqual(requests[0].payload.evidenceArtifactIds, ['evidence']);
  finish(); await tick(); assert.equal(changed, 1); assert.equal(requests[1].type, 'task.accept');
  assert.ok(all(panel, 'p').some(item => item.textContent === '<script>不可信正文</script>'), '正文作为文本保留，不作为HTML执行');
});

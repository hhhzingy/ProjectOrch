import test from 'node:test';
import assert from 'node:assert/strict';
import { dependencyEditor } from '../../apps/web/dist/dependency-editor.js';
import { taskReadinessPanel } from '../../apps/web/dist/task-readiness.js';
import { api } from '../../apps/web/dist/api.js';

// DOM垫片只验证交互语义；实际布局/HTTP另用专用浏览器合成项目核对。
function documentFixture() {
  const doc = { createElement(tag) {
    return { tag, children: [], attrs: {}, textContent: '', disabled: false, parent: null,
      append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } },
      replaceChildren(...items) { this.children = []; this.append(...items); },
      setAttribute(key, value) { this.attrs[key] = value; },
      remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); },
      get value() { return this._value ?? (this.tag === 'select' ? this.children[0]?.value ?? '' : ''); }, set value(value) { this._value = String(value); },
    };
  } }; return doc;
}
const all = node => [node, ...node.children.flatMap(all)];
const named = (node, label) => all(node).find(item => item.attrs['aria-label'] === label);
const button = (node, label) => all(node).find(item => item.tag === 'button' && item.textContent === label);
const task = { id: 'child', revision: 2, specRevision: 1, roleId: null, state: 'blocked', spec: { goal: '后继', outputRequirements: [], dependencies: [{ taskId: 'parent', requiredTaskRevision: 1, condition: 'accepted' }] } };
const parent = { ...task, id: 'parent', specRevision: 3, spec: { ...task.spec, goal: '前置', dependencies: [] } };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('已有前置不会自动改接最新规格；用户点击更新后才保存，保留版本和修订策略', () => {
  const editor = dependencyEditor(documentFixture(), task, [parent, task]);
  named(editor.root, '依赖修订理由').value = '明确选择规格3';
  assert.equal(editor.operations()[0].dependencies[0].requiredTaskRevision, 1);
  button(editor.root, '使用此前置的最新规格').onclick();
  assert.equal(editor.operations()[0].dependencies[0].requiredTaskRevision, 3);
  assert.equal(editor.operations()[0].expectedRevision, 2); assert.equal(editor.operations()[0].expectedSpecRevision, 1);
  assert.equal(editor.operations()[0].inFlightPolicy, 'finish_stale');
  assert.equal(editor.operations()[0].reason, '明确选择规格3');
});

test('未加载前置及具名成果完整保留；显式移除和添加由用户控制', () => {
  const existing = { ...task, spec: { ...task.spec, dependencies: [{ taskId: 'not-loaded', requiredTaskRevision: 7, condition: 'artifact_available', outputName: '图纸' }] } };
  const editor = dependencyEditor(documentFixture(), existing, [task, parent]);
  assert.deepEqual(editor.operations()[0].dependencies, existing.spec.dependencies);
  assert.equal(button(editor.root, '使用此前置的最新规格').disabled, true);
  button(editor.root, '移除此条件').onclick(); assert.deepEqual(editor.operations()[0].dependencies, []);
  button(editor.root, '添加前置条件').onclick(); assert.equal(editor.operations()[0].dependencies[0].taskId, 'parent');
  assert.equal(editor.operations()[0].dependencies[0].requiredTaskRevision, 3);
});

test('阻塞读取迟到或版本/项目不符时不显示旧结果；失败可以重试', async t => {
  const saved = api.taskReadiness; t.after(() => { api.taskReadiness = saved; });
  const doc = documentFixture(); let active = true, finish;
  api.taskReadiness = () => new Promise(resolve => { finish = resolve; });
  const notices = [], root = taskReadinessPanel(doc, task, 'p', 2, [parent, task], () => active, text => notices.push(text));
  const open = root.children[0]; open.onclick(); active = false;
  finish({ taskId: 'child', projectId: 'p', revision: 2, specRevision: 1, planRevision: 2, blocks: [], unresolvedAttempts: [], dependencyReady: true, userPaused: false }); await tick();
  assert.equal(root.children.length, 1); assert.equal(notices.length, 0);
  active = true;
  for (const patch of [{ projectId: 'foreign' }, { taskId: 'other' }, { revision: 3 }, { specRevision: 2 }, { planRevision: 3 }, { schemaVersion: 1 }]) {
    const count = notices.length, other = taskReadinessPanel(doc, task, 'p', 2, [parent, task], () => active, text => notices.push(text));
    const original = other.children[0]; original.onclick();
    finish({ schemaVersion: 2, taskId: 'child', projectId: 'p', revision: 2, specRevision: 1, planRevision: 2, blocks: [], unresolvedAttempts: [], dependencyReady: true, userPaused: false, ...patch }); await tick();
    assert.equal(other.children.length, 1); assert.equal(other.children[0], original); assert.equal(original.disabled, false); assert.equal(notices.length, count + 1);
  }
});

test('依赖满足不显示执行成功；暂停和unknown占位仍清楚显示', async t => {
  const saved = api.taskReadiness; t.after(() => { api.taskReadiness = saved; });
  api.taskReadiness = async () => ({ schemaVersion: 2, taskId: 'child', projectId: 'p', revision: 2, specRevision: 1, planRevision: 2, dependencyReady: true, userPaused: true, blocks: [], unresolvedAttempts: [{ attemptId: 'a', specRevision: 1, state: 'unknown' }] });
  const root = taskReadinessPanel(documentFixture(), task, 'p', 2, [parent, task], () => true, () => {});
  root.children[0].onclick(); await tick(); const texts = all(root).map(item => item.textContent).join('\n');
  assert.match(texts, /项目已由用户暂停/); assert.match(texts, /不代表AI已启动/); assert.match(texts, /待原生核对/); assert.match(texts, /不会释放/);
});

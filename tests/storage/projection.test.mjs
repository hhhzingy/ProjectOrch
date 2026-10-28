import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../packages/persistence/dist/index.js';
import { createProject, readProject } from '../../packages/domain/dist/projects/index.js';
import { createRole } from '../../packages/domain/dist/roles/index.js';
import { createTask } from '../../packages/domain/dist/tasks/index.js';
import { createCommandRunner } from '../../apps/kernel/dist/commands/index.js';
import { lifecycleCommandServices } from '../../apps/kernel/dist/commands/lifecycle-services.js';
import { buildProjection, verifyProjection } from '../../packages/domain/dist/projection/index.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-projection-', () => { for (const s of stores) s.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const open = () => { const s = openStore(filename); stores.push(s); return s; };
  const store = open();
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: 'E:/synthetic/proj', objective: '初始' }, 100);
  createRole(store, { id: 'r1', projectId: 'p1', name: 'r', charter: 'c', permissionProfileId: 'worker' }, 101);
  createTask(store, { id: 't1', projectId: 'p1', goal: 'g' }, 102);
  return { store, open };
}

test('事件重放投影：命令事件驱动状态与实际表一致（T022/A038投影基础）', t => {
  const { store } = fixture(t);
  const runner = createCommandRunner(store, lifecycleCommandServices(() => 200));
  runner('synthetic-user', { schemaVersion: 2, requestId: 'pj-1', projectId: 'p1', type: 'project.pause', payload: { reason: '投影测试', currentWorkPolicy: 'finish' } });
  runner('synthetic-user', { schemaVersion: 2, requestId: 'pj-2', projectId: 'p1', type: 'project.resume', payload: { expectedRevision: 2, reason: '恢复' } });
  const projection = buildProjection(store, 'p1');
  assert.equal(projection.eventWatermark, 2);
  assert.equal(projection.userPaused, false, '重放至resume后状态');
  assert.equal(readProject(store, 'p1').userPaused, false);
  const verification = verifyProjection(store, 'p1');
  assert.deepEqual(verification, { consistent: true, differences: [] }, '投影与实际表一致');
  // 增量：fromSequence之后无新事件→空投影且不影响校验
  const incremental = buildProjection(store, 'p1', projection.eventWatermark);
  assert.equal(incremental.userPaused, null, '增量窗口无事件时投影字段为未知');
});

test('未决状态检测：篡改实际表后投影校验报差异', t => {
  const { store } = fixture(t);
  const runner = createCommandRunner(store, lifecycleCommandServices(() => 200));
  runner('synthetic-user', { schemaVersion: 2, requestId: 'pj-3', projectId: 'p1', type: 'project.pause', payload: { reason: '暂停', currentWorkPolicy: 'finish' } });
  assert.equal(verifyProjection(store, 'p1').consistent, true);
  // 模拟旁路写入（未经事件管线的变更）
  store.db.prepare("UPDATE projects SET user_paused=0 WHERE id='p1'").run();
  const verification = verifyProjection(store, 'p1');
  assert.equal(verification.consistent, false, '旁路变更被投影校验发现');
  assert.equal(verification.differences.length, 1);
  assert.match(verification.differences[0], /user_paused/);
  // 恢复一致
  store.db.prepare("UPDATE projects SET user_paused=1 WHERE id='p1'").run();
  assert.equal(verifyProjection(store, 'p1').consistent, true);
});

test('缺失项目显式拒绝', t => {
  const { store } = fixture(t);
  assert.throws(() => verifyProjection(store, 'p-missing'), /PROJECTION_PROJECT_NOT_FOUND/);
});

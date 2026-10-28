/** 执行侧生效模型域函数：写入/读回/负例（非字符串modelId拒绝、角色不存在拒绝）。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { openStore } from '../../packages/persistence/dist/index.js';
import { createProject } from '../../packages/domain/dist/projects/index.js';
import { createRoleWithin } from '../../packages/domain/dist/roles/index.js';
import { recordModelEffective, readRoleModelEffective } from '../../packages/domain/dist/roles/index.js';
import {setRoleModelPreference} from '../../packages/domain/dist/roles/index.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';

const setup = t => {
  const dir = temporaryDirectory(t, 'projectorch-meff-', () => {});
  const store = openStore(`${dir}/state.sqlite`);
  createProject(store, { id: 'p1', name: 'n', hostId: 'h', canonicalRoot: dir, objective: 'x' }, 100);
  store.transaction(db => createRoleWithin(db, { id: 'worker', projectId: 'p1', name: '执行者', charter: '按指令', permissionProfileId: 'team', parentId: null }, 110));
  return store;
};

test('recordModelEffective：写入与权威读回；basis固定session-authoritative', t => {
  const store = setup(t);
  assert.equal(readRoleModelEffective(store, 'p1', 'worker'), null, '初始无生效值');
  recordModelEffective(store, 'p1', 'worker', { modelId: 'GLM-5.3', providerId: 'account:bigmodel-individual-coding-plan', observedAt: 123, basis: 'session-authoritative' });
  const e = readRoleModelEffective(store, 'p1', 'worker');
  assert.equal(e.modelId, 'GLM-5.3');
  assert.equal(e.providerId, 'account:bigmodel-individual-coding-plan');
  assert.equal(e.basis, 'session-authoritative');
  setRoleModelPreference(store,'p1','worker',{raw:'严格新模型',recordedAt:200},{modelId:'new-model',reasoningLevel:'high',basis:'user-specified',resolvedAt:200});
  assert.equal(readRoleModelEffective(store,'p1','worker'),null,'偏好变更不能把旧观察冒充新配置生效');
  store.close();
});

test('负例：非法modelId与不存在角色拒绝', t => {
  const store = setup(t);
  assert.throws(() => recordModelEffective(store, 'p1', 'worker', { modelId: '', providerId: null, observedAt: 1, basis: 'session-authoritative' }), /INVALID_MODEL_EFFECTIVE/);
  assert.throws(() => recordModelEffective(store, 'p1', 'ghost', { modelId: 'x', providerId: null, observedAt: 1, basis: 'session-authoritative' }), /ROLE_NOT_FOUND/);
  store.close();
});

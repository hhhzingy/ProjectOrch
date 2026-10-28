import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../packages/persistence/dist/index.js';
import { createProject } from '../../packages/domain/dist/projects/index.js';
import { createTask } from '../../packages/domain/dist/tasks/index.js';
import { registerArtifact } from '../../packages/domain/dist/artifacts/index.js';
import { requestIntegration, startIntegration, completeIntegration, failIntegration, retryIntegration, readIntegration } from '../../packages/domain/dist/integrations/index.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-integrations-', () => { for (const s of stores) s.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const open = () => { const s = openStore(filename); stores.push(s); return s; };
  const store = open();
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: 'E:/synthetic/integ', objective: 'o' }, 100);
  createTask(store, { id: 't1', projectId: 'p1', goal: 'g' }, 101);
  registerArtifact(store, { id: 'art-1', projectId: 'p1', taskId: 't1', version: 'v1', pathRef: 'results/out.txt' }, 110);
  return { store, open };
}
const checks = [{ name: 'build', description: '构建通过' }, { name: 'smoke', description: '冒烟通过' }];

test('集成请求：成果引用闭环（未登记成果拒绝）；pending起点', t => {
  const { store } = fixture(t);
  const integration = requestIntegration(store, { id: 'int1', projectId: 'p1', taskId: 't1', targetVersion: 'v1.0', artifactIds: ['art-1'], checks }, 120);
  assert.equal(integration.state, 'pending');
  assert.deepEqual(integration.artifacts, ['art-1']);
  assert.throws(() => requestIntegration(store, { id: 'int2', projectId: 'p1', taskId: 't1', targetVersion: 'v2', artifactIds: ['art-missing'], checks }, 121), /INTEGRATION_ARTIFACT_NOT_FOUND/, '未登记成果拒绝');
  assert.throws(() => requestIntegration(store, { id: 'int3', projectId: 'p1', taskId: 't1', targetVersion: 'v3', artifactIds: [], checks }, 122), /INVALID_INTEGRATION_ARTIFACTS/, '空成果清单拒绝');
});

test('集成过程：start→verified需全部检查通过；未过→failed可重试；状态机拒绝跳跃', t => {
  const { store, open } = fixture(t);
  requestIntegration(store, { id: 'int1', projectId: 'p1', taskId: 't1', targetVersion: 'v1.0', artifactIds: ['art-1'], checks }, 120);
  // 未start直接complete：pending→verified跳跃拒绝
  assert.throws(() => completeIntegration(store, 'p1', 'int1', [{ name: 'build', passed: true }, { name: 'smoke', passed: true }], 121), /INTEGRATION_TRANSITION_REJECTED/);
  startIntegration(store, 'p1', 'int1', 122);
  // 检查未全过→failed
  assert.throws(() => completeIntegration(store, 'p1', 'int1', [{ name: 'build', passed: true }], 123), /INTEGRATION_CHECK_NOT_PASSED/, '缺smoke结果不得verified');
  failIntegration(store, 'p1', 'int1', [{ name: 'build', passed: true }, { name: 'smoke', passed: false, detail: '启动失败' }], 124);
  assert.equal(readIntegration(store, 'p1', 'int1').state, 'failed');
  // failed→integrating重试→全部通过→verified
  retryIntegration(store, 'p1', 'int1', 125);
  const verified = completeIntegration(store, 'p1', 'int1', [{ name: 'build', passed: true }, { name: 'smoke', passed: true }], 126);
  assert.equal(verified.state, 'verified');
  assert.throws(() => retryIntegration(store, 'p1', 'int1', 127), /INTEGRATION_TRANSITION_REJECTED/, 'verified终态');
  store.close();
  const reopened = open();
  assert.equal(readIntegration(reopened, 'p1', 'int1').state, 'verified', '跨重启持久');
});

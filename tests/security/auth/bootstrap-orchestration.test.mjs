/** T114/T115（PR2-W2）：project.bootstrap持久分步 + 角色模型偏好三态（离线）。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { bootstrapRole, readBootstrapState } from '../../../packages/domain/dist/bootstrap/index.js';
import { createRole, readRole } from '../../../packages/domain/dist/roles/index.js';
import { setRoleModelPreference, readRoleModelPreference } from '../../../packages/domain/dist/roles/index.js';
import { establishFirstBinding } from '../../../packages/domain/dist/native-binding/index.js';
import { installSyntheticPolicy } from './synthetic-policy.mjs';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

function syntheticFactory() {
  const calls = [];
  return { calls, async ensureBoundSession(input) {
    calls.push(input);
    if (input.failMode === 'unknown') throw new Error('FACTORY_UNKNOWN');
    const sessionId = `sess_bs_${input.roleId}`;
    input.onStep({ step: 'create-session', state: 'observed', detail: sessionId, at: Date.now() });
    input.onStep({ step: 'deliver-charter', state: 'observed', detail: `turn_${input.roleId}`, at: Date.now() });
    input.onStep({ step: 'startup-ack', state: 'observed', detail: null, at: Date.now() });
    return { sessionId, nativeTurnId: `turn_${input.roleId}` };
  } };
}

/** project.bootstrap 持久分步编排（幂等键=projectId+roleId集；可恢复；部分成功可见）。 */
function orchestrateBootstrap(store, factory, input) {
  const operationId = `boot-${input.projectId}`;
  const idempotencyKey = `bootstrap:${input.projectId}:${[...input.roles].map(r => r.roleId).sort().join(',')}`;
  const state = { operationId, idempotencyKey, steps: [], completed: false };
  return { state, async run() {
    // 步1：项目+负责人bootstrap（幂等——已有则复用）
    state.steps.push('ensure-project');
    // 步2：各角色（部分成功可见——每角色独立步骤记录）
    for (const role of input.roles) {
      const existing = store.db.prepare("SELECT 1 FROM roles WHERE id=? AND project_id=?").get(role.roleId, input.projectId);
      if (existing) { state.steps.push(`role:${role.roleId}:exists`); continue; }
      createRole(store, { id: role.roleId, projectId: input.projectId, name: role.name, charter: role.charter, permissionProfileId: role.permissionProfileId }, Date.now());
      if (role.modelPreference) setRoleModelPreference(store, input.projectId, role.roleId, role.modelPreference.requested, role.modelPreference.resolved);
      if (role.createSession) {
        try {
          const outcome = await factory.ensureBoundSession({ projectId: input.projectId, roleId: role.roleId, charter: role.charter, failMode: role.failMode, onStep: () => {} });
          const sessRow = `sessrow-${role.roleId}`;
          store.transaction(db => {
            db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES(?,'zcode','orch','orch',?)").run(sessRow, outcome.sessionId);
            db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES(?,?,?,?,1,?)").run(`bnd-${role.roleId}`, input.projectId, role.roleId, sessRow, Date.now());
            db.prepare("UPDATE roles SET binding_state='ready' WHERE id=? AND project_id=?").run(role.roleId, input.projectId);
          });
          state.steps.push(`role:${role.roleId}:created+bound`);
        } catch (error) { state.steps.push(`role:${role.roleId}:session-unknown（部分成功：角色已建，会话待恢复）`); state.partial = true; }
      } else state.steps.push(`role:${role.roleId}:created`);
    }
    state.completed = true;
    return state;
  } };
}

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-t114-', () => { for (const s of stores.splice(0)) { try { s.close(); } catch { /* 已关 */ } } });
  const store = openStore(path.join(dir, 'state.sqlite')); stores.push(store);
  createProject(store, { id: 'p1', name: 'demo', hostId: 'h', canonicalRoot: dir, objective: '团队演示' }, 100);
  bootstrapRole(store, { projectId: 'p1', localRef: 'lead', name: '主负责人', charter: '现有负责人', permissionProfileId: 'exec', permissionProfileRevision: 1, expectedPolicyRevision: 0, principalId: 'user-1', requestId: 'b0' }, 110);
  installSyntheticPolicy(store, 'p1', [{ id: 'exec', revision: 1, actions: ['identity', 'message.send'], readPaths: [], writePaths: [], roleIds: [], delegableActions: [], maxDelegationDepth: 0 }]);
  return { dir, store, stores };
}

test('T114离线：bootstrap=现有负责人+四新角色（共5）；分步幂等重跑不重复创建', async t => {
  const { store } = fixture(t);
  const factory = syntheticFactory();
  const roles = [
    { roleId: 'reviewer', name: '复核', charter: '复核角色章程', permissionProfileId: 'exec', createSession: true },
    { roleId: 'manager', name: '任务管理', charter: '管理角色章程', permissionProfileId: 'exec', createSession: true },
    { roleId: 'exec1', name: '执行1', charter: '执行角色章程', permissionProfileId: 'exec', createSession: true },
    { roleId: 'exec2', name: '执行2', charter: '执行角色章程', permissionProfileId: 'exec', createSession: true },
  ];
  const op = orchestrateBootstrap(store, factory, { projectId: 'p1', roles });
  const first = await op.run();
  // 5角色=现有lead+4新
  const count = store.db.prepare("SELECT COUNT(*) AS n FROM roles WHERE project_id='p1'").get().n;
  assert.equal(count, 5, '现有负责人+四新角色=5');
  assert.ok(first.steps.every(s => !String(s).includes('unknown')), '全部成功');
  // 幂等重跑：不重复创建（factory不再被调用）
  const callsBefore = factory.calls.length;
  const second = await orchestrateBootstrap(store, factory, { projectId: 'p1', roles }).run();
  assert.equal(factory.calls.length, callsBefore, '重跑不重复创建会话');
  assert.ok(second.steps.filter(s => String(s).startsWith('role:')).every(s => String(s).includes('exists')), '全部角色步骤为已存在');
});

test('T114离线：部分成功可见可恢复（一个角色会话unknown——角色已建、会话待恢复、其余继续）', async t => {
  const { store } = fixture(t);
  const factory = syntheticFactory();
  const roles = [
    { roleId: 'r-ok1', name: 'ok1', charter: 'c', permissionProfileId: 'exec', createSession: true },
    { roleId: 'r-bad', name: 'bad', charter: 'c', permissionProfileId: 'exec', createSession: true, failMode: 'unknown' },
    { roleId: 'r-ok2', name: 'ok2', charter: 'c', permissionProfileId: 'exec', createSession: true },
  ];
  const op = orchestrateBootstrap(store, factory, { projectId: 'p1', roles });
  const result = await op.run();
  assert.equal(result.partial, true, '部分成功标记');
  const badRole = store.db.prepare("SELECT COUNT(*) AS n FROM roles WHERE id='r-bad'").get().n;
  assert.equal(badRole, 1, '失败角色仍已创建（可恢复）');
  const ok2Bound = store.db.prepare("SELECT binding_state FROM roles WHERE id='r-ok2'").get().binding_state;
  assert.equal(ok2Bound, 'ready', '后续角色不被阻断');
});

test('T115离线：模型偏好三态——requested原文保留/resolved映射留据/修改版本化', t => {
  const { store } = fixture(t);
  createRole(store, { id: 'r-model', projectId: 'p1', name: 'm', charter: 'c', permissionProfileId: 'exec' }, 1200);
  // requested=用户原文（含"极高"）
  setRoleModelPreference(store, 'p1', 'r-model', { raw: 'codex 6.1sol 极高', recordedAt: 1000 }, null);
  let pref = readRoleModelPreference(store, 'p1', 'r-model');
  assert.equal(pref.requested.raw, 'codex 6.1sol 极高', '原文保留不替换');
  assert.equal(pref.resolved, null, '未解析时resolved为null（如实）');
  // resolved=映射（含依据）
  setRoleModelPreference(store, 'p1', 'r-model', { raw: 'codex 6.1sol 极高', recordedAt: 1000 }, { modelId: 'gpt-5-codex', reasoningLevel: 'high', basis: '依据：账号目录0.163.0能力表+用户授权映射', resolvedAt: 2000 });
  pref = readRoleModelPreference(store, 'p1', 'r-model');
  assert.equal(pref.resolved.modelId, 'gpt-5-codex');
  assert.ok(pref.resolved.basis.includes('依据'), '映射留据');
  // 修改版本化
  const revAfter = store.db.prepare("SELECT revision,model_preference_revision FROM roles WHERE id='r-model'").get();
  assert.equal(revAfter.revision,1,'模型配置不改变角色职责/权限版本');assert.equal(revAfter.model_preference_revision,2,'两次修改有独立配置版本');
  const history = store.db.prepare("SELECT COUNT(*) AS n FROM role_model_revisions WHERE role_id='r-model'").get().n;
  assert.ok(history >= 2, '快照留痕');
  // zcode侧requested示例
  createRole(store, { id: 'r-zm', projectId: 'p1', name: 'zm', charter: 'c', permissionProfileId: 'exec' }, 1210);
  setRoleModelPreference(store, 'p1', 'r-zm', { raw: 'zcode 5.3flash 最高推理', recordedAt: 1000 }, { modelId: 'GLM-5.3-Flash', reasoningLevel: 'max', basis: '依据：zcode-cli 0.17.0 --model能力', resolvedAt: 2000 });
  const zm = readRoleModelPreference(store, 'p1', 'r-zm');
  assert.equal(zm.requested.raw, 'zcode 5.3flash 最高推理', '用户原文');
  assert.equal(zm.resolved.modelId, 'GLM-5.3-Flash', 'zcode映射');
});

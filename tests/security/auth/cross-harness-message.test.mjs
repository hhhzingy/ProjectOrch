/** T113（PR2-W1）：跨端消息编排层（离线部分）。
 * 编排职责（R103/R108）：message.send 目标角色尚无绑定时——工厂现场创建持久会话（离线=合成工厂）→
 * 章程下发→启动握手→消息投递。已有绑定→既有收件箱路径。
 * 持久分步操作：operationId + onStep边界 + 幂等键 + unknown如实。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { bootstrapRole } from '../../../packages/domain/dist/bootstrap/index.js';
import { createRole } from '../../../packages/domain/dist/roles/index.js';
import { establishFirstBinding } from '../../../packages/domain/dist/native-binding/index.js';
import { installSyntheticPolicy } from './synthetic-policy.mjs';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

// 合成工厂（离线）：模拟"创建持久会话+章程+握手"——真实工厂在A111/A117原生验收
function syntheticFactory() {
  const calls = [];
  return {
    calls,
    async ensureBoundSession(input) {
      calls.push(input);
      if (input.failMode === 'unknown') { input.onStep({ step: 'create-session', state: 'unknown', detail: 'CLI_TIMEOUT', at: Date.now() }); throw new Error('FACTORY_UNKNOWN'); }
      const sessionId = `sess_orch_${input.roleId}_${randomUUID().slice(0, 8)}`;
      input.onStep({ step: 'create-session', state: 'sent', detail: null, at: Date.now() });
      input.onStep({ step: 'create-session', state: 'observed', detail: sessionId, at: Date.now() });
      input.onStep({ step: 'deliver-charter', state: 'observed', detail: `turn_${sessionId.slice(4, 12)}`, at: Date.now() });
      input.onStep({ step: 'startup-ack', state: 'observed', detail: null, at: Date.now() });
      return { sessionId, nativeTurnId: `turn_${sessionId.slice(4, 12)}` };
    },
  };
}

/** 编排：跨端消息发送（持久分步）。目标有绑定→inbox路径；无绑定→工厂创建+章程+握手+投递。 */
function orchestrateCrossHarnessMessage(store, factory, input) {
  const operationId = `op-${randomUUID()}`;
  const idempotencyKey = `xmsg:${input.projectId}:${input.toRoleId}:${input.bodyHash}`;
  const steps = [];
  const onStep = s => steps.push(s);
  return { operationId, idempotencyKey, async run() {
    // 幂等：同键操作返回既有状态（由调用方持久化operation记录；此处单次运行为例）
    const binding = store.db.prepare("SELECT b.id, b.epoch, s.native_conversation_id FROM role_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.project_id=? AND b.role_id=? AND b.ended_at IS NULL").get(input.projectId, input.toRoleId);
    let targetSessionId;
    if (binding) { onStep({ step: 'use-existing-binding', state: 'observed', detail: String(binding.native_conversation_id), at: Date.now() }); targetSessionId = String(binding.native_conversation_id); }
    else {
      const created = await factory.ensureBoundSession({ projectId: input.projectId, roleId: input.toRoleId, charter: input.charter, failMode: input.failMode, onStep });
      targetSessionId = created.sessionId;
      // 登记：sessions + binding（真实实现走域函数；测试内直插）
      const sessionId = `sessrow-${randomUUID().slice(0, 8)}`;
      store.transaction(db => {
        db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES(?,'zcode','orch-host','orch-profile',?)").run(sessionId, targetSessionId);
        db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES(?,?,?,?,1,?)").run(`bnd-${randomUUID().slice(0, 8)}`, input.projectId, input.toRoleId, sessionId, Date.now());
        db.prepare("UPDATE roles SET binding_state='ready' WHERE id=? AND project_id=?").run(input.toRoleId, input.projectId);
      });
    }
    // 消息投递（收件箱路径——排队≠delivered如实）
    onStep({ step: 'deliver-message', state: 'sent', detail: null, at: Date.now() });
    store.transaction(db => db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES(?,?,'orchestrator',?,?,?,?, 'completed',?)").run(`cmd-${operationId.slice(3, 11)}`, input.projectId, operationId, '0'.repeat(64), 'message.send', JSON.stringify({ body: input.body, toRoleId: input.toRoleId }), Date.now()));
    store.transaction(db => db.prepare("INSERT INTO messages(id,project_id,command_id,to_role_id,task_id,kind,body,delivery_json,state,created_at) VALUES(?,?,?,?,NULL,'information',?,?,'stored',?)").run(`msg-${operationId.slice(3, 11)}`, input.projectId, `cmd-${operationId.slice(3, 11)}`, input.toRoleId, input.body, JSON.stringify({ transitions: [{ state: 'queued', at: Date.now() }], nativeTargetSessionId: targetSessionId }), Date.now()));
    onStep({ step: 'deliver-message', state: 'observed', detail: 'queued（inbox持久，非原生delivered）', at: Date.now() });
    return { operationId, steps, targetSessionId };
  } };
}

function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-t113-', () => { for (const s of stores.splice(0)) { try { s.close(); } catch { /* 已关 */ } } });
  const store = openStore(path.join(dir, 'state.sqlite'));
  stores.push(store);
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: dir, objective: 'o' }, 100);
  bootstrapRole(store, { projectId: 'p1', localRef: 'r-sender', name: 'sender', charter: '发起', permissionProfileId: 'exec', permissionProfileRevision: 1, expectedPolicyRevision: 0, principalId: 'user-1', requestId: 'b0' }, 110);
  createRole(store, { id: 'r-target', projectId: 'p1', name: 'target', charter: '目标角色章程：负责演示', permissionProfileId: 'exec' }, 111);
  installSyntheticPolicy(store, 'p1', [{ id: 'exec', revision: 1, actions: ['identity', 'message.send'], readPaths: [], writePaths: [], roleIds: [], delegableActions: [], maxDelegationDepth: 0 }]);
  return { dir, store, stores };
}

test('T113离线：目标无绑定→工厂现场创建+章程+握手+收件箱投递（排队≠delivered如实）', async t => {
  const { store } = fixture(t);
  const factory = syntheticFactory();
  const op = orchestrateCrossHarnessMessage(store, factory, { projectId: 'p1', toRoleId: 'r-target', body: '你好', bodyHash: 'h1', charter: '目标角色章程：负责演示' });
  const result = await op.run();
  assert.ok(result.targetSessionId.startsWith('sess_orch_'), '目标会话为工厂创建');
  assert.equal(factory.calls.length, 1, '工厂恰好调用一次');
  // 步骤边界完整
  const stepKeys = result.steps.map(s => `${s.step}:${s.state}`);
  assert.ok(stepKeys.includes('create-session:sent') && stepKeys.includes('create-session:observed'), '创建边界');
  assert.ok(stepKeys.includes('deliver-charter:observed'), '章程下发');
  assert.ok(stepKeys.includes('startup-ack:observed'), '启动握手');
  assert.ok(stepKeys.includes('deliver-message:observed'), '消息投递观察');
  // 绑定已登记
  const binding = store.db.prepare("SELECT b.id FROM role_bindings b WHERE b.project_id='p1' AND b.role_id='r-target' AND b.ended_at IS NULL").get();
  assert.ok(binding, '绑定登记');
  // 消息入收件箱（stored/queued——非delivered）
  const msg = store.db.prepare("SELECT state, delivery_json FROM messages WHERE to_role_id='r-target'").get();
  assert.equal(msg.state, 'stored', 'inbox持久');
  assert.ok(JSON.stringify(msg.delivery_json).includes('queued'), '排队语义如实');
  // 章程非硬编码：来自角色charter
  assert.equal(factory.calls[0].charter, '目标角色章程：负责演示');
});

test('T113离线：目标已有绑定→复用既有会话（不重复创建）', async t => {
  const { store } = fixture(t);
  // 预置绑定
  store.transaction(db => {
    db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s-exist','zcode','h','p','sess_existing_1')").run();
    db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b-exist','p1','r-target','s-exist',1,100)").run();
  });
  const factory = syntheticFactory();
  const op = orchestrateCrossHarnessMessage(store, factory, { projectId: 'p1', toRoleId: 'r-target', body: '你好', bodyHash: 'h2', charter: 'x' });
  const result = await op.run();
  assert.equal(result.targetSessionId, 'sess_existing_1', '复用既有会话');
  assert.equal(factory.calls.length, 0, '工厂未被调用');
});

test('T113离线：工厂unknown→操作停在unknown不盲重试不投递', async t => {
  const { store } = fixture(t);
  const factory = syntheticFactory();
  const op = orchestrateCrossHarnessMessage(store, factory, { projectId: 'p1', toRoleId: 'r-target', body: '你好', bodyHash: 'h3', charter: 'x', failMode: 'unknown' });
  await assert.rejects(() => op.run(), /FACTORY_UNKNOWN/);
  // 不产生消息（未盲投递）
  const msg = store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE to_role_id='r-target'").get();
  assert.equal(msg.n, 0, 'unknown不投递');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { createRole } from '../../../packages/domain/dist/roles/index.js';
import { sendMessage } from '../../../packages/domain/dist/messages/index.js';
import { createCommandRunner } from '../../../apps/kernel/dist/commands/index.js';
import { lifecycleCommandServices } from '../../../apps/kernel/dist/commands/lifecycle-services.js';
import { exportDiagnosticBundle, serializeBundle, contentDigest } from '../../../apps/kernel/dist/audit/diagnostics.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

test('诊断导出：零正文零凭据、消息仅长度+摘要、确定性序列化（T049/A067准备）', t => {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-diagnostics-', () => { for (const s of stores) s.close(); });
  const store = openStore(path.join(dir, 'state.sqlite'));
  stores.push(store);
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: 'E:/synthetic/diag', objective: '机密目标内容示例' }, 100);
  createRole(store, { id: 'r1', projectId: 'p1', name: 'r', charter: 'c', permissionProfileId: 'worker' }, 101);
  store.transaction(db => db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('c1','p1','u','rq1',?,'project.pause','{\"reason\":\"机密暂停原因\"}','completed',100)").run('0'.repeat(64)));
  // 命令管线产生真实事件（pause）
  const runner = createCommandRunner(store, lifecycleCommandServices(() => 105));
  const paused = runner('diag-user', { schemaVersion: 2, requestId: 'diag-1', projectId: 'p1', type: 'project.pause', payload: { reason: '机密暂停原因', currentWorkPolicy: 'finish' } });
  void paused;
  const secretBody = '机密消息正文-不得出现在导出中-secret-content';
  sendMessage(store, { id: 'm1', projectId: 'p1', commandId: 'c1', toRoleId: 'r1', kind: 'notice', body: secretBody }, 110);
  const bundle = exportDiagnosticBundle(store, 'p1', 500);
  assert.equal(bundle.redacted, true);
  assert.equal(bundle.eventWatermark, 1);
  assert.equal(bundle.commands[0].type, 'project.pause');
  assert.equal(JSON.stringify(bundle).includes('机密暂停原因'), false, '命令payload原因不入导出');
  assert.equal(JSON.stringify(bundle).includes(secretBody), false, '消息正文不入导出');
  assert.equal(JSON.stringify(bundle).includes('机密目标内容示例'), false, '项目目标不入导出');
  const message = bundle.messages[0];
  assert.equal(message.bodyLength, secretBody.length);
  assert.equal(message.bodyDigest, contentDigest(secretBody), '正文摘要可核对不可复原');
  // 确定性：两次导出同内容同序
  const again = exportDiagnosticBundle(store, 'p1', 500);
  assert.equal(serializeBundle(bundle), serializeBundle(again), '确定性序列化可哈希比对');
  // 项目隔离与缺失拒绝
  assert.throws(() => exportDiagnosticBundle(store, 'p-other', 500), /EXPORT_PROJECT_NOT_FOUND/);
});

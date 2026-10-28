import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {ensureBindingWorkspace,bindingWorkspaceDirectory} from '../../../apps/kernel/dist/execution/binding-workspace.js';
import {executionFixture} from './execution-fixture.mjs';

test('默认绑定工作目录留在真实项目内；不同绑定独立，已有目录链接拒绝',t=>{
 const f=executionFixture(t);
 const first=bindingWorkspaceDirectory(f.store,'p','binding');
 assert.ok(first.startsWith(path.join(f.dir,'.projectorch','workspaces')+path.sep));
 assert.equal(bindingWorkspaceDirectory(f.store,'p','binding'),first);
 assert.notEqual(bindingWorkspaceDirectory(f.store,'p','other'),first);
 fs.rmdirSync(first);fs.symlinkSync(f.driver.workspaceRoot,first,'junction');
 try{assert.throws(()=>bindingWorkspaceDirectory(f.store,'p','binding'),/WORKSPACE_IDENTITY_CHANGED/);}finally{fs.unlinkSync(first);}
});

test('受信绑定目录登记返回稳定短ID，复用工作流事务且不把advisory改为enforced',t=>{
  const f=executionFixture(t),root=path.join(f.dir,'binding-role');fs.mkdirSync(root);
  f.store.db.prepare('UPDATE sessions SET native_workspace_id=? WHERE id=?').run(root,'session');
  const before=f.store.db.prepare("SELECT policy_json FROM projects WHERE id='p'").get().policy_json;
  const id=f.store.transaction(()=>ensureBindingWorkspace(f.store,'p','task','binding',root,200));
  assert.match(id,/^binding-ws-[a-f0-9]{64}$/);assert.ok(id.length<=128);
  assert.equal(ensureBindingWorkspace(f.store,'p','next','binding',root,201),id);
  const row=f.store.db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
  assert.equal(row.enforcement,'advisory');assert.equal(row.managed,1);
  assert.deepEqual(JSON.parse(row.write_paths_json),['tasks/*']);
  assert.equal(f.store.db.prepare("SELECT policy_json FROM projects WHERE id='p'").get().policy_json,before);
  assert.throws(()=>ensureBindingWorkspace(f.store,'p','task','binding',f.driver.workspaceRoot,202),/WORKSPACE_IDENTITY_CHANGED/);
  assert.throws(()=>ensureBindingWorkspace(f.store,'other','task','binding',root,202),/WORKFLOW_BINDING_REQUIRED/);
  f.store.db.prepare("UPDATE workspaces SET state='unknown' WHERE id=?").run(id);
  assert.throws(()=>ensureBindingWorkspace(f.store,'p','task','binding',root,202),/WORKSPACE_NOT_AVAILABLE/);
});

test('工作区注册失败与准备事务一同回滚；强路径策略明确拒绝且不更改',t=>{
  const f=executionFixture(t),root=path.join(f.dir,'new-role');fs.mkdirSync(root);
  assert.throws(()=>f.store.transaction(()=>{ensureBindingWorkspace(f.store,'p','task','binding',root,200);throw new Error('ROLLBACK_TEST');}),/ROLLBACK_TEST/);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE id LIKE 'binding-ws-%'").get().n,0);
  const policy=JSON.parse(f.store.db.prepare("SELECT policy_json FROM projects WHERE id='p'").get().policy_json);policy.writeIsolation='enforced_paths';
  f.store.db.prepare("UPDATE projects SET policy_json=? WHERE id='p'").run(JSON.stringify(policy));
  assert.throws(()=>ensureBindingWorkspace(f.store,'p','task','binding',root,200),/PATH_ENFORCEMENT_UNAVAILABLE/);
  assert.equal(JSON.parse(f.store.db.prepare("SELECT policy_json FROM projects WHERE id='p'").get().policy_json).writeIsolation,'enforced_paths');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE id LIKE 'binding-ws-%'").get().n,0);
});

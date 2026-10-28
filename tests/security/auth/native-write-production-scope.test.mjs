import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {executionFixture} from './execution-fixture.mjs';
import {createDurableOperation} from '../../../apps/kernel/dist/tools/orchestration-tools.js';
import {beginFactoryWrite} from '../../../apps/kernel/dist/execution/factory-write-scope.js';

for(const mode of ['normal','directory','file','junction'])test(`planned工厂创建目录后固定目标文件身份：${mode}`,t=>{
 const f=executionFixture(t),target=path.join(f.dir,'planned'),preserved=path.join(f.dir,'preserved'),other=path.join(f.dir,'other');
 const operation=createDurableOperation(f.store,{operationKey:'planned',kind:'message.send',projectId:'p',payload:{toRoleId:'worker'}},220);
 const scope=beginFactoryWrite(f.store,{projectId:'p',roleId:'worker',operationId:operation.operationId,workspaceRoot:target,admission:()=>{},now:()=>250});
 const row=f.store.db.prepare('SELECT identity_json,materialized_identity_json FROM native_write_effects WHERE id=?').get(scope.proof.id);assert.notEqual(row.materialized_identity_json,null);assert.notEqual(row.identity_json,row.materialized_identity_json);
 fs.writeFileSync(path.join(target,'protected.txt'),'SYNTHETIC_PROTECTED');let sends=0;
 try{
  if(mode!=='normal'){fs.renameSync(target,preserved);if(mode==='directory')fs.mkdirSync(target);if(mode==='file')fs.writeFileSync(target,'SYNTHETIC_REPLACEMENT');if(mode==='junction'){fs.mkdirSync(other);fs.symlinkSync(other,target,process.platform==='win32'?'junction':'dir');}}
  const send=()=>{scope.assertCanSend();sends++;};
  if(mode==='normal'){send();assert.equal(sends,1);}else {assert.throws(send,/RESERVATION_CHANGED/);assert.equal(sends,0);assert.equal(fs.readFileSync(path.join(preserved,'protected.txt'),'utf8'),'SYNTHETIC_PROTECTED');}
  assert.throws(()=>f.store.db.prepare("UPDATE native_write_effects SET materialized_identity_json='{}' WHERE id=?").run(scope.proof.id),/IDENTITY_IMMUTABLE/);
  const observations=f.store.db.prepare('SELECT materialized_identity_json FROM native_write_effect_observations WHERE effect_id=? ORDER BY sequence').all(scope.proof.id);assert.equal(observations[0].materialized_identity_json,null);assert.ok(observations.some(r=>r.materialized_identity_json!==null));
 }finally{if(mode==='junction')fs.unlinkSync(target);}
});

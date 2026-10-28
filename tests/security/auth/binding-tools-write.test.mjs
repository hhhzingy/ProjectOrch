// 同步配置修复的存储/生产包装器验证，全部为合成来源和本次临时目录。
import test from 'node:test';import assert from 'node:assert/strict';
import {executionFixture} from './execution-fixture.mjs';
import {createDurableOperation,recordStep} from '../../../apps/kernel/dist/tools/orchestration-tools.js';
import {withBindingToolsWrite} from '../../../apps/kernel/dist/execution/factory-write-scope.js';
import {reserveNativeWriteWithin,finishNativeWriteWithin} from '../../../packages/domain/dist/workspaces/index.js';

function fixture(t){
 const f=executionFixture(t),session={...f.session,nativeWorkspaceId:f.driver.workspaceRoot};f.store.db.prepare("UPDATE sessions SET native_workspace_id=? WHERE id='session'").run(f.driver.workspaceRoot);
 const operation=createDurableOperation(f.store,{operationKey:'factory',kind:'message.send',projectId:'p',payload:{toRoleId:'worker'}},200);
 const proof=f.store.transaction(()=>reserveNativeWriteWithin(f.store,{kind:'factory',projectId:'p',roleId:'worker',sourceId:operation.operationId,targetRoot:f.driver.workspaceRoot},210));
 f.store.transaction(()=>finishNativeWriteWithin(f.store,proof,'unknown',{sourceId:operation.operationId,reason:'SYNTHETIC_LOST_RECEIPT'},220));
 const register=(turn='exact-original-turn',overrides={})=>recordStep(f.store,operation.operationId,{step:'binding-registration',state:'observed',detail:JSON.stringify({bindingId:'binding',sessionRef:session,nativeTurnId:turn,charterDelivered:true,...overrides}),at:230},230);
 const run=write=>withBindingToolsWrite(f.store,{projectId:'p',roleId:'worker',operationId:operation.operationId,bindingId:'binding',bindingEpoch:1,workspaceRoot:f.driver.workspaceRoot,admission:()=>{},now:()=>250},write);
 return {...f,register,run,operation};
}
test('没有精确原轮/绑定终态，idle或binding本身不能解旧unknown',t=>{
 const f=fixture(t);let writes=0;assert.throws(()=>f.run(()=>writes++),/FACTORY_PROOF_REQUIRED/);f.register(null);assert.throws(()=>f.run(()=>writes++),/FACTORY_PROOF_REQUIRED/);f.register('exact-original-turn',{bindingId:'different-binding'});assert.throws(()=>f.run(()=>writes++),/FACTORY_PROOF_REQUIRED/);assert.equal(writes,0);assert.equal(f.store.db.prepare('SELECT state FROM native_write_effects').get().state,'unknown');
});
test('原章程终态可关闭原factory效果；同步修复抛错不伪造成功，后续独立本地代次可重试',t=>{
 const f=fixture(t);f.register();let writes=0;
 assert.throws(()=>f.run(()=>{writes++;throw Error('SYNTHETIC_SYNC_FAILURE');}),/SYNTHETIC_SYNC_FAILURE/);
 const rows=f.store.db.prepare('SELECT purpose,state,evidence_json FROM native_write_effects ORDER BY rowid').all();assert.equal(rows[0].state,'settled');assert.equal(rows[1].state,'settled');assert.equal(JSON.parse(rows[1].evidence_json).localWriteSucceeded,false);
 f.run(()=>{writes++;});assert.equal(writes,2);assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM native_write_effects WHERE purpose='binding-tools' AND state='settled'").get().n,2);
 assert.ok(f.store.db.prepare("SELECT 1 FROM native_write_effect_observations WHERE effect_id=(SELECT id FROM native_write_effects WHERE purpose='factory') AND state='unknown'").get(),'原unknown观察保留');
});
test('意外Promise保留本地unknown；旧章程终态不能关闭它或用新代次掩盖，迟到resolve不结算',async t=>{
 const f=fixture(t);f.register();let resolve;
 const late=new Promise(r=>resolve=r);assert.throws(()=>f.run(()=>late),/ASYNC_BINDING_TOOLS_WRITE_UNSUPPORTED/);
 assert.equal(f.store.db.prepare("SELECT state FROM native_write_effects WHERE purpose='binding-tools'").get().state,'unknown');assert.throws(()=>f.run(()=>{}),/LOCAL_RECOVERY_REQUIRED/);
 resolve();await late;await Promise.resolve();assert.equal(f.store.db.prepare("SELECT state FROM native_write_effects WHERE purpose='binding-tools'").get().state,'unknown');
});

test('首次工厂的工具注入若意外异步，同样不能借原章程洗掉本地unknown',async t=>{
 const {beginFactoryWrite}=await import('../../../apps/kernel/dist/execution/factory-write-scope.js'),f=executionFixture(t),session={...f.session,nativeWorkspaceId:f.driver.workspaceRoot};
 f.store.db.prepare("UPDATE sessions SET native_workspace_id=? WHERE id='session'").run(f.driver.workspaceRoot);
 const op=createDurableOperation(f.store,{operationKey:'first-factory',kind:'message.send',projectId:'p',payload:{toRoleId:'worker'}},200),scope=beginFactoryWrite(f.store,{projectId:'p',roleId:'worker',operationId:op.operationId,workspaceRoot:f.driver.workspaceRoot,admission:()=>{},now:()=>250});
 recordStep(f.store,op.operationId,{step:'binding-registration',state:'observed',detail:JSON.stringify({bindingId:'binding',sessionRef:session,nativeTurnId:'original-charter-turn',charterDelivered:true}),at:250},250);
 let resolve;const late=new Promise(r=>resolve=r);
 assert.throws(()=>scope.runBindingTools(()=>late),/ASYNC_BINDING_TOOLS_WRITE_UNSUPPORTED/);scope.fail(Error('ASYNC_BINDING_TOOLS_WRITE_UNSUPPORTED'),true);
 const row=f.store.db.prepare('SELECT state,evidence_json FROM native_write_effects').get();assert.equal(row.state,'unknown');assert.equal(JSON.parse(row.evidence_json).localWriteCompleted,false);
 assert.throws(()=>withBindingToolsWrite(f.store,{projectId:'p',roleId:'worker',operationId:op.operationId,bindingId:'binding',bindingEpoch:1,workspaceRoot:f.driver.workspaceRoot,admission:()=>{},now:()=>260},()=>{}),/LOCAL_RECOVERY_REQUIRED/);
 resolve();await late;assert.equal(f.store.db.prepare('SELECT state FROM native_write_effects').get().state,'unknown');
});

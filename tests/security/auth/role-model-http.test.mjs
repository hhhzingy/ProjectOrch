import test from 'node:test';
import assert from 'node:assert/strict';
import {executionFixture} from './execution-fixture.mjs';
import {startLocalGateway} from '../../../apps/kernel/dist/http/local-gateway.js';
import {issuePairingChallenge} from '../../../apps/kernel/dist/auth/pairing.js';

test('真实HTTP模型轻操作：读取双版本、并发冲突、幂等重放、恢复默认与认证边界',async t=>{
 let gateway;t.after(async()=>{await gateway?.close();});const f=executionFixture(t);gateway=await startLocalGateway({store:f.store,principalId:'synthetic-user'});const origin=gateway.origin.origin;
 const challenge=issuePairingChallenge(f.store);const pair=await fetch(origin+'/api/v1/pairing',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({schemaVersion:2,requestId:'pair',challengeId:challenge.challengeId,oneTimeCode:challenge.oneTimeCode})});assert.equal(pair.status,200);const {csrfToken}=await pair.json();
 const headers={Origin:origin,Cookie:pair.headers.get('set-cookie').split(';')[0],'Content-Type':'application/json','x-projectorch-csrf':csrfToken};
 const read=async()=>{const r=await fetch(origin+'/api/v1/projects/p/roles/worker/model-preference',{headers});assert.equal(r.status,200);return r.json();};
 const post=async(body,h=headers)=>{const r=await fetch(origin+'/api/v1/roles/model-preference',{method:'POST',headers:h,body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 const initial=await read();assert.equal(initial.modelRevision,0);
 const base={schemaVersion:2,projectId:'p',roleId:'worker',expectedRevision:initial.revision,expectedModelRevision:0,modelRequested:'test strict',modelId:'test-model',reasoningLevel:'medium',requestId:'web-one'};
 const first=await post(base);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.modelRevision,1);assert.equal(first.body.revision,initial.revision);
 const races=await Promise.all(['a','b'].map(id=>post({...base,requestId:'race-'+id,expectedModelRevision:1,modelId:'model-'+id})));assert.deepEqual(races.map(r=>r.status).sort(),[200,409]);
 assert.deepEqual(await post(base),first,'旧请求即使配置后来变化仍返回原冻结回执');
 const state=await read();assert.equal(state.modelRevision,2);assert.equal(state.revision,initial.revision);
 const reset=await post({schemaVersion:2,requestId:'web-default',projectId:'p',roleId:'worker',expectedRevision:state.revision,expectedModelRevision:state.modelRevision,resetToDefault:true});assert.equal(reset.status,200);assert.equal(reset.body.modelRequested,null);assert.equal(reset.body.modelResolved,null);
 const missingVersion={...base,requestId:'old-client'};delete missingVersion.expectedModelRevision;assert.equal((await post(missingVersion)).status,400);
 const oversized=await post({...base,requestId:'oversized',expectedModelRevision:3,modelId:'x'.repeat(129)});assert.equal(oversized.status,400,'拒绝超长模型ID，不截断替换');
 const denied=await post({...base,requestId:'bad-csrf',expectedModelRevision:3},{...headers,'x-projectorch-csrf':'invalid'});assert.equal(denied.status,401);
 assert.equal((await read()).modelRevision,3);assert.equal(f.calls,0,'配置端点不运行模型');
});

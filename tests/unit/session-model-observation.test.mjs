import assert from 'node:assert/strict';
import test from 'node:test';
import {zcodeSessionModelObservation} from '../../apps/kernel/dist/native/session-model-observation.js';

test('会话模型观察拒绝模型目录、模型自报和错会话，不能用JSON首个modelId认定当前模型',()=>{
 const resume={sessionId:'owned'},foreign={session:{sessionId:'other'},settings:{model:{current:{modelId:'other-model'}}}};
 assert.equal(zcodeSessionModelObservation(resume,foreign,'owned'),null);
 assert.equal(zcodeSessionModelObservation({}, {session:{sessionId:'owned'},modelId:'catalog-model'},'owned'),null);
 assert.equal(zcodeSessionModelObservation({sessionId:'owned',session:{sessionId:'other'}},{session:{sessionId:'owned'}},'owned'),null);
 assert.deepEqual(zcodeSessionModelObservation(resume,{session:{sessionId:'owned'},catalog:[{modelId:'catalog',providerId:'foreign'}],messages:[{text:'我使用模型X'}]},'owned'),{sessionId:'owned',model:null});
});
test('会话身份和模型观察分别核对，只有精确current字段作为观察，不猜推理强度',()=>{
 const read={session:{sessionId:'owned'},modelId:'decoy',settings:{model:{current:{modelId:'actual',providerId:'provider',options:{reasoningLevel:'medium'}}}}};
 assert.deepEqual(zcodeSessionModelObservation({session:{sessionId:'owned'}},read,'owned'),{sessionId:'owned',model:{modelId:'actual',providerId:'provider',reasoningLevel:'medium'}});
 assert.deepEqual(zcodeSessionModelObservation({id:'owned'},{session:{sessionId:'owned'},settings:{model:{current:{modelId:'actual'}}}},'owned'),{sessionId:'owned',model:{modelId:'actual',providerId:null,reasoningLevel:null}});
 assert.equal(zcodeSessionModelObservation({id:'owned'},{session:{sessionId:'owned'},settings:{model:{current:{modelId:'actual',providerId:'bad\nprovider'}}}},'owned'),null);
});

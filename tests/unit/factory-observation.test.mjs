import test from 'node:test';import assert from 'node:assert/strict';
import {codexCharterProof} from '../../apps/kernel/dist/native/factory-observation.js';
const session={harnessId:'codex',hostId:'synthetic',profileId:'test',nativeConversationId:'original'},input='原章程\n唯一确认标记',marker='ACK_ORIGINAL';
const snapshot=()=>({thread:{id:'original',status:{type:'notLoaded'},turns:[{id:'exact-turn',status:'completed',items:[{type:'userMessage',content:[{type:'text',text:input}]},{type:'agentMessage',text:marker}]}]}});
test('工厂恢复证明绑定精确原线程/唯一章程/原终态/确认标记，不依赖助手自报身份',()=>{
 const proof=codexCharterProof(snapshot(),session,input,marker);assert.equal(proof.executionId,'exact-turn');assert.equal(proof.terminalConfirmed,true);assert.match(proof.inputSha256,/^[a-f0-9]{64}$/);assert.equal(JSON.stringify(proof).includes(input),false);
 for(const mutate of [s=>{s.thread.id='other';},s=>{s.thread.status.type='active';},s=>{delete s.thread.status;},s=>{s.thread.status.type='systemError';},s=>{s.thread.turns[0].status='failed';},s=>{s.thread.turns[0].items[0].content[0].text='different';},s=>{s.thread.turns[0].items[1].text='I am original';},s=>{s.thread.turns.push(structuredClone(s.thread.turns[0]));},s=>{s.thread.turns.push({id:'other',status:'inProgress'});}]){const s=snapshot();mutate(s);assert.equal(codexCharterProof(s,session,input,marker),null);}
});
import {sessionQuiescent} from '../../apps/kernel/dist/native/factory-observation.js';

test('换绑静止观察拒绝仅身份可读、忙碌、未知状态、缺失数组及错原生ID',()=>{
 const codex={thread:{id:'s',status:{type:'idle'},turns:[{status:'completed'}]}},zcode={session:{sessionId:'s',status:'idle'},projection:{sessionId:'s',status:'idle',activeToolCalls:[],pendingPermissions:[]}};
 assert.equal(sessionQuiescent('codex',codex,'s'),true);assert.equal(sessionQuiescent('zcode',zcode,'s'),true);
 for(const snapshot of [{thread:{id:'s'}},{thread:{...codex.thread,status:{type:'active'}}},{thread:{...codex.thread,turns:[{status:'inProgress'}]}}])assert.equal(sessionQuiescent('codex',snapshot,'s'),false);
 for(const mutate of [s=>delete s.projection.activeToolCalls,s=>s.projection.pendingPermissions.push('approval'),s=>s.projection.activeToolCalls.push('tool'),s=>s.session.status='busy',s=>s.projection.sessionId='other']){const snapshot=structuredClone(zcode);mutate(snapshot);assert.equal(sessionQuiescent('zcode',snapshot,'s'),false);}
 assert.equal(sessionQuiescent('zcode',zcode,'other'),false);assert.equal(sessionQuiescent('codex',codex,'other'),false);assert.equal(sessionQuiescent('unsupported',zcode,'s'),false);
});

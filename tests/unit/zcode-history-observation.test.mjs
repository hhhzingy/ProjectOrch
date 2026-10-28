import test from 'node:test';import assert from 'node:assert/strict';
import {zcodeHistoryTerminal} from '../../apps/kernel/dist/native/zcode-history-observation.js';
test('精确turn的用户输入+最终助手边界+官方idle才确认，错会话/工具中间轮/不完整历史拒绝',()=>{
 const snapshot={session:{sessionId:'s',status:'idle'},projection:{sessionId:'s',status:'idle',activeToolCalls:[],pendingPermissions:[]}};
 const messages={messages:[{info:{id:'u',sessionID:'s',role:'user',anchor:{turnId:'t'}}},{info:{id:'a',sessionID:'s',role:'assistant',finish:'stop',time:{completed:100},anchor:{turnId:'t',orderedMessageIds:['u','a'],boundaryMessageId:'u',goalBoundary:{kind:'none'}}}}]};
 assert.equal(zcodeHistoryTerminal(snapshot,messages,'s','t'),'completed');
 for(const mutate of [x=>x.session.status='running',x=>x.projection.activeToolCalls.push('tool'),x=>x.projection.pendingPermissions.push('approval'),x=>x.projection.sessionId='other']){const x=structuredClone(snapshot);mutate(x);assert.equal(zcodeHistoryTerminal(x,messages,'s','t'),null);}
 for(const mutate of [x=>x.messages[1].info.finish='tool-calls',x=>x.messages[1].info.anchor.turnId='other',x=>delete x.messages[1].info.time.completed,x=>delete x.messages[1].info.anchor.orderedMessageIds,x=>x.messages.shift(),x=>x.messages.push(structuredClone(x.messages[1]))]){const x=structuredClone(messages);mutate(x);assert.equal(zcodeHistoryTerminal(snapshot,x,'s','t'),null);}
 assert.equal(zcodeHistoryTerminal(snapshot,messages,'s','unknown'),null);
});

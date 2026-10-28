import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { createProject } from '../../../packages/domain/dist/projects/index.js';
import { createRole } from '../../../packages/domain/dist/roles/index.js';
import { sendMessage } from '../../../packages/domain/dist/messages/index.js';
import { issuePairingChallenge } from '../../../apps/kernel/dist/auth/pairing.js';
import { ingestNativeItems } from '../../../packages/domain/dist/conversation/index.js';
import { startLocalGateway } from '../../../apps/kernel/dist/http/local-gateway.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';

function rawRequest(port, method, target, headers, body = null) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path: target, headers }, response => {
      const chunks = [];
      response.on('data', c => chunks.push(c));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8'), setCookie: response.headers['set-cookie'] ?? [] }));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

async function fixture(t,readConversation) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-conv-endpoint-', () => { for (const s of stores) s.close(); });
  const filename = path.join(dir, 'state.sqlite');
  const store = openStore(filename);
  stores.push(store);
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: 'E:/synthetic/cv', objective: 'o' }, 100);
  createRole(store, { id: 'r1', projectId: 'p1', name: 'r', charter: 'c', permissionProfileId: 'worker' }, 101);
  store.transaction(db => {
    db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES('s-codex','codex','h','p','n1')").run();
    db.prepare("INSERT INTO commands(id,project_id,source_principal_id,request_id,request_hash,type,payload_json,state,created_at) VALUES('c1','p1','u','rq1',?,'project.pause','{}','completed',100)").run('0'.repeat(64));
  });
  const gateway = await startLocalGateway({ store, principalId: 'synthetic-local-user',...(readConversation?{readConversation}:{}) });
  t.after(() => { void gateway.close(); });
  const authority = `127.0.0.1:${gateway.port}`;
  const origin = `http://${authority}`;
  const challenge = issuePairingChallenge(store);
  const paired = await rawRequest(gateway.port, 'POST', '/api/v1/pairing', { Host: authority, Origin: origin, 'Content-Type': 'application/json' }, JSON.stringify({ schemaVersion: 2, requestId: 'pair', challengeId: challenge.challengeId, oneTimeCode: challenge.oneTimeCode }));
  const cookie = /projectorch_session=([^;]+)/.exec(paired.setCookie.find(c => c.startsWith('projectorch_session=')) ?? '')[1];
  const csrf = JSON.parse(paired.body).csrfToken;
  return { store, gateway, authority, origin, cookie, csrf };
}

test('对话面板端点：会话鉴权+native投影分页；未认证401；未知会话404（T044准备）', async t => {
  const { store, gateway, authority, origin, cookie, csrf } = await fixture(t);
  ingestNativeItems(store, 's-codex', { epoch: 'e1', cursor: 'rev-1', snapshotRevision: null, items: [{ itemId: 'item-1', revision: 'rev-1', occurredAt: 100, kind: 'turn', content: { text: '原生轮次' } }] }, 120);
  const headers = { Host: authority, Origin: origin, Cookie: `projectorch_session=${cookie}` };
  const res = await rawRequest(gateway.port, 'GET', '/api/v1/conversation?sessionId=s-codex', headers);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].itemId, 'item-1');
  assert.equal(body.gapDetected, false);
  // 未认证401
  assert.equal((await rawRequest(gateway.port, 'GET', '/api/v1/conversation?sessionId=s-codex', { Host: authority, Origin: origin })).status, 401);
  // 未知会话404
  assert.equal((await rawRequest(gateway.port, 'GET', '/api/v1/conversation?sessionId=s-missing', headers)).status, 404);
  void csrf;
});

test('角色正文：认证后按当前绑定读取，分页快照不重读，绑定变更拒绝旧分页',async t=>{
 let reads=0;
 const f=await fixture(t,async(session,guard)=>{reads++;guard();assert.equal(session.nativeConversationId,'n1');return{items:Array.from({length:35},(_,i)=>({id:'item-'+i,role:'assistant',text:'仅本角色正文'+i})),limited:false};});
 f.store.db.exec("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b','p1','r1','s-codex',1,101)");
 const target='/api/v1/projects/p1/roles/r1/conversation',headers={Host:f.authority,Origin:f.origin,Cookie:`projectorch_session=${f.cookie}`};
 assert.equal((await rawRequest(f.gateway.port,'GET',target,{Host:f.authority,Origin:f.origin})).status,401);assert.equal(reads,0);
 const first=JSON.parse((await rawRequest(f.gateway.port,'GET',target,headers)).body);assert.equal(first.items.length,30);assert.equal(first.items[0].text,'仅本角色正文0');assert.ok(first.nextCursor);assert.equal(reads,1);
 const next=JSON.parse((await rawRequest(f.gateway.port,'GET',target+'?cursor='+encodeURIComponent(first.nextCursor),headers)).body);assert.equal(next.items.length,5);assert.equal(next.nextCursor,null);assert.equal(reads,1);
 assert.equal((await rawRequest(f.gateway.port,'GET','/api/v1/projects/missing/roles/r1/conversation',headers)).status,404);
 f.store.db.exec("UPDATE role_bindings SET ended_at=200 WHERE id='b';INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b2','p1','r1','s-codex',2,201)");
 const stale=await rawRequest(f.gateway.port,'GET',target+'?cursor='+encodeURIComponent(first.nextCursor),headers);assert.equal(stale.status,503);assert.match(stale.body,/REFRESH_REQUIRED/);assert.equal(reads,1);
});

test('异步历史读取期间换绑，旧正文不得返回；未绑定明确提示',async t=>{
 let release,started;
 const start=new Promise(r=>started=r),result=new Promise(r=>release=r),f=await fixture(t,async()=>{started();await result;return{items:[{id:'sensitive-old',role:'user',text:'OLD_BODY_MUST_NOT_RETURN'}],limited:false};});
 const target='/api/v1/projects/p1/roles/r1/conversation',headers={Host:f.authority,Origin:f.origin,Cookie:`projectorch_session=${f.cookie}`};
 const unbound=JSON.parse((await rawRequest(f.gateway.port,'GET',target,headers)).body);assert.equal(unbound.status,'unbound');
 f.store.db.exec("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b','p1','r1','s-codex',1,101)");
 const pending=rawRequest(f.gateway.port,'GET',target,headers);await start;f.store.db.exec("UPDATE role_bindings SET ended_at=200 WHERE id='b'");release();
 const response=await pending;assert.equal(response.status,503);assert.doesNotMatch(response.body,/OLD_BODY/);
});

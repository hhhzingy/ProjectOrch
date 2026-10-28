import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore } from '../../../packages/persistence/dist/index.js';
import { issueAgentCredential, authenticateAgentCredential, revokeBindingCredentials } from '../../../apps/kernel/dist/auth/agent-credential.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';
function fixture(t) {
  const stores=[]; const dir=temporaryDirectory(t,'projectorch-agent-credential-',()=>{for(const s of stores)s.close();});
  const filename=path.join(dir,'state.sqlite');const open=()=>{const s=openStore(filename);stores.push(s);return s;};const store=open();
  store.transaction(db=>{
    for(const n of [1,2]){
      db.prepare("INSERT INTO projects(id,name,host_id,canonical_root,objective,created_at) VALUES(?,?,?,?,?,0)").run(`p${n}`,`synthetic ${n}`,'host',`synthetic-root-${n}`,'test');
      db.prepare("INSERT INTO roles(id,project_id,name,charter,permission_profile,desired_state,binding_state) VALUES(?,?,?,?,?,'enabled','ready')").run(`r${n}`,`p${n}`,'synthetic','test','worker');
      db.prepare("INSERT INTO sessions(id,harness_id,host_id,profile_id,native_conversation_id) VALUES(?,?,?,?,?)").run(`s${n}`,'synthetic','host','profile',`native-${n}`);
      db.prepare("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES(?,?,?,?,1,100)").run(`b${n}`,`p${n}`,`r${n}`,`s${n}`);
    }
  });
  return {store,open};
}
const ref=n=>({harnessId:'synthetic',hostId:'host',profileId:'profile',nativeConversationId:`native-${n}`});
const issue=(store,n=1,now=100)=>issueAgentCredential(store,`b${n}`,1,{isolation:'verified_session',session:ref(n)},now,1000);

test('凭据身份来自持久绑定，跨项目隔离，仅存摘要，重启后继续核验',t=>{
  const f=fixture(t);const a=issue(f.store);const b=issue(f.store,2);
  const principal=authenticateAgentCredential(f.store,a.credential,101);
  assert.equal(principal.roleId,'r1');assert.equal(principal.projectId,'p1');assert.equal(principal.bindingEpoch,1);assert.deepEqual(principal.session,ref(1));
  assert.ok(Object.isFrozen(principal));assert.ok(Object.isFrozen(principal.session));
  assert.equal(authenticateAgentCredential(f.store,b.credential,101).roleId,'r2');
  const rows=JSON.stringify(f.store.db.prepare('SELECT * FROM agent_credentials').all());
  for(const c of [a,b])assert.equal(rows.includes(c.credential.split('.')[1]),false);
  assert.equal(JSON.stringify(principal).includes(a.credential),false);
  for(const invalid of [null,'bad',`${a.credential}x`,`${b.credential.split('.')[0]}.${a.credential.split('.')[1]}`])assert.throws(()=>authenticateAgentCredential(f.store,invalid,101),/AGENT_UNAUTHENTICATED/);
  f.store.close();assert.equal(authenticateAgentCredential(f.open(),a.credential,101).bindingId,'b1');
});

test('未隔离主机、错误会话/代次、未绑定/异常及无效时钟不颁发；写入失败不留凭据',t=>{
  const {store}=fixture(t);
  for(const connection of [{isolation:'shared',session:ref(1)},{isolation:'verified_session',session:ref(2)}])assert.throws(()=>issueAgentCredential(store,'b1',1,connection,100),/ISSUANCE_REJECTED/);
  assert.throws(()=>issueAgentCredential(store,'b1',2,{isolation:'verified_session',session:ref(1)},100),/ISSUANCE_REJECTED/);
  assert.throws(()=>issue(store,1,99),/ISSUANCE_REJECTED/);
  for (const state of ['unbound','error']) { store.db.prepare("UPDATE roles SET binding_state=? WHERE id='r1'").run(state); assert.throws(()=>issue(store),/ISSUANCE_REJECTED/); }
  store.db.exec("UPDATE roles SET binding_state='ready' WHERE id='r1'");
  store.db.exec("CREATE TRIGGER synthetic_agent_failure BEFORE INSERT ON agent_credentials BEGIN SELECT RAISE(ABORT,'SYNTHETIC_INSERT_FAILURE'); END");
  assert.throws(()=>issue(store),/SYNTHETIC_INSERT_FAILURE/);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM agent_credentials').get().n,0);
});

test('到期/撤销即拒绝，旧绑定结束后新代次可用，旧凭据不能影响新身份',t=>{
  const {store}=fixture(t);const old=issue(store);const other=issue(store,2);
  assert.throws(()=>authenticateAgentCredential(store,old.credential,99),/UNAUTHENTICATED/);
  assert.throws(()=>authenticateAgentCredential(store,old.credential,1100),/UNAUTHENTICATED/);
  assert.throws(()=>revokeBindingCredentials(store,'b1',99),/INVALID_AGENT_TIME/);
  store.transaction(db=>{db.exec("UPDATE role_bindings SET ended_at=101 WHERE id='b1'");db.exec("INSERT INTO role_bindings(id,project_id,role_id,session_id,epoch,started_at) VALUES('b3','p1','r1','s1',2,101)");});
  assert.throws(()=>authenticateAgentCredential(store,old.credential,102),/UNAUTHENTICATED/);
  const next=issueAgentCredential(store,'b3',2,{isolation:'verified_session',session:ref(1)},102,1000);
  revokeBindingCredentials(store,'b1',103);assert.equal(authenticateAgentCredential(store,next.credential,104).bindingEpoch,2);
  revokeBindingCredentials(store,'b3',104);assert.throws(()=>authenticateAgentCredential(store,next.credential,104),/UNAUTHENTICATED/);
  assert.equal(authenticateAgentCredential(store,other.credential,104).roleId,'r2');
});

test('数据库中原生目标被改写或角色停用，已有凭据也不能沿用',t=>{
  const {store}=fixture(t);const a=issue(store);
  store.db.exec("UPDATE sessions SET native_conversation_id='different-native' WHERE id='s1'");assert.throws(()=>authenticateAgentCredential(store,a.credential,101),/UNAUTHENTICATED/);
  store.db.exec("UPDATE sessions SET native_conversation_id='native-1' WHERE id='s1'; UPDATE roles SET desired_state='disabled' WHERE id='r1'");assert.throws(()=>authenticateAgentCredential(store,a.credential,101),/UNAUTHENTICATED/);
});

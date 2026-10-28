import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {executionFixture} from './execution-fixture.mjs';
import {verifiedBindingCredential} from '../../../apps/kernel/dist/auth/binding-credentials.js';

test('发送前重查绑定凭据不会自动续发被用户撤销的凭据',t=>{
  const f=executionFixture(t);const file=path.join(f.dir,'private-binding-cache.json');
  const token=verifiedBindingCredential(f.store,file,'binding',f.session,1,300);
  const id=token.split('.')[0];f.store.db.prepare('UPDATE agent_credentials SET revoked_at=310 WHERE id=?').run(id);
  const before=f.store.db.prepare('SELECT COUNT(*) AS n FROM agent_credentials').get().n;
  assert.throws(()=>verifiedBindingCredential(f.store,file,'binding',f.session,1,320),/AGENT_CREDENTIAL_REVOKED/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM agent_credentials').get().n,before);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { openStore, defaultMigrations } from '../../../packages/persistence/dist/index.js';
import { issuePairingChallenge } from '../../../apps/kernel/dist/auth/pairing.js';
import { localOrigin } from '../../../apps/kernel/dist/auth/local-source.js';
import { completeBrowserPairing, authenticateBrowserSession, revokeBrowserSession, browserSessionCookie } from '../../../apps/kernel/dist/auth/browser-session.js';
import { temporaryDirectory } from '../../adapters/temporary-directory.mjs';
const source = (() => { const config = localOrigin('http://127.0.0.1:43210'); return { config, peerAddress: '127.0.0.1', rawHeaders: ['Host', config.authority, 'Origin', config.origin, 'Content-Type', 'application/json'] }; })();
function fixture(t) {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-browser-session-', () => { for (const store of stores) store.close(); }); const filename = path.join(dir, 'state.sqlite');
  const open = options => { const store = openStore(filename, options); stores.push(store); return store; };
  return { dir, open, store: open() };
}
const request = challenge => ({ schemaVersion: 2, requestId: 'synthetic-browser-pair', challengeId: challenge.challengeId, oneTimeCode: challenge.oneTimeCode });
function pair(store, now = 100, user = 'synthetic-local-user', ttl = 1000) {
  const challenge = issuePairingChallenge(store, now); const result = completeBrowserPairing(store, request(challenge), user, source, now, ttl);
  assert.equal(result.accepted, true); return { challenge, input: request(challenge), credentials: result.credentials };
}

test('挑战消费与浏览器会话同事务，库中仅摘要，读写/SSE均需有效凭据', t => {
  const { store } = fixture(t); const paired = pair(store); const c = paired.credentials;
  const database = JSON.stringify(store.db.prepare('SELECT * FROM browser_sessions').all());
  for (const secret of [c.cookieValue.split('.')[1], c.csrfToken, paired.challenge.oneTimeCode]) assert.equal(database.includes(secret), false);
  for (const mode of ['read', 'events', 'write']) {
    const principal = authenticateBrowserSession(store, c.cookieValue, mode === 'write' ? c.csrfToken : null, mode, 101);
    assert.equal(principal.kind, 'authenticated_user'); assert.equal(principal.principalId, 'synthetic-local-user'); assert.ok(Object.isFrozen(principal));
    assert.throws(() => authenticateBrowserSession(store, undefined, null, mode, 101), /UNAUTHENTICATED/);
  }
  assert.deepEqual(completeBrowserPairing(store, paired.input, 'synthetic-local-user', source, 101), { accepted: false });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM browser_sessions').get().n, 1);
  const cookie = browserSessionCookie(c, true); assert.ok(cookie.includes('; HttpOnly; SameSite=Strict; Secure')); assert.equal(cookie.includes('Domain='), false);
});
test('CSRF绑定到当前会话，错值/混用/到期/撤销均拒绝，重开数据库仍有效', t => {
  const f = fixture(t); const first = pair(f.store); const second = pair(f.store);
  const c = first.credentials;
  assert.throws(() => authenticateBrowserSession(f.store, c.cookieValue, c.csrfToken, 'write', 99), /UNAUTHENTICATED/);
  for (const csrf of [null, 'wrong', second.credentials.csrfToken, c.cookieValue.split('.')[1]]) assert.throws(() => authenticateBrowserSession(f.store, c.cookieValue, csrf, 'write', 101), /CSRF_REJECTED/);
  assert.throws(() => authenticateBrowserSession(f.store, `${c.cookieValue}x`, c.csrfToken, 'read', 101), /UNAUTHENTICATED/);
  f.store.close(); const reopened = f.open();
  const principal = authenticateBrowserSession(reopened, c.cookieValue, null, 'read', 101);
  assert.throws(() => authenticateBrowserSession(reopened, c.cookieValue, c.csrfToken, 'write', 1100), /UNAUTHENTICATED/);
  revokeBrowserSession(reopened, principal, 102);
  for (const mode of ['read', 'write', 'events']) assert.throws(() => authenticateBrowserSession(reopened, c.cookieValue, c.csrfToken, mode, 103), /UNAUTHENTICATED/);
  assert.equal(authenticateBrowserSession(reopened, second.credentials.cookieValue, null, 'events', 103).principalId, 'synthetic-local-user');
});
test('会话写入失败回滚挑战消费，错误挑战计数提交，非法来源不消耗挑战', t => {
  const { store } = fixture(t); const challenge = issuePairingChallenge(store, 100); const input = request(challenge);
  store.db.exec("CREATE TRIGGER synthetic_browser_failure BEFORE INSERT ON browser_sessions BEGIN SELECT RAISE(ABORT,'SYNTHETIC_INSERT_FAILURE'); END");
  assert.throws(() => completeBrowserPairing(store, input, 'synthetic-local-user', source, 101), /SYNTHETIC_INSERT_FAILURE/);
  assert.equal(store.db.prepare('SELECT consumed_at FROM pairing_challenges WHERE id=?').get(challenge.challengeId).consumed_at, null);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM browser_sessions').get().n, 0);
  store.db.exec('DROP TRIGGER synthetic_browser_failure');
  assert.throws(() => completeBrowserPairing(store, input, 'synthetic-local-user', { ...source, peerAddress: '192.168.1.1' }, 101), /PAIRING_SOURCE_REJECTED/);
  assert.deepEqual(completeBrowserPairing(store, { ...input, oneTimeCode: 'wrong' }, 'synthetic-local-user', source, 101), { accepted: false });
  assert.equal(store.db.prepare('SELECT failed_attempts FROM pairing_challenges WHERE id=?').get(challenge.challengeId).failed_attempts, 1);
  assert.equal(completeBrowserPairing(store, input, 'synthetic-local-user', source, 102).accepted, true);
});
test('v2库升级保留原项目和挑战；非法时间/TTL/身份不消费挑战', t => {
  let upgraded;
  const dir = temporaryDirectory(t, 'projectorch-browser-upgrade-', () => upgraded?.close()); const filename = path.join(dir, 'state.sqlite');
  const old = openStore(filename, { migrations: defaultMigrations().slice(0, 2) });
  old.db.prepare('INSERT INTO projects(id,name,host_id,canonical_root,objective,created_at) VALUES(?,?,?,?,?,?)').run('synthetic-project', 'synthetic', 'host', 'E:/synthetic-only', 'synthetic', 100);
  const challenge = issuePairingChallenge(old, 100); old.close();
  upgraded = openStore(filename);
  assert.equal(upgraded.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 1);
  assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version, defaultMigrations().length); assert.ok(upgraded.migrationBackup);
  for (const ttl of [0, -1, 86400001, 1.5]) assert.throws(() => completeBrowserPairing(upgraded, request(challenge), 'synthetic-user', source, 101, ttl), /INVALID_BROWSER_TTL/);
  assert.throws(() => completeBrowserPairing(upgraded, request(challenge), '', source, 101), /INVALID_LOCAL_USER_ID/);
  assert.equal(completeBrowserPairing(upgraded, request(challenge), 'synthetic-user', source, 101).accepted, true);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeSessionLease } from '../../apps/kernel/dist/native/session-lease.js';
import { temporaryDirectory } from './temporary-directory.mjs';
const ref = { harnessId: 'synthetic', hostId: 'synthetic-host', profileId: 'synthetic-profile', nativeConversationId: 'synthetic-id' };
test('启动器可准备缺失目录；文件和目录链接拒绝且不穿过链接创建',t=>{
 const dir=directory(t),target=path.join(dir,'nested','leases');
 NativeSessionLease.prepareDirectory(target);NativeSessionLease.assertDirectory(target);
 const file=path.join(dir,'file');fs.writeFileSync(file,'user asset');
 assert.throws(()=>NativeSessionLease.prepareDirectory(path.join(file,'child')),/UNSAFE_LEASE_DIRECTORY/);
 const link=path.join(dir,'junction');fs.symlinkSync(target,link,'junction');
 try {
   assert.throws(()=>NativeSessionLease.prepareDirectory(path.join(link,'must-not-create')),/UNSAFE_LEASE_DIRECTORY/);
   assert.equal(fs.existsSync(path.join(target,'must-not-create')),false);
 } finally {fs.unlinkSync(link);}
});
function directory(t) { return temporaryDirectory(t, 'projectorch-lease-'); }
function child(dir, session) {
  const p = fork(fileURLToPath(new URL('./session-lease-worker.mjs', import.meta.url)), [dir, JSON.stringify(session)], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  const exit = new Promise(resolve => p.once('exit', resolve));
  const next = () => new Promise(resolve => p.once('message', resolve));
  return { p, exit, next, initial: next() };
}
test('独立进程并发owner拒绝，同ID改工作区不绕过占位，退出释放后才能接管', async t => {
  const dir = directory(t); const first = child(dir, ref);
  t.after(async () => { if (first.p.connected) first.p.send('release'); await first.exit; });
  assert.equal((await first.initial).status, 'acquired');
  const second = child(dir, { ...ref, nativeWorkspaceId: 'other-workspace' });
  assert.equal((await second.initial).status, 'NATIVE_OWNER_OCCUPIED'); await second.exit;
  const released = first.next(); first.p.send('release'); assert.equal((await released).status, 'released'); await first.exit;
  const next = NativeSessionLease.acquire(dir, ref); next.releaseAfterExit(true);
});
test('owner崩溃后持久占位不自动抢占，其他会话可独立获取', async t => {
  const dir = directory(t); const first = child(dir, ref);
  assert.equal((await first.initial).status, 'acquired'); first.p.send('crash'); await first.exit;
  assert.throws(() => NativeSessionLease.acquire(dir, ref), /NATIVE_OWNER_OCCUPIED/);
  const other = NativeSessionLease.acquire(dir, { ...ref, nativeConversationId: 'different' }); other.releaseAfterExit(true);
  assert.equal(fs.readdirSync(dir).length, 1);
});

test('精确终态+已退出原owner才能受控回收；活owner/错会话/未知终态拒绝',async t=>{
 const dir=directory(t),first=child(dir,ref);await first.initial;
 const proof={session:ref,executionId:'native-turn',status:'completed',terminalConfirmed:true};
 assert.throws(()=>NativeSessionLease.recoverAfterTerminal(dir,ref,proof),/NATIVE_OWNER_STILL_ALIVE/);
 first.p.send('crash');await first.exit;
 assert.throws(()=>NativeSessionLease.recoverAfterTerminal(dir,ref,{...proof,status:'unknown'}),/LEASE_TERMINAL_PROOF_REQUIRED/);
 assert.throws(()=>NativeSessionLease.recoverAfterTerminal(dir,ref,{...proof,session:{...ref,nativeConversationId:'other'}}),/LEASE_TERMINAL_PROOF_REQUIRED/);
 assert.throws(()=>NativeSessionLease.acquire(dir,ref),/NATIVE_OWNER_OCCUPIED/);
 NativeSessionLease.recoverAfterTerminal(dir,ref,proof);
 const next=NativeSessionLease.acquire(dir,ref);next.releaseAfterExit(true);
 assert.deepEqual(fs.readdirSync(dir),[]);
});
test('未确认退出不能释放，重复释放拒绝，非法目录拒绝', t => {
  const dir = directory(t); const lease = NativeSessionLease.acquire(dir, ref);
  assert.throws(() => lease.releaseAfterExit(false), /LEASE_RELEASE_FORBIDDEN/);
  assert.throws(() => NativeSessionLease.acquire(dir, ref), /NATIVE_OWNER_OCCUPIED/);
  lease.releaseAfterExit(true); assert.throws(() => lease.releaseAfterExit(true), /LEASE_RELEASE_FORBIDDEN/);
  assert.throws(() => NativeSessionLease.acquire('relative', ref), /LOCAL_LEASE_DIRECTORY_REQUIRED/);
});

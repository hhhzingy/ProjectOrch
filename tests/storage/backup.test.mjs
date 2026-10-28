import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { defaultMigrations, openStore } from '../../packages/persistence/dist/index.js';
import { backupStore, verifyBackup, restoreFromBackup } from '../../packages/persistence/dist/backup.js';
import { createProject, readProject } from '../../packages/domain/dist/projects/index.js';
import { temporaryDirectory } from '../adapters/temporary-directory.mjs';

test('备份→校验→恢复全链：WAL下一致快照、恢复覆盖、失败路径不破坏主库', t => {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-backup-', () => { for (const s of stores) if (!s.closed) s.close(); });
  const mainPath = path.join(dir, 'state.sqlite');
  const track = store => { stores.push(store); return store; };
  // 阶段一：写入数据A
  const storeA = track(openStore(mainPath));
  createProject(storeA, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: 'E:/synthetic/bak', objective: '阶段一目标' }, 100);
  storeA.close();
  // 备份（文件级：以只读方式打开做VACUUM INTO）
  const readonlyA = track(openStore(mainPath));
  const backupPath = path.join(dir, 'backup.sqlite');
  const backup = backupStore(readonlyA, backupPath, 1000);
  assert.equal(backup.userVersion, defaultMigrations().length, '迁移版本入备份');
  assert.ok(backup.tables >= 20);
  readonlyA.close();
  const verification = verifyBackup(backupPath);
  assert.equal(verification.integrity, true);
  assert.equal(verification.foreignKeyViolations, 0);
  assert.equal(verification.userVersion, verification.expectedUserVersion);
  // 阶段二：主库继续演进（数据B）
  const storeB = track(openStore(mainPath));
  createProject(storeB, { id: 'p2', name: 'b', hostId: 'h', canonicalRoot: 'E:/synthetic/bak2', objective: '阶段二目标' }, 200);
  storeB.close();
  // 恢复到备份点：p2消失、p1回来
  const restored = restoreFromBackup(backupPath, mainPath, 2000);
  assert.equal(restored.restored, true);
  assert.ok(restored.prerollbackCopy !== null, '原文件保留.prerestore副本');
  const storeC = track(openStore(mainPath));
  assert.equal(readProject(storeC, 'p1').objective, '阶段一目标', '恢复到备份点');
  assert.throws(() => readProject(storeC, 'p2'), /PROJECT_NOT_FOUND/, '备份点后数据随恢复消失');
  assert.ok(fs.statSync(restored.prerollbackCopy).size > 0, '.prerestore副本可用于人工回退');
  // 目标已存在拒绝
  assert.throws(() => backupStore(storeC, backupPath, 3000), /BACKUP_TARGET_EXISTS/);
});

test('失败路径：损坏备份与打开中的主库拒绝恢复且主库不破坏', t => {
  const stores = [];
  const dir = temporaryDirectory(t, 'projectorch-backup-fail-', () => { for (const s of stores) if (!s.closed) s.close(); });
  const mainPath = path.join(dir, 'state.sqlite');
  const store = openStore(mainPath);
  stores.push(store);
  createProject(store, { id: 'p1', name: 'a', hostId: 'h', canonicalRoot: 'E:/synthetic/bakf', objective: '完好数据' }, 100);
  // 损坏备份文件
  const badBackup = path.join(dir, 'bad.sqlite');
  fs.writeFileSync(badBackup, 'not a database');
  assert.throws(() => verifyBackup(badBackup), Error);
  assert.throws(() => restoreFromBackup(badBackup, mainPath, 1000), /MAIN_STORE_APPEARS_OPEN|BACKUP_VERIFY_FAILED/, '打开中主库优先拒绝；损坏备份在关闭状态下同样拒绝');
  assert.equal(readProject(store, 'p1').objective, '完好数据', '失败恢复不破坏主库');
  // 打开中的主库（存在-wal/-shm）拒绝恢复
  const goodBackup = path.join(dir, 'good.sqlite');
  backupStore(store, goodBackup, 1000);
  assert.throws(() => restoreFromBackup(goodBackup, mainPath, 1000), /MAIN_STORE_APPEARS_OPEN/, '主库打开中拒绝恢复');
  assert.equal(readProject(store, 'p1').objective, '完好数据');
});

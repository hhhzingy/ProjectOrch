import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
/** 只清理本测试生成的直接子目录；删除前验证绝对边界和全树无重解析路径。 */
export function temporaryDirectory(t, prefix, beforeCleanup = () => {}) {
  // Windows runner 的 TEMP 可为 RUNNER~1 短路径；与生产规范身份使用相同的原生解析。
  const parent = fs.realpathSync.native(os.tmpdir());
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, prefix)));
  t.after(() => {
    beforeCleanup();
    const resolved = fs.realpathSync.native(directory);
    if (resolved !== directory || path.dirname(resolved) !== parent || !path.basename(resolved).startsWith(prefix)) throw new Error('UNSAFE_TEST_CLEANUP_PATH');
    const visit = p => {
      const stat = fs.lstatSync(p);
      if (stat.isSymbolicLink()) throw new Error('TEST_CLEANUP_REPARSE_REFUSED');
      if (stat.isDirectory()) for (const entry of fs.readdirSync(p)) visit(path.join(p, entry));
    };
    visit(resolved);
    try { fs.rmSync(resolved, { recursive: true }); } catch (error) {
      // Windows上SQLite WAL句柄释放可能滞后于测试结束；校验边界后容忍延迟删除（目录留给系统临时清理）。
      if (error?.code !== 'EPERM' && error?.code !== 'ENOTEMPTY') throw error;
      const stillThere = fs.existsSync(resolved);
      if (stillThere) fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
  return directory;
}

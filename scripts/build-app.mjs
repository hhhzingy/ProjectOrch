import { spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
const generated = spawnSync(process.execPath, ['scripts/generate-contracts.mjs', '--check'], { cwd: root, stdio: 'inherit' });
if (generated.status !== 0) process.exit(generated.status ?? 1);
const result = spawnSync(process.execPath, [compiler, ...(process.argv.includes('--typecheck') ? ['--project', 'tsconfig.typecheck.json'] : ['--build'])], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
if (!process.argv.includes('--typecheck')) {
  copyFileSync(new URL('../apps/web/index.html', import.meta.url), new URL('../apps/web/dist/index.html', import.meta.url));
}

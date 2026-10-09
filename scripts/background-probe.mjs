/** Local-only Electron integration check. Never loads the user's IG partition. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const temporary = mkdtempSync(path.join(tmpdir(), 'epo-background-probe-'));
const entry = path.join(temporary, 'main.cjs');
try {
  await build({
    entryPoints: ['scripts/background-probe-main.ts'],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    tsconfig: 'tsconfig.json',
  });
  const child = spawn(require('electron'), [entry, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: {
      ...process.env, EPO_PROBE_PROFILE: temporary,
      EPO_PROBE_BUNDLE_SHA256: createHash('sha256').update(readFileSync(entry)).digest('hex'),
    },
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

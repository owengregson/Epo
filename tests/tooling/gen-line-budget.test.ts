/**
 * `node scripts/gen-line-budget.mjs --against <ref>` re-seeds the line budget but refuses any entry
 * above the ref's list: a new oversize file or a ceiling that rose (workplan §0.2, spec §20.4).
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const run = (args: string[]) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });

interface Entry {
  file: string;
  lines: number;
}

test('an entry rises when the ref does not list its file or allows fewer lines', () => {
  const base: Entry[] = [
    { file: 'src/a.ts', lines: 400 },
    { file: 'src/b.ts', lines: 350 },
  ];
  const next: Entry[] = [
    { file: 'src/a.ts', lines: 390 },
    { file: 'src/b.ts', lines: 351 },
    { file: 'src/c.ts', lines: 301 },
  ];
  const code = `import { upwardEntries } from './scripts/gen-line-budget.mjs';
    process.stdout.write(JSON.stringify(upwardEntries(${JSON.stringify(next)}, ${JSON.stringify(base)})));`;
  const out = run(['--input-type=module', '-e', code]);
  expect(out.status).toBe(0);
  expect(JSON.parse(out.stdout)).toEqual([
    { file: 'src/b.ts', lines: 351 },
    { file: 'src/c.ts', lines: 301 },
  ]);
});

test('the tree never rises above its own committed list', () => {
  const out = run(['scripts/gen-line-budget.mjs', '--against', 'HEAD', '--print']);
  expect([out.status, out.stderr]).toEqual([0, '']);
  expect(JSON.parse(out.stdout).budget).toBe(300);
});

test('--against needs a readable ref, and a missing one writes nothing', () => {
  const bare = run(['scripts/gen-line-budget.mjs', '--against']);
  expect([bare.status, bare.stderr.trim()]).toEqual([1, 'line budget: --against takes a git ref']);
  const missing = run(['scripts/gen-line-budget.mjs', '--against', 'refs/heads/no-such-ref-f2c', '--print']);
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain('cannot read tests/tooling/line-budget.allow.json');
});

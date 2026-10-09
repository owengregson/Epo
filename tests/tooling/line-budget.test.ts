/**
 * The line budget is monotone (ADR 1003).
 *
 * No authored file under `src/` may exceed 300 lines. Today 34 do, so the rule
 * ships with an allow-list seeded from the tree — and the allow-list records
 * each file's CURRENT length, which turns "we have technical debt" into a
 * ratchet: a listed file may shrink freely, may not grow, and must leave the
 * list the moment it drops under budget. Every line removed is permanent.
 *
 * Re-seed with `node scripts/gen-line-budget.mjs` (the failure messages say so).
 * The walk below is deliberately duplicated from that script rather than
 * imported: the script is ESM and this suite is transpiled to CJS, and a check
 * that re-runs the generator would only ever prove the generator agrees with
 * itself.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const ALLOW_PATH = path.join(__dirname, 'line-budget.allow.json');

const SOURCE = new Set(['.ts', '.tsx']); // CSS is one declaration per line under Biome's formatter — line count measures formatting, not complexity
const SKIP = /[.]generated[.](ts|tsx|css)$/;

interface AllowEntry {
  file: string;
  lines: number;
}
interface AllowList {
  budget: number;
  allow: AllowEntry[];
}

const allowList = JSON.parse(fs.readFileSync(ALLOW_PATH, 'utf8')) as AllowList;
const BUDGET = allowList.budget;
const RESEED = 'run `node scripts/gen-line-budget.mjs` and justify the diff';

/** Every authored source file under `src/`, as repo-relative POSIX paths. */
function sourceFiles(dir = path.join(ROOT, 'src')): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    const dot = entry.name.lastIndexOf('.');
    if (dot < 0 || !SOURCE.has(entry.name.slice(dot))) continue;
    const rel = path.relative(ROOT, full).split(path.sep).join('/');
    if (SKIP.test(rel)) continue;
    out.push(rel);
  }
  return out.sort();
}

/** `wc -l` semantics: a trailing newline does not add a line. */
function countLines(relPath: string): number {
  const text = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  if (text.length === 0) return 0;
  return text.replace(/\n$/, '').split('\n').length;
}

/** Jest's `expect` takes no message, so the fix instruction rides in the diff. */
const withHint = (offenders: string[], hint: string): string[] =>
  offenders.length === 0 ? [] : [hint, ...offenders];

const measured = new Map(sourceFiles().map((file) => [file, countLines(file)] as const));
const allowed = new Map(allowList.allow.map((entry) => [entry.file, entry.lines] as const));

describe('line budget', () => {
  test('no unlisted file exceeds the budget', () => {
    const offenders = [...measured]
      .filter(([file, lines]) => lines > BUDGET && !allowed.has(file))
      .map(([file, lines]) => `${file} (${lines} > ${BUDGET})`);
    // A new file over 300 lines is a design smell caught at birth: split it,
    // or add an ADR reference and re-seed.
    expect(withHint(offenders, `A new oversized file needs a split — or ${RESEED}.`)).toEqual([]);
  });

  test('no allow-listed file has grown', () => {
    const grown = [...allowed]
      .filter(([file]) => measured.has(file))
      .filter(([file, ceiling]) => (measured.get(file) as number) > ceiling)
      .map(([file, ceiling]) => `${file}: ${measured.get(file)} > ${ceiling} (allowed)`);
    expect(withHint(grown, `The budget only ratchets down — ${RESEED}.`)).toEqual([]);
  });

  test('no allow-listed file is under budget or gone', () => {
    const stale = [...allowed]
      .filter(([file]) => !measured.has(file) || (measured.get(file) as number) <= BUDGET)
      .map(([file]) =>
        measured.has(file) ? `${file}: now ${measured.get(file)} lines` : `${file}: deleted`,
      );
    expect(
      withHint(stale, `Debt paid off must leave the list permanently — ${RESEED}.`),
    ).toEqual([]);
  });

  test('the allow-list is sorted, deduplicated and honest', () => {
    const files = allowList.allow.map((entry) => entry.file);
    expect(new Set(files).size).toBe(files.length);
    expect(allowList.allow.every((entry) => entry.lines > BUDGET)).toBe(true);
    const sorted = [...allowList.allow].sort(
      (a, b) => b.lines - a.lines || a.file.localeCompare(b.file),
    );
    expect(files).toEqual(sorted.map((entry) => entry.file));
  });
});

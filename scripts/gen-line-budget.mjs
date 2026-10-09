/**
 * Seeds (and re-seeds) the line-budget allow-list — see ADR 1003.
 *
 *   node scripts/gen-line-budget.mjs           rewrite the allow-list from the tree
 *   node scripts/gen-line-budget.mjs --print    show what it would write
 *
 * The allow-list is NOT a config knob: `tests/tooling/line-budget.test.ts` fails
 * when a listed file grows, so re-seeding upward is a visible, reviewable diff
 * that has to be argued for in a PR. Re-seeding DOWNWARD (after a split) is the
 * normal use, and every line removed is permanent.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const ALLOW_PATH = join(ROOT, 'tests', 'tooling', 'line-budget.allow.json');

/** Files over this need a split, or an allow-list entry that only ever shrinks. */
export const BUDGET = 300;

/** Extensions that count as authored source. */
const SOURCE = new Set(['.ts', '.tsx']); // CSS is one declaration per line under Biome's formatter — line count measures formatting, not complexity

/** Generated artifacts are outputs; a bundle string is not a file anyone reads. */
const SKIP = /[.]generated[.](ts|tsx|css)$/;

/** Every authored source file under `src/`, as repo-relative POSIX paths. */
export function sourceFiles(dir = join(ROOT, 'src')) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    const dot = entry.name.lastIndexOf('.');
    if (dot < 0 || !SOURCE.has(entry.name.slice(dot))) continue;
    const rel = relative(ROOT, full).split('\\').join('/');
    if (SKIP.test(rel)) continue;
    out.push(rel);
  }
  return out.sort();
}

/** `wc -l` semantics: a trailing newline does not add a line. */
export function countLines(relPath) {
  const text = readFileSync(join(ROOT, relPath), 'utf8');
  if (text.length === 0) return 0;
  return text.replace(/\n$/, '').split('\n').length;
}

/** Today's violators, largest first — the shape the test consumes. */
export function currentViolators() {
  return sourceFiles()
    .map((file) => ({ file, lines: countLines(file) }))
    .filter(({ lines }) => lines > BUDGET)
    .sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));
}

const serialize = (entries) =>
  `${JSON.stringify({ budget: BUDGET, allow: entries }, null, 2)}\n`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const entries = currentViolators();
  const body = serialize(entries);
  if (process.argv.includes('--print')) {
    process.stdout.write(body);
  } else {
    writeFileSync(ALLOW_PATH, body);
    const total = entries.reduce((sum, e) => sum + e.lines - BUDGET, 0);
    console.log(
      `Wrote ${relative(ROOT, ALLOW_PATH)} — ${entries.length} files over ${BUDGET} lines (${total} lines of debt).`,
    );
  }
}

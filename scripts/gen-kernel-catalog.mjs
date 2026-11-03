/**
 * Generator for the kernel catalog index (`src/kernel/catalog.generated.ts`).
 *
 *   node scripts/gen-kernel-catalog.mjs           rewrite the index
 *   node scripts/gen-kernel-catalog.mjs --check   exit 1 if the committed index is stale
 *
 * Settings → Advanced → Under the hood (spec §6.5) lists every entry of every kernel tier-1 table with the
 * guard line written above it. The values are read from the live objects (`src/kernel/catalog.ts`), but a
 * guard line exists only in the source text, so this script reads the tables and their doc comments from
 * there: every module whose header comment names it "Tier 1", plus the modules in EXTRA. The index is
 * COMMITTED so the app needs no codegen step; `tests/kernel/catalog.test.ts` runs `--check` and fails the
 * gate when a table or a guard line changes without a regenerate.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const KERNEL = fileURLToPath(new URL('../src/kernel/', import.meta.url));
const OUT = fileURLToPath(new URL('../src/kernel/catalog.generated.ts', import.meta.url));
const OUT_LABEL = 'src/kernel/catalog.generated.ts';

/** Modules catalogued although their header names another tier (or none), each with its reason. */
const EXTRA = new Map([
  ['fundamentals', 'tier 0: the measured inputs, listed with their src and rev'],
  ['derive', 'tier 2: the timing registry (its tier is the PROVENANCE ledger) and the per-choice tables'],
  ['input-probe', 'spec §17.10 lists INPUT_PROBE among the tier-1 numbers (derived, moved from tab.ts)'],
  ['renderer-health-policy', 'spec §17.6 classes RENDERER_HEALTH as a bound; its header names no tier'],
]);

/** `export const NAME = {` or `export const NAME: Type = {`: a literal table whose entries are catalogued. */
const TABLE = /^export const ([A-Z][A-Z0-9_]*)\b.*= \{$/;
/** A line opening an entry: `key: …`, `'key': …` or the shorthand `key,`. */
const ENTRY = /^(?:([A-Za-z_$][\w$]*)|'([^']+)'|"([^"]+)")\s*:|^([A-Za-z_$][\w$]*),?$/;

/** Every `.ts` module under the kernel (its path from `src/kernel`, no extension), sorted. */
function kernelModules(dir = KERNEL) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return kernelModules(full);
      if (!e.name.endsWith('.ts') || e.name.endsWith('.generated.ts')) return [];
      return [relative(KERNEL, full).split(sep).join('/').replace(/\.ts$/, '')];
    })
    .sort();
}

/** The module's header: its first doc comment. */
const headerOf = (text) => /\/\*\*[\s\S]*?\*\//.exec(text)?.[0] ?? '';

/** Code only: string literals emptied and trailing comments dropped, so brackets count true. */
const codeOf = (line) =>
  line
    .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''")
    .replace(/\/\*.*?\*\//g, '')
    .replace(/\/\/.*$/, '');

/** A doc comment's text on one line. */
const docText = (lines) =>
  lines
    .map((l) => l.replace(/^\/\*\*/, '').replace(/\*\/$/, '').replace(/^\*(?!\/)/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The tables a module declares and the doc comment directly above each entry (blank lines may sit between;
 * any other line, a `//` comment included, drops it). Nested object entries are keyed by their full path;
 * entries inside arrays and calls are values, not entries.
 */
function scan(text) {
  const tables = [];
  const guards = [];
  let frames = null; // open brackets of the current table: { key, entries }
  let pending = null; // the finished doc comment waiting for its entry
  let doc = null; // the lines of a doc comment still open
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (doc !== null) {
      doc.push(line);
      if (line.endsWith('*/')) [pending, doc] = [docText(doc), null];
      continue;
    }
    if (line.startsWith('/**')) {
      if (line.endsWith('*/') && line.length > 4) pending = docText([line]);
      else doc = [line];
      continue;
    }
    if (line === '') continue;
    if (frames === null) {
      // A table's own doc comment is its module's business; only entries take a guard line.
      const table = TABLE.exec(line);
      pending = null;
      if (table !== null) {
        tables.push(table[1]);
        frames = [{ key: table[1], entries: true }];
      }
      continue;
    }
    const top = frames[frames.length - 1];
    const entry = line.startsWith('//') || !top.entries ? null : ENTRY.exec(line);
    const key = entry === null ? null : (entry[1] ?? entry[2] ?? entry[3] ?? entry[4]);
    if (key !== null && pending !== null) guards.push([[...frames.map((f) => f.key), key].join('.'), pending]);
    pending = null;
    const code = codeOf(line);
    // The first `{` straight after an entry's colon opens that entry's object; any other bracket opens a value.
    let owner = key !== null && /^[^:]*:\s*\{/.test(code) ? key : null;
    for (const ch of code) {
      if (ch === '{' || ch === '[' || ch === '(') {
        const parent = frames[frames.length - 1];
        frames.push({ key: owner, entries: ch === '{' && owner !== null && parent.entries });
        owner = null;
      } else if (ch === '}' || ch === ']' || ch === ')') {
        frames.pop();
        if (frames.length === 0) break;
      }
    }
    if (frames.length === 0) frames = null;
  }
  return { tables, guards };
}

/** The catalogued modules, their tables and every guarded entry, in module then source order. */
export function catalogIndex() {
  const modules = [];
  const guards = [];
  for (const module of kernelModules()) {
    const text = readFileSync(join(KERNEL, `${module}.ts`), 'utf8');
    if (!/\bTier 1\b/.test(headerOf(text)) && !EXTRA.has(module)) continue;
    const found = scan(text);
    modules.push([module, found.tables]);
    guards.push(...found.guards);
  }
  return { modules, guards };
}

/** The `.ts` module holding the index. */
export function renderIndex({ modules, guards }) {
  const q = (s) => JSON.stringify(s);
  return `/**
 * GENERATED — do not edit. Run \`node scripts/gen-kernel-catalog.mjs\` after changing a catalogued kernel
 * table; \`tests/kernel/catalog.test.ts\` fails the gate when this file drifts from the sources.
 *
 * The kernel tables Settings → Under the hood lists, and the doc comment above each entry, read from the
 * source text. \`catalog.ts\` joins them to the live values.
 */

/** Each catalogued module (its path under \`src/kernel\`, no extension) and the tables it declares. */
export const KERNEL_TABLES = {
${modules.map(([m, t]) => `  ${q(m)}: [${t.map(q).join(', ')}],`).join('\n')}
} as const;

/** The doc comment directly above a table entry, on one line, by \`TABLE.key\` (nested: the full path). */
export const KERNEL_GUARDS: Readonly<Partial<Record<string, string>>> = {
${guards.map(([id, g]) => `  ${q(id)}: ${q(g)},`).join('\n')}
};
`;
}

/** The first line that differs, as `line N: - old / + new`. */
function firstDifference(current, fresh) {
  const a = current.split('\n');
  const b = fresh.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return [`line ${i + 1}:`, `  - ${a[i] ?? '<end of file>'}`, `  + ${b[i] ?? '<end of file>'}`].join('\n');
    }
  }
  return '  (files differ only in trailing bytes)';
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const module = renderIndex(catalogIndex());
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(OUT, 'utf8');
    } catch (err) {
      console.error(`${OUT_LABEL} is missing (${err.code}) — run \`node scripts/gen-kernel-catalog.mjs\`.`);
      process.exit(1);
    }
    if (current !== module) {
      console.error(`${OUT_LABEL} is stale — run \`node scripts/gen-kernel-catalog.mjs\`.`);
      console.error(firstDifference(current, module));
      process.exit(1);
    }
    console.log(`${OUT_LABEL} is up to date.`);
  } else {
    writeFileSync(OUT, module);
    console.log(`Wrote ${OUT_LABEL} (${module.length} bytes).`);
  }
}

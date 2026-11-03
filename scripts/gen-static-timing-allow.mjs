/**
 * The static-timing allow-list ratchet (spec §20.4): `node scripts/gen-static-timing-allow.mjs` prunes;
 * `--move <old> <new>` re-keys, `--against <ref>` refuses growth, `--seed` (once) seeds, `--print` prints.
 * Only --seed adds; a new entry after the seed is a stop-and-ask to the lead.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { countKeys, ROOT, scan } from './static-timing-scan.mjs';
import { classify } from './static-timing-seed.mjs';

export const ALLOW_FILE = 'tests/tooling/static-timing.allow.json';
const ALLOW_PATH = join(ROOT, ALLOW_FILE);

const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const countOf = (e) => e.count ?? 1;

/** An entry with its fields in the one fixed order; `count` only above 1. */
function canonical(e, count = countOf(e)) {
  return {
    key: e.key,
    class: e.class,
    ...(e.stream === undefined ? {} : { stream: e.stream }),
    reason: e.reason,
    ...(count > 1 ? { count } : {}),
    ...(e.movedFrom === undefined ? {} : { movedFrom: e.movedFrom }),
  };
}

/** One entry per line, sorted by key, so every prune is a one-line diff. */
export function serialize(entries) {
  const lines = [...entries].sort(byKey).map((e) => `    ${JSON.stringify(canonical(e))}`);
  return lines.length === 0 ? '{\n  "allow": []\n}\n' : `{\n  "allow": [\n${lines.join(',\n')}\n  ]\n}\n`;
}

/** The entries of an allow-list document (the committed file by default). */
export function readAllow(text = existsSync(ALLOW_PATH) ? readFileSync(ALLOW_PATH, 'utf8') : '{"allow": []}') {
  return JSON.parse(text).allow;
}

/** Drop entries whose key no longer occurs and lower counts to what remains; never adds or raises. */
export function prune(entries, counts) {
  return entries
    .flatMap((e) => {
      const found = counts.get(e.key) ?? 0;
      return found === 0 ? [] : [canonical(e, Math.min(countOf(e), found))];
    })
    .sort(byKey);
}

/** Re-key a moved literal: class, stream and reason travel, and the origin stays for --against. */
export function move(entries, oldKey, newKey, counts) {
  const entry = entries.find((e) => e.key === oldKey);
  if (entry === undefined) throw new Error(`--move: nothing listed under ${oldKey}`);
  if (entries.some((e) => e.key === newKey)) throw new Error(`--move: ${newKey} is listed already`);
  if (!counts.has(newKey)) throw new Error(`--move: ${newKey} is not a current finding`);
  const moved = canonical({ ...entry, key: newKey, movedFrom: entry.movedFrom ?? oldKey });
  return entries.map((e) => (e === entry ? moved : e)).sort(byKey);
}

/** What the ref did not allow: a key absent there (directly or as the origin it moved from), or a higher count. */
export function refusalsAgainst(entries, refEntries) {
  const ref = new Map(refEntries.map((e) => [e.key, e]));
  return entries.flatMap((e) => {
    const base = ref.get(e.key) ?? (e.movedFrom === undefined ? undefined : ref.get(e.movedFrom));
    if (base === undefined) return [`${e.key}: not listed at the ref`];
    return countOf(e) > countOf(base) ? [`${e.key}: count ${countOf(e)} > ${countOf(base)} at the ref`] : [];
  });
}

/** A moved key the ref lists under its own name no longer needs its origin. */
export function settleMoves(entries, refEntries) {
  const ref = new Set(refEntries.map((e) => e.key));
  return entries.map((e) => (e.movedFrom !== undefined && ref.has(e.key) ? canonical({ ...e, movedFrom: undefined }) : e));
}

/** Findings the entries do not cover: an unlisted key, or more occurrences than listed. */
export function uncovered(entries, counts) {
  const listed = new Map(entries.map((e) => [e.key, countOf(e)]));
  return [...counts]
    .filter(([key, n]) => n > (listed.get(key) ?? 0))
    .map(([key, n]) => `${key} (${n} found, ${listed.get(key) ?? 0} listed)`);
}

/**
 * The one-time seed: every listed entry keeps its class and reason (raised to its current count),
 * and every unlisted finding is classed by the seed rules. Deterministic and idempotent.
 */
export function seed(entries, findings) {
  const counts = countKeys(findings);
  const listed = new Map(prune(entries, counts).map((e) => [e.key, e]));
  const first = new Map();
  for (const f of findings) if (!first.has(f.key)) first.set(f.key, f);
  return [...counts]
    .map(([key, n]) => canonical(listed.get(key) ?? { key, ...classify(first.get(key)) }, n))
    .sort(byKey);
}

/** The allow-list committed at a git ref; a ref without one is an error, never an empty list. */
function allowAt(ref) {
  try {
    const text = execFileSync('git', ['show', `${ref}:${ALLOW_FILE}`], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    return readAllow(text);
  } catch (e) {
    throw new Error(`--against ${ref}: cannot read ${ALLOW_FILE} there (${String(e.stderr ?? e.message).trim()})`);
  }
}

function main(args) {
  const value = (flag, n) => {
    const i = args.indexOf(flag);
    if (i < 0) return null;
    const out = args.slice(i + 1, i + 1 + n);
    if (out.length < n || out.some((a) => a.startsWith('--'))) throw new Error(`${flag} takes ${n} argument(s)`);
    return out;
  };
  const known = new Set(['--seed', '--move', '--against', '--print']);
  const unknown = args.filter((a) => a.startsWith('--') && !known.has(a));
  if (unknown.length > 0) throw new Error(`unknown option(s): ${unknown.join(' ')}`);
  const findings = scan();
  const counts = countKeys(findings);
  let entries = readAllow();
  let refused = [];
  if (args.includes('--seed')) entries = seed(entries, findings);
  else {
    const moved = value('--move', 2);
    if (moved !== null) entries = move(entries, moved[0], moved[1], counts);
    entries = prune(entries, counts);
    const ref = value('--against', 1)?.[0];
    if (ref !== undefined) {
      const base = allowAt(ref);
      refused = refusalsAgainst(entries, base);
      entries = settleMoves(entries, base);
    }
  }
  if (refused.length > 0) {
    console.error(`static-timing: the ref does not allow ${refused.length} entries; remove the literal or ask the lead:`);
    for (const r of refused) console.error(`  ${r}`);
    return 1;
  }
  const body = serialize(entries);
  if (args.includes('--print')) process.stdout.write(body);
  else writeFileSync(ALLOW_PATH, body);
  const missing = uncovered(entries, counts);
  const classes = Object.entries(Object.groupBy(entries, (e) => e.class)).map(([c, l]) => `${c} ${l.length}`);
  console.error(`static-timing: ${entries.length} entries (${classes.join(', ')}); ${missing.length} unlisted finding(s)`);
  for (const m of missing) console.error(`  unlisted: ${m}`);
  return missing.length > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`static-timing: ${e.message}`);
    process.exitCode = 1;
  }
}

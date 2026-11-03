/**
 * Guard lines (spec §20.4): every top-level entry of a tier-1 kernel table
 * carries a one-line `/** … *\/` comment saying what it guards against. Read
 * from source text, so a new entry without its line fails here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const KERNEL = path.resolve(__dirname, '..', '..', 'src', 'kernel');

/** The tier-1 modules the plan-derived overhaul created or extended. */
const MODULES = ['tempo-policy.ts', 'settings-policy.ts', 'reentry-policy.ts', 'census-policy.ts', 'input-probe.ts',
  'exploration-policy.ts'];

const isComment = (line: string): boolean => line.startsWith('/**') || line.startsWith('*') || line.startsWith('//');
const bracketDelta = (line: string): number =>
  (line.match(/[{[(]/g) ?? []).length - (line.match(/[}\])]/g) ?? []).length;

/** Top-level entries of every `export const NAME = {` table that lack a one-line guard comment. */
function unguarded(text: string): string[] {
  const missing: string[] = [];
  let depth = 0;
  let prev = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (depth === 0) {
      if (/^export const [A-Z][A-Z0-9_]* = \{$/.test(line)) depth = 1;
      prev = '';
      continue;
    }
    if (depth === 1) {
      const entry = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line);
      if (entry && !(prev.startsWith('/**') && prev.endsWith('*/'))) missing.push(entry[1]);
    }
    if (!isComment(line)) depth += bracketDelta(line);
    if (line !== '') prev = line;
  }
  return missing;
}

test.each(MODULES)('%s: every table entry has a one-line guard comment', (file) => {
  expect(unguarded(fs.readFileSync(path.join(KERNEL, file), 'utf8'))).toEqual([]);
});

test('the parser flags an entry without its guard line, and only that one', () => {
  const fixture = [
    'export const SAMPLE = {',
    '  /** Guarded: says what it keeps from going wrong. */',
    '  GUARDED: 1,',
    '  BARE: 2,',
    '  /** A group keeps its own line; nested keys are the group\'s business. */',
    '  GROUP: { INNER: [1, 2] },',
    '} as const;',
  ].join('\n');
  expect(unguarded(fixture)).toEqual(['BARE']);
});

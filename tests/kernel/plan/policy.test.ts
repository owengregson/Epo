/**
 * The plan core's tier-1 bounds (spec §20.4): every entry carries a one-line guard comment, read
 * from source text so a new entry without its line fails here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PLAN_BOUNDS } from '@/kernel/plan/policy';

const FILE = path.resolve(__dirname, '..', '..', '..', 'src', 'kernel', 'plan', 'policy.ts');

/** Top-level entries of `export const NAME = {` tables whose previous line is not a one-line doc comment. */
function unguarded(text: string): string[] {
  const missing: string[] = [];
  let inTable = false;
  let prev = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^export const [A-Z][A-Z0-9_]* = \{$/.test(line)) inTable = true;
    else if (line.startsWith('}')) inTable = false;
    else if (inTable) {
      const entry = /^([A-Z][A-Z0-9_]*)\s*:/.exec(line);
      if (entry && !(prev.startsWith('/**') && prev.endsWith('*/'))) missing.push(entry[1]);
    }
    if (line !== '') prev = line;
  }
  return missing;
}

test('every PLAN_BOUNDS entry has a one-line guard comment', () => {
  expect(unguarded(fs.readFileSync(FILE, 'utf8'))).toEqual([]);
  expect(Object.keys(PLAN_BOUNDS).length).toBeGreaterThan(0);
});

test('the bounds keep their stated relations', () => {
  expect(PLAN_BOUNDS.TRANSITION_MIN_HOURS).toBeLessThan(PLAN_BOUNDS.PRORATE_BELOW_HOURS);
  expect(PLAN_BOUNDS.BOOST_INSERT_MASS.LO).toBeLessThan(PLAN_BOUNDS.BOOST_INSERT_MASS.HI);
  expect(PLAN_BOUNDS.PACE_WORDS.QUICK_BELOW).toBeLessThan(1);
  expect(PLAN_BOUNDS.PACE_WORDS.RELAXED_ABOVE).toBeGreaterThan(1);
  expect(PLAN_BOUNDS.PACE_WORDS.RELAXED_ABOVE * PLAN_BOUNDS.PACE_WORDS.QUICK_BELOW).toBeCloseTo(1, 1);
});

test('the parser flags an entry without its guard line', () => {
  expect(unguarded(['export const X = {', '  /** Guarded. */', '  A: 1,', '  B: 2,', '} as const;'].join('\n'))).toEqual(['B']);
});

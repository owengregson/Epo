/**
 * LIVE and DIAGNOSTICS (spec §12.9, Appendix C.2): the feed's grouping horizon is one session boundary, the window
 * is a whole number of days that holds many groups, a group never outgrows the feed it sits in, and every entry
 * carries its one-line guard comment.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMPIRICAL } from '@/kernel/fundamentals';
import { DIAGNOSTICS, LIVE } from '@/kernel/live-policy';
import { MS_PER_DAY } from '@/kernel/units';

test('the grouping horizon is one session boundary, derived', () => {
  expect(LIVE.GROUP_WINDOW_MS).toBe(EMPIRICAL.HUMAN_SESSION_BOUNDARY_MS.value);
});

test('the feed window is a whole number of days and spans many groups', () => {
  expect(LIVE.FEED_WINDOW_MS % MS_PER_DAY).toBe(0);
  expect(LIVE.FEED_WINDOW_MS / MS_PER_DAY).toBeGreaterThanOrEqual(2);
  expect(LIVE.FEED_WINDOW_MS).toBeGreaterThan(LIVE.GROUP_WINDOW_MS);
});

test('a group lists fewer people than the feed holds rows; the ring keeps more lines than one feed', () => {
  expect(LIVE.GROUP_PEOPLE_MAX).toBeGreaterThan(1);
  expect(LIVE.GROUP_PEOPLE_MAX).toBeLessThan(LIVE.FEED_LIMIT);
  expect(DIAGNOSTICS.LOG_RING).toBeGreaterThan(LIVE.FEED_LIMIT);
  for (const n of [LIVE.FEED_LIMIT, LIVE.GROUP_PEOPLE_MAX, DIAGNOSTICS.LOG_RING]) expect(Number.isInteger(n)).toBe(true);
});

test('every entry sits under a one-line guard comment', () => {
  const lines = readFileSync(join(__dirname, '../../src/kernel/live-policy.ts'), 'utf8').split('\n');
  const entries = lines.map((line, i) => ({ line, i })).filter(({ line }) => /^ {2}[A-Z_]+: .+,$/.test(line));
  expect(entries.map(({ line }) => line.trim().split(':')[0])).toEqual([...Object.keys(LIVE), ...Object.keys(DIAGNOSTICS)]);
  for (const { i } of entries) expect(lines[i - 1]).toMatch(/^ {2}\/\*\* Guards: .+ \*\/$/);
});

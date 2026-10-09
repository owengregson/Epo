/**
 * `pruneDue` — the scheduled auto-run predicate. Pure: no engine, no store,
 * no fakes (the shape every extracted decision should have).
 */

import { pruneDue } from '@/engine/prune-engine';

const DAY = 24 * 3600 * 1000;

describe('pruneDue (scheduled auto-run predicate)', () => {
  test('disabled schedule (0 or negative) is never due', () => {
    expect(pruneDue(0, null, 1_000)).toBe(false);
    expect(pruneDue(0, 0, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(pruneDue(-3, null, 1_000)).toBe(false);
  });

  test('due immediately when it has never run and a schedule is set', () => {
    expect(pruneDue(7, null, 1_000)).toBe(true);
  });

  test('due only once the cadence has elapsed since the last run', () => {
    const last = 10 * DAY;
    expect(pruneDue(7, last, last + 6 * DAY)).toBe(false);
    expect(pruneDue(7, last, last + 7 * DAY)).toBe(true);
    expect(pruneDue(7, last, last + 8 * DAY)).toBe(true);
  });

  test('a non-finite cadence is never due (defensive)', () => {
    expect(pruneDue(Number.NaN, null, 1_000)).toBe(false);
    expect(pruneDue(Number.POSITIVE_INFINITY, 0, 10 * DAY)).toBe(false);
  });
});

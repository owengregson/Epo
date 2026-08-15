import { CIRCADIAN, PATTERN, SESSION } from '@/timing/config';

// Guard the invariants the SessionPlanner and circadian field rely on, so an
// accidental constant edit fails loudly instead of silently distorting the pattern.
describe('timing/config — organic-pattern invariants', () => {
  test('day-of-week weights cover all seven days', () => {
    expect(CIRCADIAN.DAY_OF_WEEK_WEIGHTS).toHaveLength(7);
    for (const w of CIRCADIAN.DAY_OF_WEEK_WEIGHTS) expect(w).toBeGreaterThanOrEqual(0);
  });

  test('within-session gap bounds are ordered: floor ≤ median ≤ cap', () => {
    expect(SESSION.GAP_FLOOR_MS).toBeLessThanOrEqual(SESSION.GAP_MEDIAN_MS);
    expect(SESSION.GAP_MEDIAN_MS).toBeLessThanOrEqual(SESSION.GAP_CAP_MS);
  });

  test('Hawkes excitation is sub-critical (branching ratio < 1)', () => {
    expect(SESSION.HAWKES_ALPHA).toBeGreaterThan(0);
    expect(SESSION.HAWKES_ALPHA).toBeLessThan(1);
  });

  test('velocity cap sits in the established-account band', () => {
    expect(SESSION.MAX_ACTIONS_PER_ROLLING_HOUR).toBeGreaterThanOrEqual(5);
    expect(SESSION.MAX_ACTIONS_PER_ROLLING_HOUR).toBeLessThanOrEqual(40);
  });

  test('pattern fractions are in range', () => {
    expect(PATTERN.MAX_UNFOLLOW_FRACTION_PER_SESSION).toBeGreaterThanOrEqual(0);
    expect(PATTERN.MAX_UNFOLLOW_FRACTION_PER_SESSION).toBeLessThanOrEqual(1);
    expect(PATTERN.REST_DAY_PROBABILITY).toBeGreaterThanOrEqual(0);
    expect(PATTERN.REST_DAY_PROBABILITY).toBeLessThan(0.3);
  });
});

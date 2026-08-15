import { CIRCADIAN, PATTERN, SESSION } from '@/timing/config';
import { type PatternSettings, resolvePattern } from '@/settings/pattern-map';

// Guard the invariants the SessionPlanner and circadian field rely on, so an
// accidental constant edit fails loudly instead of silently distorting the pattern.
// Level-DEPENDENT values live in pattern-map's tables (their single home), so the
// gap/velocity invariants are asserted across every knob level via resolvePattern.
describe('timing/config — organic-pattern invariants', () => {
  test('day-of-week weights cover all seven days', () => {
    expect(CIRCADIAN.DAY_OF_WEEK_WEIGHTS).toHaveLength(7);
    for (const w of CIRCADIAN.DAY_OF_WEEK_WEIGHTS) expect(w).toBeGreaterThanOrEqual(0);
  });

  test('Hawkes excitation is sub-critical (branching ratio < 1)', () => {
    expect(SESSION.HAWKES_ALPHA).toBeGreaterThan(0);
    expect(SESSION.HAWKES_ALPHA).toBeLessThan(1);
  });

  test('pattern fractions are in range', () => {
    expect(PATTERN.MAX_UNFOLLOW_FRACTION_PER_SESSION).toBeGreaterThanOrEqual(0);
    expect(PATTERN.MAX_UNFOLLOW_FRACTION_PER_SESSION).toBeLessThanOrEqual(1);
    expect(PATTERN.REST_DAY_MAX_FRACTION).toBeGreaterThan(0);
    expect(PATTERN.REST_DAY_MAX_FRACTION).toBeLessThan(1);
  });
});

describe('pattern-map levels — organic-pattern invariants', () => {
  const base: PatternSettings = {
    activityLevel: 'moderate',
    consistency: 'natural',
    rhythm: 'sessions',
    dayShape: 'balanced',
    weeklyShape: 'even',
    caution: 'standard',
    cleanup: 'steady',
    patience: 'normal',
  };
  const rhythms: PatternSettings['rhythm'][] = ['trickle', 'sessions', 'bursts'];
  const cautions: PatternSettings['caution'][] = ['cautious', 'standard', 'bold'];
  const consistencies: PatternSettings['consistency'][] = ['clockwork', 'natural', 'erratic'];

  test('gap bounds are ordered at every rhythm × caution level: floor ≤ median ≤ cap', () => {
    for (const rhythm of rhythms) {
      for (const caution of cautions) {
        const r = resolvePattern({ ...base, rhythm, caution });
        expect(r.gapFloorSeconds).toBeLessThanOrEqual(r.gapMedianSeconds);
        expect(r.gapMedianSeconds * 1000).toBeLessThanOrEqual(SESSION.GAP_CAP_MS);
      }
    }
  });

  test('every caution level keeps the velocity cap in the established-account band', () => {
    for (const caution of cautions) {
      const r = resolvePattern({ ...base, caution });
      expect(r.hourlyVelocityCap).toBeGreaterThanOrEqual(5);
      expect(r.hourlyVelocityCap).toBeLessThanOrEqual(40);
    }
  });

  test('every consistency level keeps rest-day probability in range', () => {
    for (const consistency of consistencies) {
      const r = resolvePattern({ ...base, consistency });
      expect(r.restDayChancePct).toBeGreaterThanOrEqual(0);
      expect(r.restDayChancePct).toBeLessThan(30);
    }
  });
});

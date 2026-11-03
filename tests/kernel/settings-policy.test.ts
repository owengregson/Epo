/**
 * The settings policy (ADR 0608, spec §17.10): today's values under their names, the follow-back floor
 * linked to the exploration prior, and the safe-side guards ordered and inside what the engine accepts.
 */

import { SCORER_DEFAULTS } from '@/engine/scorer';
import { CAUTION, EMPIRICAL } from '@/kernel';
import { EXPLORATION_POLICY } from '@/kernel/exploration-policy';
import { SETTINGS_GUARDS, SETTINGS_POLICY } from '@/kernel/settings-policy';
import { DEFAULT_SETTINGS } from '@/settings/settings';

test("the scorer's recommendations are today's defaults, one declaration", () => {
  const { RATIO_CURVE, AUDIENCE_SIZE, PRIVATE_EDGE, RECOMMENDED } = SETTINGS_POLICY;
  expect(SCORER_DEFAULTS).toEqual({
    ...RATIO_CURVE, minFollowers: AUDIENCE_SIZE.everyday.min, maxFollowers: AUDIENCE_SIZE.everyday.max,
    privateBoost: PRIVATE_EDGE, bandEdgeScore: RECOMMENDED.bandEdgeScore, mutualCap: RECOMMENDED.mutualCap,
    mutualWeight: RECOMMENDED.mutualWeight,
  });
});

test('the v1 defaults restate the policy (the frozen v1 file keeps its own copy)', () => {
  const { RATIO_CURVE, AUDIENCE_SIZE, PRIVATE_EDGE, RECOMMENDED, INTERIM } = SETTINGS_POLICY;
  expect(DEFAULT_SETTINGS).toMatchObject({
    ...RATIO_CURVE, minFollowers: AUDIENCE_SIZE.everyday.min, maxFollowers: AUDIENCE_SIZE.everyday.max,
    privateBoost: PRIVATE_EDGE, minPoolSize: RECOMMENDED.minPoolSize, lowWaterCandidates: RECOMMENDED.lowWaterCandidates,
    minFollowBackRate: RECOMMENDED.minFollowBackRate, pruneDailyLimit: INTERIM.pruneDailyLimit,
    followbackSweepHours: INTERIM.followbackSweepHours,
  });
  // v1 ships with the schedule off; the interim census spacing is what a schedule that was on recommends.
  expect(INTERIM.pruneScheduleDays).toBeGreaterThan(DEFAULT_SETTINGS.pruneScheduleDays);
});

test('the follow-back floor is the exploration prior, linked rather than a twin literal', () => {
  expect(SETTINGS_POLICY.RECOMMENDED.minFollowBackRate).toBe(EXPLORATION_POLICY.priorRate);
});

test('the ratio curve is ordered and every audience range is ordered and nested', () => {
  const c = SETTINGS_POLICY.RATIO_CURVE;
  const points = [c.hardLow, c.bandLow, c.peakLow, c.peakHigh, c.bandHigh, c.hardHigh];
  expect(points).toEqual([...points].sort((a, b) => a - b));
  const { small, everyday, larger } = SETTINGS_POLICY.AUDIENCE_SIZE;
  for (const r of [small, everyday, larger]) expect(r.min).toBeLessThan(r.max);
  expect(small.max).toBeLessThan(everyday.max);
  expect(everyday.max).toBeLessThan(larger.max);
});

test('quiet hours: the grid divides a day and the longest window leaves active time', () => {
  const { QUIET_GRID_MINUTES, QUIET_MAX_HOURS, QUIET_INTENSITY_FRACTION } = SETTINGS_POLICY;
  expect((24 * 60) % QUIET_GRID_MINUTES).toBe(0);
  expect(QUIET_MAX_HOURS).toBeLessThan(24);
  expect(QUIET_INTENSITY_FRACTION).toBeGreaterThan(0);
  expect(QUIET_INTENSITY_FRACTION).toBeLessThan(1);
});

test('the typical-day z is the 90th percentile of a standard normal', () => {
  expect(SETTINGS_POLICY.TYPICAL_DAY_Z).toBeCloseTo(1.2816, 4);
});

test('every guard is an ordered interval, and the guard on the hourly cap admits every caution', () => {
  for (const [key, g] of Object.entries(SETTINGS_GUARDS)) {
    expect({ key, ordered: g.min <= g.max }).toEqual({ key, ordered: true });
  }
  for (const c of Object.values(CAUTION)) {
    expect(c.cap).toBeGreaterThanOrEqual(SETTINGS_GUARDS.hourlyCap.min);
  }
  expect(SETTINGS_GUARDS.waitDays.max).toBeGreaterThan(0);
  expect(SETTINGS_GUARDS.refillBelow.max).toBe(EXPLORATION_POLICY.queuedPerSource);
});

test('the risk rungs climb with the activity and caution vocabularies, the top rung only at the daily wall', () => {
  const { activity, caution } = SETTINGS_POLICY.RISK_RUNG;
  expect(Object.values(activity)).toEqual([...Object.values(activity)].sort((a, b) => a - b));
  expect(Object.values(caution)).toEqual([...Object.values(caution)].sort((a, b) => a - b));
  expect(Math.max(...Object.values(caution))).toBeLessThan(Math.max(...Object.values(activity)));
  expect(EMPIRICAL.FOLLOW_WALL_PER_DAY.low).toBeGreaterThan(0);
});

test('the document version is the v2 format', () => {
  expect(SETTINGS_POLICY.DOC_VERSION).toBe(2);
});

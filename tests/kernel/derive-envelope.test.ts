/**
 * The settings envelope (ADR 0608, law L-ENV's kernel half): the most permissive value the kernel derives
 * on the 30-point grid or in the plan's own draws, the burst floor, the risk rung and the low-wall share.
 */

import { BOUNDS, CAUTION, defaultRateInputs, derivePattern, EMPIRICAL, rateEnvelope } from '@/kernel';
import {
  burstFloorSeconds, checkSpacingHours, ENVELOPE, GRID_BASE, gridPoints, riskRung, shareOfLowWall,
} from '@/kernel/derive-envelope';
import { SETTINGS_POLICY } from '@/kernel/settings-policy';
import { locationOf, REFERENCE_TEMPO, resolve } from '@/kernel/tempo';
import { MS_PER_HOUR } from '@/kernel/units';
import { PERSONAS } from '@/settings/pattern-map';
import { LEGACY_SNAPSHOT } from './legacy-config.snapshot';

test("the grid is the legacy snapshot's 30 points around the balanced persona", () => {
  const grid = (LEGACY_SNAPSHOT as unknown as { grid: Record<string, unknown> }).grid;
  expect(GRID_BASE).toEqual(PERSONAS.balanced);
  const expected = Object.keys(grid).map((point) => {
    const [knob, value] = point.split('=');
    return { ...GRID_BASE, [knob]: value };
  });
  expect(gridPoints()).toEqual(expect.arrayContaining(expected));
  expect(gridPoints()).toHaveLength(expected.length);
});

test('the envelope is the spec catalog: ≤ 30/h, ≤ 100 and ≤ 130 a day, waits ≥ 2 days, shares ≤ 0.5', () => {
  expect(ENVELOPE.hourlyCap.max).toBe(30);
  expect(ENVELOPE.dailyVolume.max).toBe(100);
  expect(ENVELOPE.dailyCeiling.max).toBe(130);
  expect(ENVELOPE.candidateBuffer.max).toBe(120);
  expect(ENVELOPE.waitDays.min).toBe(2);
  expect(ENVELOPE.holdDays.min).toBe(1);
  expect(ENVELOPE.dayVariation).toEqual({ min: 12, max: 45 });
  expect(ENVELOPE.restDayChance).toEqual({ min: 0, max: 18 });
  expect(ENVELOPE.sessionsMin).toEqual({ min: 2, max: 9 });
  expect(ENVELOPE.sessionsMax).toEqual({ min: 2, max: 9 });
  expect(ENVELOPE.cleanupShare).toEqual({ min: 0, max: BOUNDS.PATTERN.MAX_UNFOLLOW_FRACTION_PER_SESSION });
});

test('every grid point lies inside the envelope', () => {
  for (const p of gridPoints()) {
    const d = derivePattern(p);
    expect(d.hourlyVelocityCap).toBeLessThanOrEqual(ENVELOPE.hourlyCap.max);
    expect(d.dailyOperatingRate).toBeLessThanOrEqual(ENVELOPE.dailyVolume.max);
    expect(d.dailyHardCeiling).toBeLessThanOrEqual(ENVELOPE.dailyCeiling.max);
    expect(d.maxWaitForFollowbackDays).toBeGreaterThanOrEqual(ENVELOPE.waitDays.min);
    expect(d.gapFloorSeconds).toBeGreaterThanOrEqual(ENVELOPE.gapFloor.min);
  }
});

test('law: the hourly envelope never passes the low hourly follow wall', () => {
  expect(ENVELOPE.hourlyCap.max).toBeLessThanOrEqual(EMPIRICAL.FOLLOW_WALL_PER_HOUR.low);
});

test("the check spacing's envelope is the plan's own pace band: 51 min at the briskest draw", () => {
  expect(ENVELOPE.checksEveryHours.min).toBeCloseTo(0.85, 10);
  expect(checkSpacingHours(1)).toBe(1);
  for (const pace of [BOUNDS.NOISE.BEAT_MIN_FACTOR, 1, BOUNDS.NOISE.BEAT_MAX_FACTOR]) {
    const fromSpec = locationOf(resolve('check.spacing', { ...REFERENCE_TEMPO, pace })) / MS_PER_HOUR;
    expect(checkSpacingHours(pace)).toBeCloseTo(fromSpec, 12);
  }
  expect(ENVELOPE.checksEveryHours.max).toBeCloseTo(checkSpacingHours(BOUNDS.NOISE.BEAT_MAX_FACTOR), 10);
});

test('the burst floor is the derived gap floor of every caution', () => {
  for (const c of ['cautious', 'standard', 'bold'] as const) {
    const derived = rateEnvelope(defaultRateInputs(), c, 'moderate', 'sessions').gapFloorSeconds;
    expect(burstFloorSeconds(CAUTION[c].cap)).toBe(derived);
  }
  expect([14, 22, 30].map(burstFloorSeconds)).toEqual([70, 45, 33]);
});

test('the burst floor never rises with the cap', () => {
  for (let cap = 1; cap < ENVELOPE.hourlyCap.max; cap += 1) {
    expect(burstFloorSeconds(cap + 1)).toBeLessThanOrEqual(burstFloorSeconds(cap));
  }
});

test('the risk rung: the higher of the daily and the hourly rung; only the largest volume is at the limit', () => {
  expect(riskRung({ dailyVolume: 30, hourlyCap: 14 })).toBe(0);
  expect(riskRung({ dailyVolume: 50, hourlyCap: 22 })).toBe(1);
  expect(riskRung({ dailyVolume: 75, hourlyCap: 22 })).toBe(2);
  expect(riskRung({ dailyVolume: 30, hourlyCap: 30 })).toBe(2);
  expect(riskRung({ dailyVolume: 51, hourlyCap: 14 })).toBe(2);
  expect(riskRung({ dailyVolume: 100, hourlyCap: 14 })).toBe(3);
  expect(riskRung({ dailyVolume: 76, hourlyCap: 1 })).toBe(SETTINGS_POLICY.RISK_RUNG.activity.aggressive);
});

test('the risk rung is monotone in both inputs', () => {
  for (let v = 1; v < 100; v += 7) {
    for (let h = 1; h < 30; h += 3) {
      expect(riskRung({ dailyVolume: v + 7, hourlyCap: h })).toBeGreaterThanOrEqual(riskRung({ dailyVolume: v, hourlyCap: h }));
      expect(riskRung({ dailyVolume: v, hourlyCap: h + 3 })).toBeGreaterThanOrEqual(riskRung({ dailyVolume: v, hourlyCap: h }));
    }
  }
});

test("the low-wall share divides by the low daily follow wall: 48 at a target of 50 is 48%", () => {
  expect(shareOfLowWall(48)).toBeCloseTo(0.48, 10);
  expect(shareOfLowWall(EMPIRICAL.FOLLOW_WALL_PER_DAY.low)).toBe(1);
});

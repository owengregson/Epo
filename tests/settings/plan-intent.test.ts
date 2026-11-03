/**
 * The plan intent from live settings (spec §5.3): every persona and activity point maps onto a valid
 * intent — probation one caution rung down (22 / 14 / 9), the unfollow cap from its own wall (law
 * L3), cleanup as a share of the room (0 · .36 · .71), overrides on the effective scale — and the
 * digest is stable, changes with meaning and restores on A → B → A.
 */
import { CAUTION, PATIENCE } from '@/kernel/derive';
import { drawDayPlan } from '@/kernel/plan/draw';
import { MS_PER_DAY, MS_PER_HOUR } from '@/kernel/units';
import { effectiveFromV1 } from '@/settings/effective';
import { type PatternSettings, PERSONAS, resolvePattern } from '@/settings/pattern-map';
import { intentDigest, toPlanIntent } from '@/settings/plan-intent';
import { DEFAULT_SETTINGS } from '@/settings/settings';
import { drawInput } from '../kit/plan';

const LEVELS = ['minimal', 'light', 'moderate', 'active', 'aggressive'] as const;
const effectiveAt = (pattern: PatternSettings) => effectiveFromV1({ ...DEFAULT_SETTINGS, pattern, ...resolvePattern(pattern) });

describe('every persona point maps onto a valid intent', () => {
  const points = Object.entries(PERSONAS).flatMap(([id, persona]) => LEVELS.map((activityLevel) => [`${id}/${activityLevel}`, { ...persona, activityLevel }] as const));

  test.each(points)('%s', (_id, pattern) => {
    const e = effectiveAt(pattern);
    const i = toPlanIntent(e);
    expect(i.operatingRate).toBe(e.dailyOperatingRate);
    expect(i.hardCeiling).toBe(e.dailyHardCeiling);
    expect(i.hourlyCap).toBe(e.hourlyVelocityCap);
    expect(i.probationHourlyCap).toBeLessThan(i.hourlyCap);
    expect(i.unfollowHourlyCap).toBeLessThanOrEqual(i.hourlyCap);
    expect(i.gap.medianMs).toBe(e.gapMedianSeconds * 1000);
    expect(i.volumeSigma).toBeCloseTo(e.dailyVolumeVariancePct / 100, 12);
    expect(i.patienceWaitMs).toBe(e.maxWaitForFollowbackDays * MS_PER_DAY);
    expect(i.shape.weekdayWeights).toHaveLength(7);
    const plan = drawDayPlan(drawInput(new Date(2026, 10, 3, 12).getTime(), { intent: i }));
    expect(plan.volume.planned).toBeLessThanOrEqual(plan.ceilings.automaticMax);
  });
});

test('probation runs one caution rung down: Bold 22, Standard 14, Cautious 9', () => {
  const base = PERSONAS[Object.keys(PERSONAS)[0] as keyof typeof PERSONAS];
  const cap = (caution: PatternSettings['caution']) => toPlanIntent(effectiveAt({ ...base, caution })).probationHourlyCap;
  expect([cap('bold'), cap('standard'), cap('cautious')]).toEqual([CAUTION.standard.cap, CAUTION.cautious.cap, 9]);
});

test('cleanup is a share of the unfollow room: off 0, trickle .36, steady .71, deep reads as steady; no weave → 0', () => {
  const base = PERSONAS[Object.keys(PERSONAS)[0] as keyof typeof PERSONAS];
  const share = (cleanup: PatternSettings['cleanup']) => toPlanIntent(effectiveAt({ ...base, cleanup })).cleanupShare;
  expect(share('off')).toBe(0);
  expect(share('trickle')).toBeCloseTo(0.357, 3);
  expect(share('steady')).toBeCloseTo(0.714, 3);
  expect(share('deep')).toBeCloseTo(0.714, 3);
  expect(toPlanIntent({ ...effectiveAt({ ...base, cleanup: 'steady' }), weaveEnabled: false }).cleanupShare).toBe(0);
});

test('overrides land on the effective scale in ms; the census override sets the patience window', () => {
  const e = { ...effectiveAt(PERSONAS[Object.keys(PERSONAS)[0] as keyof typeof PERSONAS]), gapTargetOverrideSeconds: 400,
    gapFloorOverrideSeconds: 150, checkSpacingHoursOverride: 3, censusEveryDaysOverride: 9 };
  const i = toPlanIntent(e);
  expect([i.gapTargetOverrideMs, i.gapFloorOverrideMs, i.checkSpacingOverrideMs]).toEqual([400_000, 150_000, 3 * MS_PER_HOUR]);
  expect(i.patienceWaitMs).toBe(9 * MS_PER_DAY);
  expect(PATIENCE.normal.waitDays).toBeGreaterThan(0);
});

test('the digest is stable, changes with meaning and restores on A → B → A', () => {
  const a = toPlanIntent(effectiveAt(PERSONAS[Object.keys(PERSONAS)[0] as keyof typeof PERSONAS]));
  expect(intentDigest(a)).toBe(intentDigest(toPlanIntent(effectiveAt(PERSONAS[Object.keys(PERSONAS)[0] as keyof typeof PERSONAS]))));
  expect(intentDigest({ ...a, hourlyCap: a.hourlyCap + 1 })).not.toBe(intentDigest(a));
  const reordered = Object.fromEntries(Object.entries(a).reverse()) as typeof a;
  expect(intentDigest(reordered)).toBe(intentDigest(a));
  expect(intentDigest(a)).toMatch(/^[0-9a-f]{8}$/);
});

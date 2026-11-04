/**
 * The resolve algorithm (spec §6.1, law L-ENV's settings half): identity with today's derivation at every
 * grid point; effective values contained in their bounds for any intent and override; overrides persist
 * and restore; coupled bounds hold; derived numbers chain from effective upstreams; stale flags; and
 * every timing override only lengthens.
 */
import fc from 'fast-check';
import { derivePattern } from '@/kernel';
import { burstFloorSeconds, ENVELOPE, gridPoints } from '@/kernel/derive-envelope';
import { SETTINGS_POLICY } from '@/kernel/settings-policy';
import { ALL_PARAM_KEYS, PARAM_SPECS, TOPO_ORDER } from '@/settings/params';
import { numberOf } from '@/settings/resolve';
import {
  ACTIVITY_LEVELS, AUDIENCE_FOCUSES, AUDIENCE_SIZES, CAUTIONS, CLEANUP_LEVELS, CONSISTENCIES, DAY_SHAPES,
  type Intent, MUTUAL_POLICIES, PATIENCES, RHYTHMS, WEEKLY_SHAPES,
} from '@/shared/settings-intent';
import { EASY_SECTIONS, type ParamKey, T2_PARAM_KEYS, TEMPO_PARAM_KEYS } from '@/shared/settings-params';
import { docOf, effectiveOf, intentOf, overridesOf, resolveDoc } from '../kit/settings';

const IDENTITY_KEYS = [
  'dailyOperatingRate', 'dailyHardCeiling', 'dailyPlanSize', 'dailyVolumeVariancePct', 'restDayChancePct',
  'sessionsPerDayMin', 'sessionsPerDayMax', 'gapMedianSeconds', 'gapFloorSeconds', 'hourlyVelocityCap',
  'maxWaitForFollowbackDays', 'holdAfterFollowbackDays',
] as const;

const intentArb: fc.Arbitrary<Intent> = fc.record({
  activity: fc.constantFrom(...ACTIVITY_LEVELS), caution: fc.constantFrom(...CAUTIONS), rhythm: fc.constantFrom(...RHYTHMS),
  consistency: fc.constantFrom(...CONSISTENCIES), dayShape: fc.constantFrom(...DAY_SHAPES),
  weeklyShape: fc.constantFrom(...WEEKLY_SHAPES), quietHours: fc.constant({ kind: 'derived' } as const),
  daysOff: fc.constant([]), patience: fc.constantFrom(...PATIENCES), mutuals: fc.constantFrom(...MUTUAL_POLICIES),
  cleanup: fc.constantFrom(...CLEANUP_LEVELS), audienceFocus: fc.constantFrom(...AUDIENCE_FOCUSES),
  audienceSize: fc.constantFrom(...AUDIENCE_SIZES), preferPrivate: fc.boolean(),
});
const numberKeys = ALL_PARAM_KEYS.filter((k) => PARAM_SPECS[k].kind === 'int' || PARAM_SPECS[k].kind === 'number');
const overrideArb = fc.dictionary(fc.constantFrom(...numberKeys), fc.double({ min: -1e6, max: 1e6, noNaN: true }))
  .map((o) => overridesOf(o as Partial<Record<ParamKey, number>>));

describe('the catalog', () => {
  test('every key has a spec, sits in one section and resolves after the keys it reads', () => {
    expect(new Set(TOPO_ORDER)).toEqual(new Set([...T2_PARAM_KEYS, ...TEMPO_PARAM_KEYS]));
    expect(TOPO_ORDER).toHaveLength(T2_PARAM_KEYS.length + TEMPO_PARAM_KEYS.length);
    for (const k of TOPO_ORDER) for (const d of PARAM_SPECS[k].deps) expect(TOPO_ORDER.indexOf(d)).toBeLessThan(TOPO_ORDER.indexOf(k));
  });

  test('Easy shows no timing: no timing row is in an Easy section; every tempo row waits for its capability', () => {
    for (const k of TEMPO_PARAM_KEYS) expect([PARAM_SPECS[k].section, PARAM_SPECS[k].needs]).toEqual(['timing', 'tempo']);
    for (const k of ['sessions.gapTypical', 'sessions.gapMinimum'] as const) expect(PARAM_SPECS[k].section).toBe('timing');
    expect((EASY_SECTIONS as readonly string[]).includes('timing')).toBe(false);
  });
});

describe('identity', () => {
  test("with no overrides the effective numbers are today's derivation at every grid point", () => {
    for (const p of gridPoints().filter((x) => x.cleanup !== 'deep')) {
      const e = effectiveOf(docOf({ intent: intentOf(p) }));
      const d = derivePattern(p);
      for (const k of IDENTITY_KEYS) expect({ p, k, v: e[k] }).toEqual({ p, k, v: d[k] });
      expect(e.maxUnfollowFractionPerSession).toBe(p.cleanup === 'off' ? 0 : d.maxUnfollowFractionPerSession);
    }
  });

  test('the recommended document is the default engine of today', () => {
    const e = effectiveOf(docOf());
    expect([e.dailyOperatingRate, e.dailyHardCeiling, e.hourlyVelocityCap, e.maxRetries]).toEqual([50, 65, 22, 3]);
    expect([e.gapTargetOverrideSeconds, e.gapFloorOverrideSeconds, e.checkSpacingHoursOverride]).toEqual([null, null, null]);
    expect(e.tempoOverrides).toEqual({});
  });
});

describe('laws', () => {
  test('containment: every effective number lies inside its bounds, for any intent and override', () => {
    fc.assert(fc.property(intentArb, overrideArb, fc.boolean(), (intent, overrides, plan) => {
      const r = resolveDoc(docOf({ intent, overrides }), plan);
      for (const k of numberKeys) {
        const v = numberOf(r, k);
        const { min, max } = r[k].bounds;
        // A lower bound above the upper one (a slower-only row) resolves to the lower, safe side.
        if (min <= max) expect(v >= min && v <= max).toBe(true);
        else expect(v).toBe(min);
      }
    }), { numRuns: 200 });
  });

  test('coupled bounds: ceiling ≥ volume, burst floor ≤ minimum gap ≤ typical gap, pruning ≤ ceiling, ordered ranges', () => {
    fc.assert(fc.property(intentArb, overrideArb, (intent, overrides) => {
      const r = resolveDoc(docOf({ intent, overrides }), true);
      const n = (k: ParamKey) => numberOf(r, k);
      expect(n('pace.dailyCeiling')).toBeGreaterThanOrEqual(n('pace.dailyVolume'));
      expect(n('sessions.gapMinimum')).toBeGreaterThanOrEqual(burstFloorSeconds(n('pace.hourlyCap')));
      expect(n('unfollow.cleanupPerDay')).toBeLessThanOrEqual(n('pace.dailyCeiling'));
      expect(n('sessions.perDayMin')).toBeLessThanOrEqual(n('sessions.perDayMax'));
      expect(n('pace.hourlyCap')).toBeLessThanOrEqual(ENVELOPE.hourlyCap.max);
      expect(n('checks.everyHours')).toBeGreaterThanOrEqual(ENVELOPE.checksEveryHours.min);
    }), { numRuns: 200 });
  });

  test('every timing override only lengthens: tempo factors ≥ 1, gaps ≥ the plan’s own', () => {
    const slower = { 'tempo.walk.page': 0.2, 'tempo.dwell.visit': 0.5, 'sessions.gapTypical': 10, 'sessions.gapMinimum': 5 };
    const r = resolveDoc(docOf({ overrides: overridesOf(slower) }), true);
    expect(numberOf(r, 'tempo.walk.page')).toBe(1);
    expect(numberOf(r, 'tempo.dwell.visit')).toBe(1);
    expect(numberOf(r, 'sessions.gapTypical')).toBe(r['sessions.gapTypical'].recommended);
    expect(numberOf(r, 'sessions.gapMinimum')).toBeGreaterThanOrEqual(r['sessions.gapMinimum'].recommended as number);
    expect(r['tempo.walk.page'].override?.clamped).toBe(true);
    const capped = resolveDoc(docOf({ overrides: overridesOf({ 'tempo.walk.page': 9 }) }), true);
    expect(numberOf(capped, 'tempo.walk.page')).toBe(SETTINGS_POLICY.TEMPO_OVERRIDE_MAX_FACTOR);
  });

  test('chaining: an overridden daily volume of 60 recommends a ceiling of 78', () => {
    const r = resolveDoc(docOf({ overrides: overridesOf({ 'pace.dailyVolume': 60 }) }));
    expect(r['pace.dailyCeiling'].recommended).toBe(78);
    expect(numberOf(r, 'pace.candidateBuffer')).toBe(72);
  });

  test('persistence and restore: an intent change clamps an override and moving back restores it', () => {
    const overrides = overridesOf({ 'pace.dailyCeiling': 60 });
    const at = (activity: Intent['activity']) =>
      numberOf(resolveDoc(docOf({ intent: { ...docOf().intent, activity }, overrides })), 'pace.dailyCeiling');
    expect(at('moderate')).toBe(60);
    expect(at('active')).toBe(75);
    expect(at('moderate')).toBe(60);
    expect(resolveDoc(docOf({ intent: { ...docOf().intent, activity: 'active' }, overrides }))['pace.dailyCeiling'].override)
      .toMatchObject({ requested: 60, clamped: true });
  });

  test('stale: an override set against another recommendation says so', () => {
    const r = resolveDoc(docOf({ overrides: overridesOf({ 'pace.hourlyCap': 18 }, 1, 14) }));
    expect(r['pace.hourlyCap'].override).toMatchObject({ stale: true, clamped: false });
    const fresh = resolveDoc(docOf({ overrides: overridesOf({ 'pace.hourlyCap': 18 }, 1, 22) }));
    expect(fresh['pace.hourlyCap'].override?.stale).toBe(false);
  });

  test('ranges and curves stay ordered and inside their guards', () => {
    const r = resolveDoc(docOf({
      overrides: overridesOf({
        'audience.followerRange': { min: 5_000, max: 100 },
        'audience.ratioCurve': { hardLow: 3, bandLow: 2, peakLow: 1, peakHigh: 0.5, bandHigh: 200, hardHigh: -1 },
      }),
    }));
    const range = r['audience.followerRange'].value as { min: number; max: number };
    expect(range.min).toBeLessThanOrEqual(range.max);
    const c = r['audience.ratioCurve'].value as Record<string, number>;
    const pts = [c.hardLow, c.bandLow, c.peakLow, c.peakHigh, c.bandHigh, c.hardHigh];
    expect(pts).toEqual([...pts].sort((a, b) => a - b));
    expect(Math.min(...pts)).toBeGreaterThanOrEqual(0);
  });

  test('an override whose shape does not fit its key is ignored', () => {
    const r = resolveDoc(docOf({ overrides: overridesOf({ 'pace.dailyVolume': { min: 1, max: 2 } }) }));
    expect(r['pace.dailyVolume'].override).toBeNull();
    expect(numberOf(r, 'pace.dailyVolume')).toBe(50);
  });

  test('lifecycle recommendations are derived even before the plan capability is registered', () => {
    const before = resolveDoc(docOf());
    const planned = resolveDoc(docOf(), true);
    for (const r of [before, planned]) {
      expect(r['unfollow.cleanupPerDay'].recommended).toBe(numberOf(r, 'pace.dailyCeiling'));
      expect(r['unfollow.censusEveryDays'].recommended).toBe(numberOf(r, 'unfollow.waitDays'));
      expect(r['checks.everyHours'].recommended).toBe(1);
    }
  });
});

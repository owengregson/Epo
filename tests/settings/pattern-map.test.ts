import { deriveOperatingPlan } from '@/kernel/derive';
import { EMPIRICAL } from '@/kernel/fundamentals';
import { POLICY, SCALES } from '@/kernel/policy';
import {
  type PatternSettings,
  PERSONAS,
  patternCircadianProfile,
  personaPattern,
  resolvePattern,
} from '@/settings/pattern-map';
import { intensityAt } from '@/timing/circadian';

const P = (o: Partial<PatternSettings> = {}): PatternSettings => ({ ...PERSONAS.balanced, ...o });
const mon = (h: number, m = 0): number => new Date(2026, 0, 5, h, m).getTime(); // Monday

describe('resolvePattern — qualitative → numeric', () => {
  test('activityLevel drives the daily mean; the ceiling derives from it', () => {
    expect(resolvePattern(P({ activityLevel: 'minimal' })).dailyOperatingRate).toBeLessThan(
      resolvePattern(P({ activityLevel: 'aggressive' })).dailyOperatingRate,
    );
    const r = resolvePattern(P({ activityLevel: 'moderate' }));
    expect(r.dailyHardCeiling).toBe(Math.round(r.dailyOperatingRate * 1.3));
  });

  test('consistency drives variance and rest-day chance', () => {
    expect(resolvePattern(P({ consistency: 'clockwork' })).dailyVolumeVariancePct).toBeLessThan(
      resolvePattern(P({ consistency: 'erratic' })).dailyVolumeVariancePct,
    );
    expect(resolvePattern(P({ consistency: 'clockwork' })).restDayChancePct).toBeLessThan(
      resolvePattern(P({ consistency: 'erratic' })).restDayChancePct,
    );
  });

  test('rhythm drives session count and gap: trickle = more, smaller-gap sessions than bursts', () => {
    const trickle = resolvePattern(P({ rhythm: 'trickle' }));
    const bursts = resolvePattern(P({ rhythm: 'bursts' }));
    expect(trickle.sessionsPerDayMax).toBeGreaterThan(bursts.sessionsPerDayMax);
    expect(trickle.gapMedianSeconds).toBeGreaterThan(bursts.gapMedianSeconds);
  });

  test('caution drives the velocity cap and the gap floor', () => {
    expect(resolvePattern(P({ caution: 'cautious' })).hourlyVelocityCap).toBeLessThan(
      resolvePattern(P({ caution: 'bold' })).hourlyVelocityCap,
    );
    expect(resolvePattern(P({ caution: 'cautious' })).gapFloorSeconds).toBeGreaterThan(
      resolvePattern(P({ caution: 'bold' })).gapFloorSeconds,
    );
  });

  test('cleanup drives the weave', () => {
    expect(resolvePattern(P({ cleanup: 'off' })).weaveEnabled).toBe(false);
    expect(resolvePattern(P({ cleanup: 'steady' })).weaveEnabled).toBe(true);
    expect(resolvePattern(P({ cleanup: 'deep' })).maxUnfollowFractionPerSession).toBeGreaterThan(
      resolvePattern(P({ cleanup: 'trickle' })).maxUnfollowFractionPerSession,
    );
  });

  test('patience drives the follow-back windows', () => {
    expect(resolvePattern(P({ patience: 'quick' })).maxWaitForFollowbackDays).toBeLessThan(
      resolvePattern(P({ patience: 'patient' })).maxWaitForFollowbackDays,
    );
  });

  test('the gap floor never exceeds the gap median across all combinations', () => {
    for (const caution of ['cautious', 'standard', 'bold'] as const) {
      for (const rhythm of ['trickle', 'sessions', 'bursts'] as const) {
        const x = resolvePattern(P({ caution, rhythm }));
        expect(x.gapFloorSeconds).toBeLessThanOrEqual(x.gapMedianSeconds);
      }
    }
  });
});

describe('patternCircadianProfile — qualitative → λ(t)', () => {
  test('business weighting peaks in the workday, not the evening', () => {
    const prof = patternCircadianProfile(P({ dayShape: 'business' }), 0);
    expect(intensityAt(mon(14), prof)).toBeGreaterThan(intensityAt(mon(20), prof));
  });

  test('night-owl has more late-night intensity than balanced', () => {
    const owl = patternCircadianProfile(P({ dayShape: 'nightowl' }), 0);
    const bal = patternCircadianProfile(P({ dayShape: 'balanced' }), 0);
    expect(intensityAt(mon(23, 30), owl)).toBeGreaterThan(intensityAt(mon(23, 30), bal));
  });

  test('weekly shapes set the day-of-week weights', () => {
    const wd = patternCircadianProfile(P({ weeklyShape: 'weekdays' }), 0);
    expect(wd.dayOfWeekWeights[0]).toBeLessThan(wd.dayOfWeekWeights[3]); // Sun < Wed
    const we = patternCircadianProfile(P({ weeklyShape: 'weekends' }), 0);
    expect(we.dayOfWeekWeights[0]).toBeGreaterThan(we.dayOfWeekWeights[3]); // Sun > Wed
  });

  test('the phase offset is threaded through', () => {
    expect(patternCircadianProfile(P(), 1.25).phaseOffsetHours).toBe(1.25);
  });
});

describe('personas', () => {
  test('every persona resolves to a sane, ordered config', () => {
    for (const id of Object.keys(PERSONAS) as Array<keyof typeof PERSONAS>) {
      const r = resolvePattern(PERSONAS[id]);
      expect(r.dailyOperatingRate).toBeGreaterThan(0);
      expect(r.sessionsPerDayMax).toBeGreaterThanOrEqual(r.sessionsPerDayMin);
      expect(r.gapFloorSeconds).toBeLessThanOrEqual(r.gapMedianSeconds);
    }
  });

  test('personaPattern returns the bundle for a named persona', () => {
    expect(personaPattern('casual')).toEqual(PERSONAS.casual);
  });

  test('the balanced persona resolves to the expected moderate numbers', () => {
    const r = resolvePattern(PERSONAS.balanced);
    expect(r.dailyOperatingRate).toBe(50); // 'moderate'
    expect(r.dailyHardCeiling).toBe(Math.round(50 * 1.3));
    expect(r.dailyPlanSize).toBe(Math.round(50 * 1.2));
    expect(r.sessionsPerDayMin).toBe(3);
    expect(r.sessionsPerDayMax).toBe(6);
    expect(r.gapMedianSeconds).toBe(95);
    expect(r.gapFloorSeconds).toBe(45);
    expect(r.hourlyVelocityCap).toBe(22);
    expect(r.maxWaitForFollowbackDays).toBe(4);
    expect(r.holdAfterFollowbackDays).toBe(2);
  });

  test('the aggressive activity level plans ~100 follows/day', () => {
    const r = resolvePattern({ ...PERSONAS.balanced, activityLevel: 'aggressive' });
    expect(r.dailyOperatingRate).toBe(100);
  });
});

/**
 * Since ADR 0605 the level tables are derived rather than hand-written. These
 * are the identities: the number, and the sentence it came from.
 */
describe('pattern-map — the level tables come from the fundamentals', () => {
  test('D1: the hourly cap is the observed wall at the safety margin, scaled by caution', () => {
    const w = EMPIRICAL.FOLLOW_WALL_PER_HOUR.typical;
    expect(resolvePattern(P({ caution: 'cautious' })).hourlyVelocityCap).toBe(
      Math.round(w * POLICY.SAFETY_MARGIN * SCALES.caution.cautious),
    );
    expect(resolvePattern(P({ caution: 'standard' })).hourlyVelocityCap).toBe(
      Math.round(w * POLICY.SAFETY_MARGIN),
    );
    expect(resolvePattern(P({ caution: 'bold' })).hourlyVelocityCap).toBe(
      Math.round(w * POLICY.SAFETY_MARGIN * SCALES.caution.bold),
    );
  });

  test('D1: the daily plan is the daily wall at the same margin, scaled by activity', () => {
    const w = EMPIRICAL.FOLLOW_WALL_PER_DAY.typical;
    for (const level of ['minimal', 'light', 'moderate', 'active', 'aggressive'] as const) {
      expect(resolvePattern(P({ activityLevel: level })).dailyOperatingRate).toBe(
        Math.round(w * POLICY.SAFETY_MARGIN * SCALES.activity[level]),
      );
    }
  });

  test('D2: the gap median is the human within-session median, scaled by rhythm', () => {
    expect(resolvePattern(P({ rhythm: 'sessions' })).gapMedianSeconds).toBe(
      EMPIRICAL.HUMAN_GAP.medianMs / 1_000,
    );
  });

  test('D2: the gap floor enforces the burst tolerance at its own cap', () => {
    for (const caution of ['cautious', 'standard', 'bold'] as const) {
      const r = resolvePattern(P({ caution, rhythm: 'trickle' }));
      // The shipped cautious/bold floors are pinned overrides (ADR 0606), so the
      // law is the safety direction, not equality: the floor never permits a
      // burst faster than the tolerance allows at more than a 20% margin.
      const sanctioned = 3_600 / (r.hourlyVelocityCap * POLICY.BURST_TOLERANCE);
      expect(3_600 / r.gapFloorSeconds).toBeLessThanOrEqual(
        (3_600 / sanctioned) * 1.2,
      );
    }
  });

  test('consistency maps the human day-volume CV and rest-day rate directly', () => {
    expect(resolvePattern(P({ consistency: 'natural' })).dailyVolumeVariancePct).toBe(
      Math.round(EMPIRICAL.HUMAN_DAY_VOLUME_CV.value * 100),
    );
    expect(resolvePattern(P({ consistency: 'natural' })).restDayChancePct).toBe(
      Math.round(EMPIRICAL.HUMAN_REST_DAY_RATE.value * 100),
    );
  });

  test('every persona is a feasible operating plan, and reports its effective margin', () => {
    for (const id of Object.keys(PERSONAS) as Array<keyof typeof PERSONAS>) {
      const plan = deriveOperatingPlan(PERSONAS[id]);
      expect(plan.kind).toBe('coherent');
      expect(plan.effectiveMargin).toBeGreaterThan(0);
      expect(plan.effectiveMargin).toBeLessThanOrEqual(1);
    }
  });
});

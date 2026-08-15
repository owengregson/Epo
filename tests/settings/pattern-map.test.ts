import {
  PERSONAS,
  type PatternSettings,
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

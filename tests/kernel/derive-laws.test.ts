/**
 * The laws that make derivation worth more than declaration.
 *
 * A hand-written table can only be checked against itself. A derived one can be
 * checked against the PROPERTIES it must have for every input the fundamentals
 * could plausibly take — which is what turns "someone once tuned this" into
 * "this cannot go wrong without the build saying so".
 */

import fc from 'fast-check';
import {
  blockedStreakThreshold,
  breakerThreshold,
  CAUTION,
  coldFailingThreshold,
  defaultRateInputs,
  deriveOperatingPlan,
  driftConfirmThreshold,
  effectiveMargin,
  holdMedianFrom,
  holdMediansMs,
  holdSigma,
  type LatencyOp,
  type OrdinalPattern,
  pollEveryFrom,
  type RateInputs,
  RHYTHM,
  rateEnvelope,
  reentryFailThreshold,
  timeoutFrom,
} from '@/kernel/derive';
import { EMPIRICAL } from '@/kernel/fundamentals';
import { POLICY } from '@/kernel/policy';
import { type PatternSettings, PERSONAS, resolvePattern } from '@/settings/pattern-map';
import { RECOVERY, SESSION } from '@/timing/config';

const ACTIVITY_LEVELS = ['minimal', 'light', 'moderate', 'active', 'aggressive'] as const;
const CONSISTENCIES = ['clockwork', 'natural', 'erratic'] as const;
const RHYTHMS = ['trickle', 'sessions', 'bursts'] as const;
const CAUTIONS = ['cautious', 'standard', 'bold'] as const;
const DAY_SHAPES = ['morning', 'balanced', 'evening', 'nightowl', 'business'] as const;
const WEEK_SHAPES = ['uniform', 'weekdays', 'weekends', 'realistic'] as const;
const CLEANUPS = ['off', 'trickle', 'steady', 'deep'] as const;
const PATIENCES = ['quick', 'normal', 'patient'] as const;

const pattern = (o: Partial<PatternSettings> = {}): PatternSettings => ({ ...PERSONAS.balanced, ...o });

const anyPattern = fc.record({
  activityLevel: fc.constantFrom(...ACTIVITY_LEVELS),
  consistency: fc.constantFrom(...CONSISTENCIES),
  rhythm: fc.constantFrom(...RHYTHMS),
  dayShape: fc.constantFrom(...DAY_SHAPES),
  weeklyShape: fc.constantFrom(...WEEK_SHAPES),
  caution: fc.constantFrom(...CAUTIONS),
  cleanup: fc.constantFrom(...CLEANUPS),
  patience: fc.constantFrom(...PATIENCES),
}) as fc.Arbitrary<PatternSettings>;

/** ±20% on every empirical input D1/D2 consume. */
const perturbed: fc.Arbitrary<RateInputs> = fc
  .record({
    hourlyWallTypical: fc.double({ min: 0.8, max: 1.2, noNaN: true }),
    hourlyWallLow: fc.double({ min: 0.8, max: 1.2, noNaN: true }),
    dailyWallTypical: fc.double({ min: 0.8, max: 1.2, noNaN: true }),
    dailyWallLow: fc.double({ min: 0.8, max: 1.2, noNaN: true }),
    gapMedianMs: fc.double({ min: 0.8, max: 1.2, noNaN: true }),
    sessionBoundaryMs: fc.double({ min: 0.8, max: 1.2, noNaN: true }),
  })
  .map((f) => {
    const base = defaultRateInputs();
    return {
      hourlyWallTypical: base.hourlyWallTypical * f.hourlyWallTypical,
      hourlyWallLow: base.hourlyWallLow * f.hourlyWallLow,
      dailyWallTypical: base.dailyWallTypical * f.dailyWallTypical,
      dailyWallLow: base.dailyWallLow * f.dailyWallLow,
      gapMedianMs: base.gapMedianMs * f.gapMedianMs,
      sessionBoundaryMs: base.sessionBoundaryMs * f.sessionBoundaryMs,
    };
  });

describe('monotonicity — every ordinal knob moves its numbers in one direction', () => {
  test('activityLevel: the daily plan, ceiling and queue size all increase', () => {
    for (let i = 1; i < ACTIVITY_LEVELS.length; i += 1) {
      const lo = resolvePattern(pattern({ activityLevel: ACTIVITY_LEVELS[i - 1] }));
      const hi = resolvePattern(pattern({ activityLevel: ACTIVITY_LEVELS[i] }));
      expect(hi.dailyOperatingRate).toBeGreaterThan(lo.dailyOperatingRate);
      expect(hi.dailyHardCeiling).toBeGreaterThan(lo.dailyHardCeiling);
      expect(hi.dailyPlanSize).toBeGreaterThan(lo.dailyPlanSize);
      expect(effectiveMargin(ACTIVITY_LEVELS[i])).toBeGreaterThan(
        effectiveMargin(ACTIVITY_LEVELS[i - 1]),
      );
    }
  });

  test('caution: the hourly cap increases, the gap floor decreases', () => {
    for (let i = 1; i < CAUTIONS.length; i += 1) {
      expect(CAUTION[CAUTIONS[i]].cap).toBeGreaterThan(CAUTION[CAUTIONS[i - 1]].cap);
      expect(CAUTION[CAUTIONS[i]].floorSeconds).toBeLessThan(
        CAUTION[CAUTIONS[i - 1]].floorSeconds,
      );
    }
  });

  test('consistency: variance and rest-day chance increase together', () => {
    for (let i = 1; i < CONSISTENCIES.length; i += 1) {
      const lo = resolvePattern(pattern({ consistency: CONSISTENCIES[i - 1] }));
      const hi = resolvePattern(pattern({ consistency: CONSISTENCIES[i] }));
      expect(hi.dailyVolumeVariancePct).toBeGreaterThan(lo.dailyVolumeVariancePct);
      expect(hi.restDayChancePct).toBeGreaterThan(lo.restDayChancePct);
    }
  });

  test('rhythm trickle→bursts: fewer sessions, shorter gaps', () => {
    for (let i = 1; i < RHYTHMS.length; i += 1) {
      expect(RHYTHM[RHYTHMS[i]].min).toBeLessThan(RHYTHM[RHYTHMS[i - 1]].min);
      expect(RHYTHM[RHYTHMS[i]].max).toBeLessThan(RHYTHM[RHYTHMS[i - 1]].max);
      expect(RHYTHM[RHYTHMS[i]].gapMedianSeconds).toBeLessThan(
        RHYTHM[RHYTHMS[i - 1]].gapMedianSeconds,
      );
    }
  });

  test('the recovery ladder is strictly increasing in rung', () => {
    const holds = holdMediansMs();
    for (let i = 1; i < holds.length; i += 1) expect(holds[i]).toBeGreaterThan(holds[i - 1]);
  });

  test('a breaker threshold falls as the prior rises and as ordinary failure gets rarer', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.001, max: 0.4, noNaN: true }),
        fc.double({ min: 0.001, max: 0.4, noNaN: true }),
        fc.double({ min: 0.01, max: 0.5, noNaN: true }),
        (p1, p2, q) => {
          const [lo, hi] = p1 <= p2 ? [p1, p2] : [p2, p1];
          expect(breakerThreshold(hi, q)).toBeLessThanOrEqual(breakerThreshold(lo, q));
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('envelope — the derivation stays safe under ±20% on every empirical input', () => {
  test('operatingRate ≤ hardCeiling ≤ the observed daily wall', () => {
    fc.assert(
      fc.property(perturbed, anyPattern, (inputs, p) => {
        const e = rateEnvelope(inputs, p.caution, p.activityLevel, p.rhythm);
        expect(e.dailyPlan).toBeLessThanOrEqual(e.dailyHardCeiling);
        expect(e.dailyHardCeiling).toBeLessThanOrEqual(inputs.dailyWallTypical);
      }),
      { numRuns: 400 },
    );
  });

  test('the hourly cap over a waking day always covers the hard ceiling', () => {
    const WAKING_HOURS = 16;
    fc.assert(
      fc.property(perturbed, anyPattern, (inputs, p) => {
        const e = rateEnvelope(inputs, p.caution, p.activityLevel, p.rhythm);
        expect(e.hourlyCap * WAKING_HOURS).toBeGreaterThanOrEqual(e.dailyHardCeiling);
      }),
      { numRuns: 400 },
    );
  });

  test('the gap floor always enforces the burst tolerance (never permits a faster burst)', () => {
    fc.assert(
      fc.property(perturbed, fc.constantFrom(...CAUTIONS), (inputs, c) => {
        const e = rateEnvelope(inputs, c, 'moderate', 'sessions');
        const perHourAtFloor = 3_600 / e.gapFloorSeconds;
        expect(perHourAtFloor).toBeLessThanOrEqual(e.hourlyCap * POLICY.BURST_TOLERANCE);
      }),
      { numRuns: 400 },
    );
  });

  test('a gap cap never reaches the session boundary it protects', () => {
    fc.assert(
      fc.property(perturbed, (inputs) => {
        const e = rateEnvelope(inputs, 'standard', 'moderate', 'sessions');
        expect(e.gapCapMs).toBeLessThan(inputs.sessionBoundaryMs);
      }),
      { numRuns: 300 },
    );
  });
});

describe('safety floors — asserted against DERIVED values, so a fundamentals edit fails the build', () => {
  test('every gap floor is at least 20 s, for every caution and every ±20% wall', () => {
    fc.assert(
      fc.property(perturbed, fc.constantFrom(...CAUTIONS), (inputs, c) => {
        expect(rateEnvelope(inputs, c, 'moderate', 'sessions').gapFloorSeconds).toBeGreaterThanOrEqual(20);
      }),
      { numRuns: 400 },
    );
    for (const c of CAUTIONS) expect(CAUTION[c].floorSeconds).toBeGreaterThanOrEqual(20);
  });

  test('the first ladder rung is never shorter than 30 minutes', () => {
    expect(holdMediansMs()[0]).toBeGreaterThanOrEqual(30 * 60_000);
    fc.assert(
      fc.property(fc.double({ min: 0.8, max: 1.2, noNaN: true }), (f) => {
        expect(holdMedianFrom(EMPIRICAL.SOFT_WALL_DURATION_H.p50 * f, 1)).toBeGreaterThanOrEqual(
          30 * 60_000,
        );
      }),
      { numRuns: 200 },
    );
  });

  test('every timeout is at least the p99 it is derived from', () => {
    const ops = Object.keys(EMPIRICAL.LATENCY) as LatencyOp[];
    for (const op of ops) expect(timeoutFrom(EMPIRICAL.LATENCY[op].p99)).toBeGreaterThanOrEqual(
      EMPIRICAL.LATENCY[op].p99,
    );
    fc.assert(
      fc.property(fc.integer({ min: 1_000, max: 120_000 }), (p99) => {
        expect(timeoutFrom(p99)).toBeGreaterThanOrEqual(p99);
      }),
      { numRuns: 300 },
    );
  });

  test('a poll interval stays inside [100 ms, 1 s] whatever the p50 says', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 60_000 }), (p50) => {
        const every = pollEveryFrom(p50);
        expect(every).toBeGreaterThanOrEqual(100);
        expect(every).toBeLessThanOrEqual(1_000);
      }),
      { numRuns: 300 },
    );
  });

  test('the hold clamp keeps a draw a real hold: 0 < min < 1 < max', () => {
    expect(RECOVERY.HOLD_MIN_FACTOR).toBeGreaterThan(0);
    expect(RECOVERY.HOLD_MIN_FACTOR).toBeLessThan(1);
    expect(RECOVERY.HOLD_MAX_FACTOR).toBeGreaterThan(1);
    expect(holdSigma()).toBeGreaterThan(0);
  });
});

describe('ordering pairs — settings.ts AT_LEAST / AT_MOST hold without clamping', () => {
  const ALL: PatternSettings[] = [];
  for (const activityLevel of ACTIVITY_LEVELS)
    for (const consistency of CONSISTENCIES)
      for (const rhythm of RHYTHMS)
        for (const caution of CAUTIONS)
          for (const cleanup of CLEANUPS)
            for (const patience of PATIENCES)
              ALL.push(
                pattern({ activityLevel, consistency, rhythm, caution, cleanup, patience }),
              );

  test('the grid really is every combination that moves a number', () => {
    expect(ALL).toHaveLength(5 * 3 * 3 * 3 * 4 * 3);
  });

  test("AT_LEAST ['dailyHardCeiling','dailyOperatingRate'] never needs to clamp", () => {
    for (const p of ALL) {
      const r = resolvePattern(p);
      expect(r.dailyHardCeiling).toBeGreaterThanOrEqual(r.dailyOperatingRate);
    }
  });

  test("AT_LEAST ['sessionsPerDayMax','sessionsPerDayMin'] never needs to clamp", () => {
    for (const p of ALL) {
      const r = resolvePattern(p);
      expect(r.sessionsPerDayMax).toBeGreaterThanOrEqual(r.sessionsPerDayMin);
    }
  });

  test("AT_MOST ['gapFloorSeconds','gapMedianSeconds'] holds for every combination", () => {
    for (const p of ALL) {
      const r = resolvePattern(p);
      expect(r.gapFloorSeconds).toBeLessThanOrEqual(r.gapMedianSeconds);
    }
  });

  test('FINDING: the raw floor/median tables conflict for exactly one knob pair', () => {
    // `resolvePattern` takes `min(floor, median)`, so the ordering above always
    // holds — but the tables themselves disagree wherever a cautious floor meets
    // a burst median. Documented in ADR 0606; no shipped persona hits it.
    const clashes: string[] = [];
    for (const caution of CAUTIONS)
      for (const rhythm of RHYTHMS)
        if (CAUTION[caution].floorSeconds > RHYTHM[rhythm].gapMedianSeconds)
          clashes.push(`${caution}+${rhythm}`);
    expect(clashes).toEqual(['cautious+bursts']);
    for (const id of Object.keys(PERSONAS) as Array<keyof typeof PERSONAS>) {
      const p = PERSONAS[id];
      expect(CAUTION[p.caution].floorSeconds).toBeLessThanOrEqual(
        RHYTHM[p.rhythm].gapMedianSeconds,
      );
    }
  });

  test('the gap median never exceeds the gap cap that keeps a session alive', () => {
    for (const r of RHYTHMS) {
      expect(RHYTHM[r].gapMedianSeconds * 1_000).toBeLessThanOrEqual(SESSION.GAP_CAP_MS);
    }
  });
});

describe('coherence — deriveOperatingPlan', () => {
  test('no shipped persona is infeasible', () => {
    for (const id of Object.keys(PERSONAS) as Array<keyof typeof PERSONAS>) {
      const plan = deriveOperatingPlan(PERSONAS[id]);
      expect({ id, kind: plan.kind }).toEqual({ id, kind: 'coherent' });
      expect(plan.reachablePerDay).toBeGreaterThanOrEqual(plan.dailyPlan);
    }
  });

  test('no combination of the ordinal knobs is infeasible under the shipped field', () => {
    fc.assert(
      fc.property(anyPattern, (p) => {
        expect(deriveOperatingPlan(p).kind).toBe('coherent');
      }),
      { numRuns: 500 },
    );
  });

  test('a wall low enough to bind is reported as a Conflict, naming what binds', () => {
    const squeezed = { ...defaultRateInputs(), hourlyWallTypical: 12 };
    const p: OrdinalPattern = {
      activityLevel: 'aggressive',
      consistency: 'natural',
      rhythm: 'bursts',
      dayShape: 'nightowl',
      weeklyShape: 'realistic',
      caution: 'cautious',
      cleanup: 'off',
      patience: 'normal',
    };
    const plan = deriveOperatingPlan(p, squeezed);
    expect(plan.kind).toBe('conflict');
    if (plan.kind !== 'conflict') throw new Error('unreachable');
    expect(plan.binding).toBe('sessionMass');
    expect(plan.shortfall).toBeGreaterThan(0);
    expect(plan.shortfall).toBeCloseTo(plan.dailyPlan - plan.reachablePerDay, 6);
  });

  test('a Conflict is exactly "the plan exceeds what the pattern can reach"', () => {
    fc.assert(
      fc.property(anyPattern, perturbed, (p, inputs) => {
        const plan = deriveOperatingPlan(p, inputs);
        expect(plan.kind === 'conflict').toBe(plan.dailyPlan > plan.reachablePerDay);
      }),
      { numRuns: 400 },
    );
  });
});

describe('the three defects the derivation exposes', () => {
  test('(a) the prune cool-down is no longer shorter than the wall it sits out', () => {
    const p50Ms = EMPIRICAL.SOFT_WALL_DURATION_H.p50 * 3_600_000;
    expect(RECOVERY.PRUNE_COOLDOWN_AFTER_RATE_HALT_MS).toBeGreaterThanOrEqual(p50Ms);
  });

  test('(b) the effective margin per activity level is a reportable number, and aggressive is 1.00', () => {
    expect(ACTIVITY_LEVELS.map(effectiveMargin)).toEqual([0.15, 0.3, 0.5, 0.75, 1]);
    // i.e. `aggressive` operates at 100% of the LOW end of the observed daily
    // wall. The Rate & Safety card should show this, not hide it in a scale.
    expect(effectiveMargin('aggressive')).toBe(1);
    expect(deriveOperatingPlan(pattern({ activityLevel: 'aggressive' })).effectiveMargin).toBe(1);
  });

  test('(c) the feasibility check exists and, on the shipped field, the tightest config still has headroom', () => {
    let tightest = Number.POSITIVE_INFINITY;
    for (const activityLevel of ACTIVITY_LEVELS)
      for (const caution of CAUTIONS)
        for (const dayShape of DAY_SHAPES)
          for (const weeklyShape of WEEK_SHAPES) {
            const plan = deriveOperatingPlan(
              pattern({ activityLevel, caution, dayShape, weeklyShape }),
            );
            tightest = Math.min(tightest, plan.reachablePerDay / plan.dailyPlan);
          }
    // The lens pass predicted `nightowl + aggressive + cautious` would be
    // infeasible at H_eff ≈ 6.1 h. Against the app's real circadian field the
    // night-owl shape has the LARGEST session mass of the five (≈14.3 h), so it
    // is feasible; the binding case is the morning/weekday shape. See ADR 0606.
    expect(tightest).toBeGreaterThan(1);
    expect(tightest).toBeLessThan(1.5);
    const owl = deriveOperatingPlan(
      pattern({ dayShape: 'nightowl', activityLevel: 'aggressive', caution: 'cautious' }),
    );
    expect(owl.kind).toBe('coherent');
    expect(owl.sessionMassHours).toBeGreaterThan(
      deriveOperatingPlan(pattern({ dayShape: 'balanced' })).sessionMassHours,
    );
  });
});

describe('breaker thresholds reproduce the shipped streak constants', () => {
  test('cold 7, probing-after-a-hold 2, blocked 3, drift 2', () => {
    expect(coldFailingThreshold()).toBe(7);
    expect(reentryFailThreshold()).toBe(2);
    expect(blockedStreakThreshold()).toBe(3);
    expect(driftConfirmThreshold()).toBe(2);
    expect(RECOVERY.REENTRY_FAILS).toBe(reentryFailThreshold());
    expect(RECOVERY.BLOCKED_STREAK_ENTRY).toBe(blockedStreakThreshold());
  });

  test('a threshold always reaches the required confidence, and one fewer does not', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.001, max: 0.5, noNaN: true }),
        fc.double({ min: 0.02, max: 0.5, noNaN: true }),
        (prior, q) => {
          const k = breakerThreshold(prior, q);
          const odds = (n: number) => (prior / (1 - prior)) * (1 / q) ** n;
          const needed = POLICY.CONFIDENCE / (1 - POLICY.CONFIDENCE);
          expect(odds(k)).toBeGreaterThanOrEqual(needed * (1 - 1e-9));
          if (k > 1) expect(odds(k - 1)).toBeLessThan(needed);
        },
      ),
      { numRuns: 400 },
    );
  });
});

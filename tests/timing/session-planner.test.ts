import type { CircadianProfile } from '@/timing/circadian';
import {
  localDayKey,
  type PlannerSnapshot,
  SessionPlanner,
  type SessionPlannerConfig,
} from '@/timing/session-planner';

const mulberry32 = (seed: number) => (): number => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const PROFILE: CircadianProfile = {
  bumps: [
    { centerHour: 8.0, amplitude: 0.45, widthHours: 1.6 },
    { centerHour: 13.0, amplitude: 0.5, widthHours: 2.0 },
    { centerHour: 18.0, amplitude: 1.0, widthHours: 3.0 },
  ],
  overnightFloor: 0.015,
  dayOfWeekWeights: [0.9, 1.0, 1.08, 1.08, 1.0, 1.02, 0.92],
  weekendShiftHours: 1.4,
  phaseOffsetHours: 0,
};

const BASE: SessionPlannerConfig = {
  dailyMeanActions: 25,
  dailyHardCeiling: 40,
  dayVolumeSigma: 0.28,
  restDayProbability: 0,
  restDayMaxFraction: 0.15,
  sessionsPerDayMin: 3,
  sessionsPerDayMax: 6,
  gapMedianMs: 95_000,
  gapSigma: 0.75,
  gapFloorMs: 45_000,
  gapCapMs: 8 * 60_000,
  hawkesAlpha: 0.35,
  hawkesTauMs: 90_000,
  maxActionsPerRollingHour: 22,
};

const cfg = (o: Partial<SessionPlannerConfig> = {}): SessionPlannerConfig => ({ ...BASE, ...o });
const make = (seed: number, c = BASE, snapshot?: PlannerSnapshot): SessionPlanner =>
  new SessionPlanner({ rng: mulberry32(seed), profile: PROFILE, cfg: c, snapshot });

// Jan 5 2026 = Monday.
const mon = (h: number, m = 0): number => new Date(2026, 0, 5, h, m).getTime();
const avg = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;

describe('SessionPlanner — daily volume', () => {
  test('rolls the day and draws a target within [0, hardCeiling]', () => {
    const p = make(11);
    p.advance(mon(9));
    const t = p.dailyTarget(mon(9));
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThanOrEqual(BASE.dailyHardCeiling);
  });

  test('a rest day draws a small target', () => {
    const p = make(3, cfg({ restDayProbability: 1 }));
    p.advance(mon(9));
    expect(p.dailyTarget(mon(9))).toBeLessThanOrEqual(Math.round(25 * 0.15));
  });

  test('daily target is a distribution: mean near the config mean, real day-to-day variance, some rest days', () => {
    const p = make(123, cfg({ restDayProbability: 0.08 }));
    const targets: number[] = [];
    for (let d = 0; d < 400; d++) {
      const t = new Date(2026, 0, 1 + d, 12, 0).getTime();
      p.advance(t);
      targets.push(p.dailyTarget(t));
    }
    const mean = avg(targets);
    const cv = Math.sqrt(avg(targets.map((x) => (x - mean) ** 2))) / mean;
    expect(Math.abs(mean - 25) / 25).toBeLessThan(0.12);
    expect(cv).toBeGreaterThan(0.18);
    expect(cv).toBeLessThan(0.6);
    expect(targets.some((x) => x < 25 * 0.3)).toBe(true);
    expect(targets.every((x) => x <= BASE.dailyHardCeiling)).toBe(true);
  });
});

describe('SessionPlanner — sessions', () => {
  // A snapshot with a session due at mon(15) — deterministic, independent of thinning.
  const openable = (): PlannerSnapshot => ({
    v: 1,
    dayKey: localDayKey(mon(15)),
    dayTarget: 20,
    dayUsed: 0,
    dayPlan: [{ startAt: mon(15), budget: 8 }], // one session that day
    nextPlanIdx: 0,
    session: null,
    recentActions: [],
    phaseOffsetHours: 0,
  });

  test('a session is closed before its start and open after', () => {
    const p = make(11, BASE, openable());
    expect(p.isSessionOpen(mon(15) - 1000)).toBe(false);
    expect(p.isSessionOpen(mon(15) + 1000)).toBe(true);
  });

  test('a session closes once its budget is spent', () => {
    const p = make(21, BASE, openable());
    let t = mon(15) + 1000;
    expect(p.isSessionOpen(t)).toBe(true);
    let count = 0;
    while (p.isSessionOpen(t) && count < 1000) {
      p.recordAction(t, 'follow');
      count += 1;
      t += 60_000;
      p.advance(t);
    }
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(20); // ≤ the day target
    expect(p.isSessionOpen(t)).toBe(false);
  });

  test('sessionEndsAt is a future estimate while open, null while closed', () => {
    const p = make(11, BASE, openable());
    expect(p.sessionEndsAt(mon(15) - 1000)).toBeNull();
    p.advance(mon(15) + 1000);
    const end = p.sessionEndsAt(mon(15) + 1000);
    expect(end).not.toBeNull();
    expect(end as number).toBeGreaterThan(mon(15));
  });
});

describe('SessionPlanner — within-session gaps', () => {
  test('every gap respects the floor', () => {
    const p = make(5);
    p.advance(mon(12));
    for (let i = 0; i < 500; i++) {
      expect(p.nextActionGapMs(mon(12))).toBeGreaterThanOrEqual(BASE.gapFloorMs);
    }
  });

  test('Hawkes self-excitation shortens the gap right after recent actions', () => {
    const c = cfg({ gapFloorMs: 1000 }); // low floor so the effect is visible
    const cold = make(1, c);
    cold.advance(mon(12));
    const coldGaps = Array.from({ length: 400 }, () => cold.nextActionGapMs(mon(12)));

    const hot = make(1, c);
    hot.advance(mon(12));
    for (let i = 0; i < 3; i++) hot.recordAction(mon(12), 'follow');
    const hotGaps = Array.from({ length: 400 }, () => hot.nextActionGapMs(mon(12)));

    expect(avg(hotGaps)).toBeLessThan(avg(coldGaps) * 0.8);
  });

  test('the rolling-hour velocity guard pushes the next gap past the window', () => {
    const p = make(5, cfg({ maxActionsPerRollingHour: 5 }));
    p.advance(mon(12));
    for (let i = 0; i < 5; i++) p.recordAction(mon(12) + i * 60_000, 'follow');
    expect(p.nextActionGapMs(mon(12) + 5 * 60_000)).toBeGreaterThan(30 * 60_000);
  });
});

describe('SessionPlanner — action accounting', () => {
  test('only follows spend the daily budget; unfollows and reads are weaved in on top', () => {
    const p = make(2);
    p.advance(mon(12));
    const before = p.serialize().dayUsed;
    p.recordAction(mon(12), 'read-burst');
    p.recordAction(mon(12), 'unfollow');
    expect(p.serialize().dayUsed).toBe(before); // neither spends the follow plan
    p.recordAction(mon(12), 'follow');
    expect(p.serialize().dayUsed).toBe(before + 1);
  });
});

describe('SessionPlanner — durability (§3)', () => {
  test('serialize → hydrate round-trips state exactly', () => {
    const p = make(2);
    p.advance(mon(9));
    p.recordAction(mon(9), 'follow');
    p.nextActionGapMs(mon(9));
    const snap = p.serialize();
    const p2 = make(2, BASE, snap);
    expect(p2.serialize()).toEqual(snap);
  });

  test('hydrating an open-session snapshot restores it (overdue catch-up)', () => {
    const snap: PlannerSnapshot = {
      v: 1,
      dayKey: localDayKey(mon(17)),
      dayTarget: 20,
      dayUsed: 2,
      dayPlan: [{ startAt: mon(17), budget: 8 }],
      nextPlanIdx: 1,
      session: { startedAt: mon(17), budget: 8, used: 2 },
      recentActions: [{ at: mon(17), kind: 'follow' }],
      phaseOffsetHours: 0,
    };
    const p = make(1, BASE, snap);
    expect(p.isSessionOpen(mon(17) + 120_000)).toBe(true);
  });

  test('a stale day-key snapshot triggers a fresh day-draw on the next query', () => {
    const snap: PlannerSnapshot = {
      v: 1,
      dayKey: 'stale-key',
      dayTarget: 999,
      dayUsed: 999,
      dayPlan: [],
      nextPlanIdx: 0,
      session: null,
      recentActions: [],
      phaseOffsetHours: 0,
    };
    const p = make(4, cfg({ restDayProbability: 0 }), snap);
    const t = p.dailyTarget(mon(9));
    expect(t).toBeLessThanOrEqual(BASE.dailyHardCeiling); // re-drawn, not the stale 999
    expect(p.serialize().dayUsed).toBe(0);
  });
});

describe('SessionPlanner — determinism', () => {
  test('same seed and call sequence produce identical state', () => {
    const run = (p: SessionPlanner): unknown => {
      p.advance(mon(9));
      const a = p.dailyTarget(mon(9));
      const s = p.nextSessionStartAt(mon(9));
      p.recordAction(s, 'follow');
      const g = p.nextActionGapMs(s);
      return { a, s, g, snap: p.serialize() };
    };
    expect(run(make(7))).toEqual(run(make(7)));
  });
});

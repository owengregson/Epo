/**
 * D6 — the read allowance derives from the live limits (live 2026-11-02: a
 * hardcoded 80 visits a day against a 98-a-day ceiling meant the plan could
 * never be delivered, and reconciliation alone starved growth).
 *
 * Pinned: which sentence produces which number, that every share covers the
 * work it pays for at every knob point, that it moves with the activity knob,
 * and that no hand-picked default can creep back into the governor.
 */
import * as readBudgetModule from '@/governors/read-budget';
import { deriveReadAllowance, explorationSlices, profileReadShares, type ReadDemand } from '@/kernel/derive-reads';
import { EXPLORATION_POLICY } from '@/kernel/exploration-policy';
import { BOUNDS } from '@/kernel/policy';
import { type PatternSettings, PERSONAS, resolvePattern } from '@/settings/pattern-map';
import { toReadAllowance } from '@/settings/read-allowance';
import { DEFAULT_SETTINGS } from '@/settings/settings';

const ACTIVITY_LEVELS = ['minimal', 'light', 'moderate', 'active', 'aggressive'] as const;
const SWEEP_HOURS = [0.5, 1, 4, 24, 168];

/** The demand a resolved pattern places, at a given sweep cadence. */
const demandOf = (p: PatternSettings, followbackSweepHours: number): ReadDemand => {
  const r = resolvePattern(p);
  return { dailyHardCeiling: r.dailyHardCeiling, dailyPlanSize: r.dailyPlanSize, followbackSweepHours, sessionsPerDayMax: r.sessionsPerDayMax };
};

const everyPoint = (): Array<[string, ReadDemand]> => {
  const out: Array<[string, ReadDemand]> = [];
  for (const [id, persona] of Object.entries(PERSONAS)) {
    for (const activityLevel of ACTIVITY_LEVELS) {
      for (const hours of SWEEP_HOURS) out.push([`${id}/${activityLevel}/${hours}h`, demandOf({ ...persona, activityLevel }, hours)]);
    }
  }
  return out;
};

describe('identity: the live install (ceiling 98, plan size 90, hourly sweeps, ≤4 sessions)', () => {
  const live: ReadDemand = { dailyHardCeiling: 98, dailyPlanSize: 90, followbackSweepHours: 1, sessionsPerDayMax: 4 };

  test('profiles = verify 98 + reconcile ⌈98 × 1.3⌉ + exploration 9 slices × (20 + 1)', () => {
    expect(explorationSlices(live)).toBe(9);
    expect(profileReadShares(live)).toEqual({ verify: 98, reconcile: 128, exploration: 189 });
    expect(deriveReadAllowance(live)).toMatchObject({ profiles: 415, explorationProfiles: 189 });
  });

  test('list pages = one census walk (200) + 9 slices × (2 + 1); notifications = 24 sweeps + 4 sessions', () => {
    expect(deriveReadAllowance(live)).toMatchObject({ listPages: 227, explorationPages: 27, notifications: 28, windowMs: 86_400_000 });
  });
});

describe('laws, at every persona × activity × sweep cadence', () => {
  test.each(everyPoint())('%s: each share covers the work it pays for', (_key, d) => {
    const a = deriveReadAllowance(d);
    // Every admitted mutation reads its profile at the click; every follow comes due once.
    expect(a.profiles - a.explorationProfiles).toBeGreaterThanOrEqual(2 * d.dailyHardCeiling);
    // Every queued candidate was read at least once.
    expect(a.explorationProfiles).toBeGreaterThanOrEqual(d.dailyPlanSize);
    // Exploration is a sub-limit: the reserve that verifies and reconciles always exists.
    expect(a.explorationProfiles).toBeLessThan(a.profiles);
    expect(a.explorationPages).toBeLessThan(a.listPages);
    // A full census walk fits beside the slices.
    expect(a.listPages - a.explorationPages).toBe(BOUNDS.RIM.LIST_WALK_MAX_PAGES);
    // Every scheduled sweep reads the feed, with room for each session's return.
    expect(a.notifications).toBeGreaterThanOrEqual(Math.ceil(24 / d.followbackSweepHours) + d.sessionsPerDayMax);
  });

  test.each(Object.entries(PERSONAS))('%s: the allowance never shrinks as the activity knob rises', (_id, persona) => {
    const rungs = ACTIVITY_LEVELS.map((activityLevel) => deriveReadAllowance(demandOf({ ...persona, activityLevel }, 1)));
    for (let i = 1; i < rungs.length; i++) {
      for (const key of ['profiles', 'explorationProfiles', 'listPages', 'explorationPages'] as const) {
        expect(rungs[i]![key]).toBeGreaterThanOrEqual(rungs[i - 1]![key]);
      }
    }
  });

  test('the slice shape it derives from is the one exploration runs with', () => {
    expect(explorationSlices({ dailyPlanSize: EXPLORATION_POLICY.queuedPerSource })).toBe(1);
    expect(explorationSlices({ dailyPlanSize: EXPLORATION_POLICY.queuedPerSource + 1 })).toBe(2);
  });
});

describe('the governor holds no numbers of its own', () => {
  test('no default ceilings are exported (they were the hardcoded 80/40/200/24/24)', () => {
    expect(Object.keys(readBudgetModule)).not.toContain('READ_BUDGET_DEFAULTS');
  });

  test('the live mapping reads the settings the limit system resolved, and follows a change', () => {
    const base = toReadAllowance(DEFAULT_SETTINGS);
    expect(base).toEqual(deriveReadAllowance({
      dailyHardCeiling: DEFAULT_SETTINGS.dailyHardCeiling,
      dailyPlanSize: DEFAULT_SETTINGS.dailyPlanSize,
      followbackSweepHours: DEFAULT_SETTINGS.followbackSweepHours,
      sessionsPerDayMax: DEFAULT_SETTINGS.sessionsPerDayMax,
    }));
    const busier = toReadAllowance({ ...DEFAULT_SETTINGS, dailyHardCeiling: DEFAULT_SETTINGS.dailyHardCeiling + 10 });
    expect(busier.profiles).toBeGreaterThan(base.profiles);
  });
});

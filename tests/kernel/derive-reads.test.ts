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
import {
  censusFollowerPages,
  censusPagesMax,
  derivePlanReadAllowance,
  explorationSlices,
  frontierPages,
  type PlanReadDemand,
  profileReadShares,
} from '@/kernel/derive-reads';
import { EXPLORATION_POLICY } from '@/kernel/exploration-policy';
import { BOUNDS } from '@/kernel/policy';
import { effectiveFromV1 } from '@/settings/effective';
import { type PatternSettings, PERSONAS, resolvePattern } from '@/settings/pattern-map';
import { toReadAllowance } from '@/settings/read-allowance';
import { DEFAULT_SETTINGS } from '@/settings/settings';

const ACTIVITY_LEVELS = ['minimal', 'light', 'moderate', 'active', 'aggressive'] as const;
/** The plan's check terms a day can need, across the cadences a persona runs at. */
const CHECKS = [1, 11, 48];

/** The plan-day demand a resolved pattern places, at a given number of mid-session checks. */
const demandOf = (p: PatternSettings, checksPerDayMax: number): PlanReadDemand => {
  const r = resolvePattern(p);
  return { dailyHardCeiling: r.dailyHardCeiling, dailyPlanSize: r.dailyPlanSize, sessionsPerDayMax: r.sessionsPerDayMax,
    checksPerDayMax, censusPagesMax: BOUNDS.RIM.LIST_WALK_MAX_PAGES, frontierPages: frontierPages(r.sessionsPerDayMax) };
};

const everyPoint = (): Array<[string, PlanReadDemand]> => {
  const out: Array<[string, PlanReadDemand]> = [];
  for (const [id, persona] of Object.entries(PERSONAS)) {
    for (const activityLevel of ACTIVITY_LEVELS) {
      for (const checks of CHECKS) out.push([`${id}/${activityLevel}/${checks} checks`, demandOf({ ...persona, activityLevel }, checks)]);
    }
  }
  return out;
};

describe('identity: the live install (ceiling 98, plan size 90, ≤4 sessions)', () => {
  const live = { dailyHardCeiling: 98, dailyPlanSize: 90, sessionsPerDayMax: 4 };

  test('profiles = verify 98 + reconcile ⌈98 × 1.3⌉ + exploration 9 slices × (20 + 1)', () => {
    expect(explorationSlices(live)).toBe(9);
    expect(profileReadShares(live)).toEqual({ verify: 98, reconcile: 128, exploration: 189 });
  });
});

describe('laws, at every persona × activity × check count', () => {
  test.each(everyPoint())('%s: each share covers the work it pays for', (_key, d) => {
    const a = derivePlanReadAllowance(d);
    // Every admitted mutation reads its profile at the click; every follow comes due once.
    expect(a.profiles - a.explorationProfiles).toBeGreaterThanOrEqual(2 * d.dailyHardCeiling);
    // Click-time verification always fits: the reserve is the ceiling, inside the non-exploration share.
    expect(a.verifyReserve).toBe(d.dailyHardCeiling);
    expect(a.profiles - a.verifyReserve).toBeGreaterThanOrEqual(a.explorationProfiles);
    // Every queued candidate was read at least once.
    expect(a.explorationProfiles).toBeGreaterThanOrEqual(d.dailyPlanSize);
    // Exploration is a sub-limit: the reserve that verifies and reconciles always exists.
    expect(a.explorationProfiles).toBeLessThan(a.profiles);
    expect(a.explorationPages).toBeLessThan(a.listPages);
    // A full census walk and the head walks fit beside the slices.
    expect(a.listPages - a.explorationPages).toBe(d.censusPagesMax + d.frontierPages);
    // One check at each session start, and every mid-session check the day can need.
    expect(a.notifications).toBe(d.sessionsPerDayMax + d.checksPerDayMax);
  });

  test.each(Object.entries(PERSONAS))('%s: the allowance never shrinks as the activity knob rises', (_id, persona) => {
    const rungs = ACTIVITY_LEVELS.map((activityLevel) => derivePlanReadAllowance(demandOf({ ...persona, activityLevel }, 1)));
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
    const base = toReadAllowance(effectiveFromV1(DEFAULT_SETTINGS));
    expect(base.verifyReserve).toBe(DEFAULT_SETTINGS.dailyHardCeiling);
    const busier = toReadAllowance(effectiveFromV1({ ...DEFAULT_SETTINGS, dailyHardCeiling: DEFAULT_SETTINGS.dailyHardCeiling + 10 }));
    expect(busier.profiles).toBeGreaterThan(base.profiles);
  });

  test('the census term sizes from the own header once one is known (unknown keeps 200)', () => {
    const e = effectiveFromV1(DEFAULT_SETTINGS);
    const unknown = toReadAllowance(e);
    const small = toReadAllowance(e, { ownHeader: { followers: 300, following: 400 }, census: { lastCompleteAt: null, rowsPerPage: 50 } });
    expect(unknown.listPages - small.listPages).toBe(BOUNDS.RIM.LIST_WALK_MAX_PAGES - censusPagesMax({ followers: 300 }, 50, 50));
  });
});

describe('the plan-day allowance (ADR 0607, spec §5.8 layer 1)', () => {
  const live = { dailyHardCeiling: 98, dailyPlanSize: 90, sessionsPerDayMax: 4 };
  const balanced = { dailyHardCeiling: 65, dailyPlanSize: 60, sessionsPerDayMax: 6 };

  test('identity: profiles 415 / exploration 189 unchanged; the verify reserve is the ceiling', () => {
    const a = derivePlanReadAllowance({ ...live, checksPerDayMax: 11, censusPagesMax: 200, frontierPages: frontierPages(4) });
    expect(a).toMatchObject({ profiles: 415, explorationProfiles: 189, verifyReserve: 98, explorationPages: 27 });
    expect(a.listPages).toBe(27 + 200 + 25);
    expect(a.notifications).toBe(4 + 11);
  });

  test('balanced: profiles 276; pages 218 → 253 (the frontier term is 7 × 5); notifications 30 → 17', () => {
    const a = derivePlanReadAllowance({ ...balanced, checksPerDayMax: 11, censusPagesMax: 200, frontierPages: frontierPages(6) });
    expect(a.profiles).toBe(276);
    expect(a.listPages).toBe(253);
    expect(a.notifications).toBe(17);
  });

  test('census pages are header-relative and bounded; an unknown header keeps 200', () => {
    expect(censusPagesMax({ followers: null }, null, 50)).toBe(200);
    expect(censusFollowerPages(4500, 50)).toBe(Math.ceil((4500 * 1.1) / 50) + 2);
    expect(censusFollowerPages(4500, 3)).toBe(Math.ceil((4500 * 1.1) / 10) + 2);
    expect(censusPagesMax({ followers: 1_000_000 }, 50, 50)).toBe(1_000);
    expect(censusPagesMax({ followers: 2000 }, null, 50)).toBe(censusFollowerPages(2000, 50));
  });

  test('the frontier term is the catch-up plus one head walk per session start', () => {
    expect(frontierPages(6)).toBe(35);
    expect(frontierPages(0)).toBe(5);
  });
});

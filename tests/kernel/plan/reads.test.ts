/**
 * Law L8 (spec §5.8): the plan's reads — explore, census, head walks, the catch-up and the following
 * check — stay inside the plan-day D6 totals everywhere, Boost at automaticDayMax included; head walks
 * never spend the census term; explore at (V = P0, U = 0) is D6's exploration share; overrides never
 * raise a total.
 */
import fc from 'fast-check';
import { derivePlanReadAllowance } from '@/kernel/derive-reads';
import { fitVolume, layoutSessions } from '@/kernel/plan/layout';
import {
  censusWalkMax,
  checkSpacingMin,
  checksPerDayMax,
  planReadAllowance,
  planReadDemand,
  planReads,
} from '@/kernel/plan/reads';
import { planSeed } from '@/kernel/plan/seed';
import { allocateKinds, automaticDayMax } from '@/kernel/plan/volume';
import { REFERENCE_TEMPO } from '@/kernel/tempo';
import { MS_PER_HOUR, MS_PER_MINUTE } from '@/kernel/units';
import { drawInput, emptyDemand, testIntent } from '../../kit/plan';

const DAY0 = new Date(2026, 10, 3, 12).getTime();

describe('the plan-day D6 for an intent', () => {
  test('balanced: 11 mid-day checks at most (spacing ≥ 51 min) → 17 notifications; pages 253', () => {
    const intent = testIntent();
    expect(checkSpacingMin(intent) / MS_PER_MINUTE).toBeCloseTo(51, 6);
    expect(checksPerDayMax(intent)).toBe(11);
    const a = planReadAllowance(intent, emptyDemand());
    expect(a).toMatchObject({ profiles: 276, notifications: 17, listPages: 253, verifyReserve: 65 });
  });

  test('no plan override raises a total (slower gaps, sparser checks, tempo factors, a cleanup cap)', () => {
    const base = planReadAllowance(testIntent(), emptyDemand());
    const over = planReadAllowance(testIntent({
      gapTargetOverrideMs: 600_000, gapFloorOverrideMs: 200_000, checkSpacingOverrideMs: 3 * MS_PER_HOUR,
      tempoOverrides: { 'walk.page': 3 }, cleanupPerDayCap: 2,
    }), emptyDemand());
    for (const key of Object.keys(base) as (keyof typeof base)[]) expect(over[key]).toBeLessThanOrEqual(base[key]);
  });

  test('a known header sizes the census by its followers, and the following list rides the census term', () => {
    const d = emptyDemand({ ownHeader: { followers: 4500, following: 900 }, census: { lastCompleteAt: null, rowsPerPage: 50 } });
    expect(planReadDemand(testIntent(), d, { followingWalkPages: 2 }).censusPagesMax).toBe(Math.ceil(4950 / 50) + 2 + 2);
  });
});

describe('L8: the plan reads fit D6', () => {
  test('explore, census, head walks, catch-up and the following check fit; checks fit the notifications total', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 40 }), fc.integer({ min: 15, max: 100 }), fc.boolean(),
      fc.record({ journalPending: fc.integer({ min: 0, max: 400 }), protectedReeval: fc.integer({ min: 0, max: 200 }),
        lifecycleDueByDayEnd: fc.integer({ min: 0, max: 50 }), pendingRequests: fc.integer({ min: 0, max: 20 }) }),
      fc.constantFrom(0, 0.36, 0.71), fc.integer({ min: 0, max: 3 }), (day, p0, boost, dem, share, following) => {
        const intent = testIntent({ operatingRate: p0, hardCeiling: Math.round(p0 * 1.3), cleanupShare: share });
        const demand = emptyDemand(dem);
        const input = drawInput(DAY0 + day * 24 * MS_PER_HOUR, { intent, demand });
        const seed = planSeed(input.installEntropy, input.window.key);
        const v = fitVolume(seed, input, automaticDayMax(p0));
        const kinds = allocateKinds(v, intent, demand, boost);
        const sessions = layoutSessions(seed, input, v, kinds);
        const facts = { followingWalkPages: following };
        const { plan } = planReads(input, kinds, sessions, facts);
        const d6 = planReadAllowance(intent, demand, facts);
        const pages = plan.explorePages + plan.census + plan.following + plan.checkPages + plan.catchUp.pages;
        const nonVerify = plan.explore + plan.catchUp.profiles + (plan.reconcile - kinds.follow - kinds.unfollow - kinds.accept);
        return pages <= d6.listPages
          && plan.checkPages + plan.catchUp.pages <= planReadDemand(intent, demand, facts).frontierPages
          && plan.explore + plan.reconcile + plan.catchUp.profiles <= d6.profiles
          && nonVerify <= d6.profiles - d6.verifyReserve
          && plan.explore <= d6.explorationProfiles && plan.explorePages <= d6.explorationPages
          && plan.checks + plan.catchUp.notifications <= d6.notifications;
      }), { numRuns: 60 });
  });

  test('explore at (V = P0, U = 0) equals D6\'s exploration share', () => {
    for (const p0 of [15, 30, 50, 75, 100]) {
      const intent = testIntent({ operatingRate: p0, acceptRequests: false });
      const input = drawInput(DAY0, { intent });
      const kinds = allocateKinds(p0, intent, emptyDemand(), false);
      const sessions = layoutSessions(planSeed(input.installEntropy, input.window.key), input, p0, kinds);
      expect(sessions.length).toBeGreaterThan(0);
      const { plan } = planReads(input, kinds, sessions);
      const d6 = derivePlanReadAllowance(planReadDemand(intent, emptyDemand()));
      expect(kinds.follow).toBe(p0);
      expect(plan.explore).toBe(d6.explorationProfiles);
      expect(plan.explorePages).toBe(d6.explorationPages);
    }
  });

  test('sessions carry their buckets: explore follows the follows, reconcile ≥ 1, one check at each start', () => {
    const input = drawInput(DAY0, { demand: emptyDemand({ lifecycleDueByDayEnd: 6, journalPending: 3 }) });
    const seed = planSeed(input.installEntropy, input.window.key);
    const kinds = allocateKinds(40, input.intent, input.demand, false);
    const sessions = layoutSessions(seed, input, 40, kinds);
    const { plan, sessions: per } = planReads(input, kinds, sessions);
    expect(per.reduce((a, r) => a + r.explore, 0)).toBe(plan.explore);
    for (const r of per) {
      expect(r.reconcile).toBeGreaterThanOrEqual(1);
      expect(r.checks).toBeGreaterThanOrEqual(1);
      expect(r.checkPages).toBe(2);
    }
  });
});

describe('census sizing for the host session', () => {
  test('censusWalkMax grows with the remaining window, stops at the bound, and is zero with no time left', () => {
    const short = censusWalkMax({ remainingMs: 10 * MS_PER_MINUTE, tempo: REFERENCE_TEMPO });
    const long = censusWalkMax({ remainingMs: 30 * MS_PER_MINUTE, tempo: REFERENCE_TEMPO });
    expect(short).toBeGreaterThan(0);
    expect(long).toBeGreaterThan(short);
    expect(censusWalkMax({ remainingMs: 100 * MS_PER_HOUR, tempo: REFERENCE_TEMPO })).toBe(1_000);
    expect(censusWalkMax({ remainingMs: 0, tempo: REFERENCE_TEMPO })).toBe(0);
    const slow = censusWalkMax({ remainingMs: 30 * MS_PER_MINUTE, tempo: { ...REFERENCE_TEMPO, pace: 1.45 } });
    expect(slow).toBeLessThan(long);
  });
});


test('head allowance uses gains and measured page size; missing history reserves only the frontier run', () => {
  const read = (headGainsHint?: number, rowsPerPage: number | null = null) => {
    const input = drawInput(DAY0, { demand: emptyDemand({ headGainsHint, census: { lastCompleteAt: null, rowsPerPage } }) });
    const seed = planSeed(input.installEntropy, input.window.key);
    const kinds = allocateKinds(40, input.intent, input.demand, false);
    const sessions = layoutSessions(seed, input, 40, kinds);
    return planReads(input, kinds, sessions);
  };
  expect(read().plan.catchUp.pages).toBe(2);
  expect(read(40, 20).plan.catchUp.pages).toBe(4);
  const large = read(1000, 20);
  expect(large.plan.catchUp.pages).toBe(5);
  expect(large.sessions.filter((s) => s.checks > 0).every((s) => s.checkPages === 5)).toBe(true);
});

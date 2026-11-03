/**
 * Budgets per kind (spec §5.7, laws L1 and L12): lifecycle first, cleanup at its share of the room,
 * accepts up to half the rest, follows never above P0 and yielding to a lifecycle backlog outside
 * Boost; a drawer pass accepts at most what the hourly cap leaves above its sustained rate.
 */
import fc from 'fast-check';
import { CAUTION } from '@/kernel/derive';
import { acceptsPerPass, allocateKinds, isDayOff } from '@/kernel/plan/volume';
import { emptyDemand, testIntent } from '../../kit/plan';

const demandArb = fc.record({
  lifecycleDueByDayEnd: fc.integer({ min: 0, max: 80 }),
  lifecycleBacklog: fc.integer({ min: 0, max: 300 }),
  pruneStock: fc.integer({ min: 0, max: 500 }),
  pendingRequests: fc.integer({ min: 0, max: 40 }),
  acceptsRecent: fc.double({ min: 0, max: 10, noNaN: true }),
  followsDoneToday: fc.integer({ min: 0, max: 120 }),
});

describe('allocateKinds', () => {
  test('L1: kinds sum to V; unfollows ≤ ⌊V/2⌋ outside Boost and 0 inside; follows ≤ P0 − done; accepts ≤ ⌊(V − U)/2⌋', () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 100 }), fc.integer({ min: 1, max: 100 }), demandArb, fc.boolean(),
      fc.constantFrom(0, 0.36, 0.71), fc.option(fc.integer({ min: 0, max: 30 }), { nil: null }), fc.boolean(),
      (v, p0, d, boost, share, cap, accept) => {
        const k = allocateKinds(v, testIntent({ operatingRate: p0, cleanupShare: share, cleanupPerDayCap: cap, acceptRequests: accept }),
          emptyDemand(d), boost);
        const parts = [k.follow, k.unfollow, k.accept, k.slack, k.lifecycleUnfollow];
        return parts.every((x) => Number.isInteger(x) && x >= 0)
          && k.follow + k.unfollow + k.accept + k.slack === v
          && k.unfollow <= (boost ? 0 : Math.floor(v / 2))
          && k.lifecycleUnfollow <= k.unfollow
          && k.follow <= Math.max(0, p0 - d.followsDoneToday)
          && k.accept <= Math.floor((v - k.unfollow) / 2)
          && (accept || k.accept === 0)
          && (cap === null || k.unfollow - k.lifecycleUnfollow <= cap);
      },
    ), { numRuns: 1000 });
  });

  test('lifecycle comes first; cleanup takes its share of what is left', () => {
    const k = allocateKinds(40, testIntent({ cleanupShare: 0.71 }), emptyDemand({ lifecycleDueByDayEnd: 6, pruneStock: 100 }), false);
    expect(k.lifecycleUnfollow).toBe(6);
    expect(k.unfollow).toBe(6 + Math.floor((20 - 6) * 0.71));
  });

  test('backlog yield: follows give up to half their share while the backlog exceeds the room', () => {
    const calm = allocateKinds(40, testIntent({ acceptRequests: false }), emptyDemand({ lifecycleDueByDayEnd: 20 }), false);
    const behind = allocateKinds(40, testIntent({ acceptRequests: false }), emptyDemand({ lifecycleDueByDayEnd: 20, lifecycleBacklog: 200 }), false);
    expect(calm.follow).toBe(20);
    expect(behind.follow).toBe(10);
    expect(behind.slack).toBe(10);
    const boosted = allocateKinds(40, testIntent({ acceptRequests: false }), emptyDemand({ lifecycleBacklog: 200 }), true);
    expect([boosted.unfollow, boosted.follow]).toEqual([0, 40]);
  });

  test('follows never exceed what is left of P0 today', () => {
    const k = allocateKinds(48, testIntent({ operatingRate: 50 }), emptyDemand({ followsDoneToday: 45 }), false);
    expect(k.follow).toBe(5);
  });
});

describe('L12: accepts per pass', () => {
  test('⌊H − H/1.3⌋: 5 Standard, 3 Cautious, 6 Bold', () => {
    expect([CAUTION.standard.cap, CAUTION.cautious.cap, CAUTION.bold.cap].map(acceptsPerPass)).toEqual([5, 3, 6]);
  });

  test('a pass never pushes the hour past the sustained rate', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 60 }), (h) => acceptsPerPass(h) <= Math.floor(h - h / 1.3)));
  });
});

test('a day off is the weekday of the local date the plan-day starts on', () => {
  const sunday = { key: '2026-11-01', startsAt: new Date(2026, 10, 1, 2, 45).getTime(), endsAt: 0, quietMinute: 165 };
  expect(isDayOff(sunday, [0])).toBe(true);
  expect(isDayOff(sunday, [6])).toBe(false);
});

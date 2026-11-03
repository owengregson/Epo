/**
 * The growth log (spec §9.10, ADR 0704): every own-header observation, transition-only change rows
 * written in the edge's own write, narrowing, the set-once backfill (law L8), today and the outside charge.
 */
import fc from 'fast-check';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { memoryStore } from '../kit/store';

const H = 3_600_000;
const NOW = new Date(2026, 4, 14, 12, 0, 0, 0).getTime();

let s: KnowledgeStore;
beforeEach(() => { s = memoryStore({ now: () => NOW }); });
afterEach(() => s.close());

const ownHeader = (at: number, followers: number, following: number) =>
  s.observe({ accountPk: 'ME', observedAt: at, source: 'profile', fields: { followers, following } });
const rows = () => s.growth.changesSince(Number.MIN_SAFE_INTEGER)
  .map(({ accountPk, delta, lo, hi, source }) => ({ accountPk, delta, lo, hi, source }));

describe('the change log', () => {
  beforeEach(() => { s.setOwnPk('ME'); s.ensureFollowersBaseline(100); });

  test('every own-header observation is stored, in the observation itself', () => {
    ownHeader(1_000, 10, 20);
    ownHeader(2_000, 11, 20);
    s.observe({ accountPk: 'X', observedAt: 3_000, source: 'profile', fields: { followers: 5, following: 6 } });
    expect(s.growth.headersSince(0)).toEqual([
      { at: 1_000, followers: 10, following: 20 }, { at: 2_000, followers: 11, following: 20 }]);
    expect(s.growth.latestOwnHeader()).toEqual({ at: 2_000, followers: 11, following: 20 });
  });

  test('a transition at or before the baseline is stock and writes nothing', () => {
    expect(s.growth.onTransition('A', 1, 50, 100, 'list', 100)).toBeNull();
    expect(s.growth.onTransition('A', 1, 50, 200, 'list', 200)).toEqual(expect.any(Number));
    expect(rows()).toEqual([{ accountPk: 'A', delta: 1, lo: 50, hi: 200, source: 'list' }]);
  });

  test('narrowing only tightens', () => {
    const id = s.growth.onTransition('A', 1, 100, 500, 'list', 500) as number;
    s.growth.narrow(id, 50, 1_000);
    expect(s.growth.latestGain('A')).toMatchObject({ lo: 100, hi: 500 });
    s.growth.narrow(id, 200, 400);
    expect(s.growth.latestGain('A')).toMatchObject({ lo: 200, hi: 400 });
    s.growth.narrow(id, 450, 300);
    expect(s.growth.latestGain('A')).toMatchObject({ lo: 200, hi: 400 });
    expect(s.growth.narrowLatestGainContaining('A', 300)).toBe(true);
    expect(s.growth.latestGain('A')).toMatchObject({ lo: 300, hi: 300 });
    expect(s.growth.narrowLatestGainContaining('A', 900)).toBe(false);
  });
});

describe('the backfill (law L8: every growth read equals the old edge queries)', () => {
  test('set-once, seeded with the own header', () => {
    s.observe({ accountPk: 'ME', observedAt: 900, source: 'profile', fields: { followers: 3, following: 4 } });
    s.observeEdge('A', 'ME', 'follows', true, 1_000);
    s.setOwnPk('ME');
    expect(s.growth.headersSince(0)).toEqual([{ at: 900, followers: 3, following: 4 }]);
    expect(rows()).toEqual([{ accountPk: 'A', delta: 1, lo: 1_000, hi: 1_000, source: 'migrated' }]);
    expect(s.growth.ensureBackfilled('ME', null)).toBeNull();
  });

  const day = 24 * H;
  const localDays = (n: number) => Array.from({ length: n }, (_, i) => {
    const d = new Date(NOW);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (n - 1 - i));
    const e = new Date(d);
    e.setDate(e.getDate() + 1);
    return { startsAt: d.getTime(), endsAt: e.getTime() };
  });

  test('on any generated legacy store the migrated log reads like the edge queries', () => {
    fc.assert(fc.property(
      fc.array(fc.record({ first: fc.integer({ min: -10, max: 0 }), gone: fc.option(fc.integer({ min: 0, max: 10 })),
        hour: fc.integer({ min: 0, max: 23 }) }), { maxLength: 25 }),
      fc.option(fc.integer({ min: -12, max: 0 })),
      fc.integer({ min: 1, max: 12 }),
      (edges, baselineDay, n) => {
        const store = memoryStore({ now: () => NOW });
        try {
          if (baselineDay !== null) store.ensureFollowersBaseline(NOW + baselineDay * day);
          edges.forEach((e, i) => {
            const first = NOW + e.first * day - e.hour * H;
            store.observeEdge(`p${i}`, 'ME', 'follows', true, first);
            if (e.gone !== null) store.observeEdge(`p${i}`, 'ME', 'follows', false, Math.min(NOW, first + e.gone * H));
          });
          store.setOwnPk('ME');
          const baseline = store.followersBaselineAt();
          expect(store.growth.series(localDays(n), baseline).map((p) => p.cumulativeNet))
            .toEqual(store.netGrowthSeries(n, 'ME', NOW).map((p) => p.cumulativeNet));
          for (let k = -12; k <= 1; k++) expect(store.growth.netSince(NOW + k * day)).toBe(store.netFollowersSince(NOW + k * day));
        } finally { store.close(); }
      }), { numRuns: 150 });
  });
});

describe('today and the outside charge', () => {
  beforeEach(() => { s.setOwnPk('ME'); s.ensureFollowersBaseline(0); });
  const today = { startsAt: NOW - 6 * H, endsAt: NOW + 18 * H };

  test('net today is the placed figure: identified changes plus residuals inside the day', () => {
    ownHeader(NOW - 5 * H, 100, 50);
    s.growth.onTransition('A', 1, NOW - 4 * H, NOW - 4 * H, 'feed', NOW - 4 * H);
    ownHeader(NOW - 3 * H, 103, 50);
    s.growth.onTransition('B', -1, NOW - 30 * H, NOW - 10 * H, 'list', NOW - 10 * H);
    // B's loss lies before the day; the header moved by 3 inside it, one of them identified.
    expect(s.growth.today(today)).toEqual({ startsAt: today.startsAt, endsAt: today.endsAt, net: 3, gained: 1, lost: 0,
      unattributed: 2, followBacks: 0, outside: 0 });
  });

  test('follow-backs whose interval lies in the day are counted', () => {
    s.upsertFollowRecord({ accountPk: 'F', targetPk: null, state: 'followed_back', followedAt: NOW - 30 * H,
      followedBackAt: NOW - H, retryCount: 0 });
    s.upsertFollowRecord({ accountPk: 'G', targetPk: null, state: 'followed_back', followedAt: NOW - 30 * H,
      followbackObservedAt: NOW - H, retryCount: 0 });
    expect(s.growth.today(today).followBacks).toBe(1);
  });

  test('an outside follow is charged to the day; a request accepted later is not', () => {
    ownHeader(NOW - 5 * H, 100, 50);
    ownHeader(NOW - 4 * H, 100, 51);
    expect(s.growth.outsideSince(today.startsAt)).toBe(1);
    s.observe({ accountPk: 'P', observedAt: NOW - 4 * H, source: 'profile', fields: { isPrivate: true } });
    s.recordAction('P', 'follow', 'ok', NOW - 3.5 * H);
    ownHeader(NOW - 3 * H, 100, 51);
    ownHeader(NOW - 2 * H, 100, 52);
    expect(s.growth.outsideSince(today.startsAt)).toBe(1);
    expect(s.growth.today(today).outside).toBe(1);
  });
});

import {
  shapeChainList,
  shapeQueueList,
  shapeTargetDetail,
  QUEUE_ROW_CAP,
  RUNWAY_RATE_WINDOW_DAYS,
  type ChainReadStore,
  type QueueReadStore,
  type TargetDetailReadStore,
} from '@/main/foundation-reads';
import type { AccountState, FollowRecord, FollowState, Target } from '@/store/types';
import { CONVERSION_VERDICT_MIN, RUNWAY_CAP_DAYS, type TargetYield } from '@/types';
import { MS_PER_DAY } from '@/timing/units';

/**
 * The read-shaping helpers behind `chain:list` / `queue:list` (§5). They are pure —
 * they take only a store slice — so they are exercised here with plain fakes: no
 * SQLite, no login, no browser.
 */

function account(pk: string, over: Partial<AccountState> = {}): AccountState {
  return {
    pk,
    enrichment: 'listed',
    firstSeenAt: 0,
    lastSeenAt: 0,
    ...over,
  };
}

const ZERO_YIELD: TargetYield = {
  total: 0,
  followedBack: 0,
  followBackRate: 0,
  poolSize: 0,
  mutualOverlap: 0,
};

describe('shapeChainList', () => {
  test('augments each target with its username and computed yield', () => {
    const targets: Target[] = [
      { accountPk: '1', source: 'seed', status: 'active', chainIndex: 0 },
      { accountPk: '2', source: 'own_followers', status: 'exhausted', chainIndex: 1 },
    ];
    const accounts: Record<string, AccountState> = {
      '1': account('1', { username: 'alpha', ratio: 1.1 }),
      // pk 2 has no username → null (identity is the pk, never the username).
    };
    const yields: Record<string, TargetYield> = {
      '1': { total: 10, followedBack: 4, followBackRate: 0.4, poolSize: 500, mutualOverlap: 2 },
      '2': ZERO_YIELD,
    };
    const store: ChainReadStore = {
      listTargets: () => targets,
      getAccount: (pk) => accounts[pk] ?? null,
      targetYield: (pk, ownPk) => {
        expect(ownPk).toBe('own');
        return yields[pk];
      },
    };

    const rows = shapeChainList(store, 'own');

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      accountPk: '1',
      source: 'seed',
      username: 'alpha',
      yield: { followBackRate: 0.4, poolSize: 500 },
    });
    expect(rows[1].username).toBeNull();
    expect(rows[1].yield).toEqual(ZERO_YIELD);
  });

  test('returns [] when there are no targets', () => {
    const store: ChainReadStore = {
      listTargets: () => [],
      getAccount: () => null,
      targetYield: () => ZERO_YIELD,
    };
    expect(shapeChainList(store, 'own')).toEqual([]);
  });
});

describe('shapeTargetDetail', () => {
  const NOW = 1_000_000_000;

  const funnel = (over: Partial<Record<FollowState, number>> = {}): Record<FollowState, number> => ({
    queued: 0,
    pending_followback: 0,
    followed_back: 0,
    unfollow_queued: 0,
    unfollowed: 0,
    abandoned: 0,
    external: 0,
    ...over,
  });

  interface FakeOver {
    target?: Target | null;
    account?: AccountState | null;
    yield?: Partial<TargetYield>;
    states?: Partial<Record<FollowState, number>>;
    observed?: number;
    candidates?: number;
    timing?: { resolved: number; medianMs: number | null };
    /** Landed follows in the trailing window (the realized-pace numerator). */
    follows7d?: number;
  }

  function detailStore(over: FakeOver = {}): TargetDetailReadStore & { askedSince: number[] } {
    const askedSince: number[] = [];
    return {
      askedSince,
      getTarget: (pk) =>
        over.target !== undefined
          ? over.target
          : { accountPk: pk, source: 'seed', status: 'active', chainIndex: 0 },
      getAccount: () => (over.account !== undefined ? over.account : account('T')),
      targetYield: (_pk, ownPk) => {
        expect(ownPk).toBe('own');
        return { ...ZERO_YIELD, ...over.yield };
      },
      targetFunnel: () => ({
        states: funnel(over.states),
        observed: over.observed ?? 0,
        candidates: over.candidates ?? 0,
      }),
      followbackTimingFor: () => over.timing ?? { resolved: 0, medianMs: null },
      followActionCountSince: (since) => {
        askedSince.push(since);
        return over.follows7d ?? 0;
      },
    };
  }

  const shape = (store: TargetDetailReadStore, plannedToday = 0) =>
    shapeTargetDetail(store, 'own', 'T', { now: NOW, plannedToday });

  test('null for a pk that is not a chain target', () => {
    expect(shape(detailStore({ target: null }))).toBeNull();
  });

  test('carries the chain-view fields plus the full funnel — abandoned and external included', () => {
    const d = shape(
      detailStore({
        account: account('T', { username: 'hub', followers: 40_200 }),
        yield: { total: 41, followedBack: 9, followBackRate: 9 / 41 },
        states: { queued: 25, pending_followback: 30, abandoned: 3, external: 2 },
        observed: 612,
        candidates: 100,
      }),
    );
    expect(d).toMatchObject({
      accountPk: 'T',
      source: 'seed',
      username: 'hub',
      yield: { total: 41, followedBack: 9 },
      funnel: { queued: 25, pending_followback: 30, abandoned: 3, external: 2, unfollowed: 0 },
      trueFollowers: 40_200,
      scanned: 612,
      remainingActionable: 125, // queued records + scoreable candidates — never the raw pool
    });
  });

  test('MANDATORY degrade: followers null until enriched → trueFollowers null, scanned intact', () => {
    const d = shape(detailStore({ account: account('T', { username: 'hub' }), observed: 612 }));
    expect(d?.trueFollowers).toBeNull();
    expect(d?.scanned).toBe(612);
  });

  test('resolvedOutcomes = followed total minus still-awaiting records', () => {
    const d = shape(
      detailStore({ yield: { total: 41 }, states: { pending_followback: 30 } }),
    );
    expect(d?.resolvedOutcomes).toBe(11);
  });

  test('sample-size gate: the median is WITHHELD below the resolved-outcome floor (§1)', () => {
    const below = shape(
      detailStore({
        yield: { total: CONVERSION_VERDICT_MIN - 1 },
        timing: { resolved: 5, medianMs: 86_400_000 },
      }),
    );
    expect(below?.resolvedOutcomes).toBe(CONVERSION_VERDICT_MIN - 1);
    expect(below?.medianFollowbackMs).toBeNull();

    const at = shape(
      detailStore({
        yield: { total: CONVERSION_VERDICT_MIN },
        timing: { resolved: 6, medianMs: 86_400_000 },
      }),
    );
    expect(at?.medianFollowbackMs).toBe(86_400_000);
  });

  test('runway divides the actionable stock by the REALIZED 7-day pace', () => {
    const store = detailStore({ states: { queued: 10 }, candidates: 4, follows7d: 14 }); // 2/day
    const d = shape(store, 25);
    expect(store.askedSince).toEqual([NOW - RUNWAY_RATE_WINDOW_DAYS * MS_PER_DAY]);
    expect(d?.runway).toEqual({ days: 7, overCap: false });
  });

  test('plannedToday is the fallback pace ONLY before any follow history exists', () => {
    const d = shape(detailStore({ states: { queued: 10 }, candidates: 10, follows7d: 0 }), 5);
    expect(d?.runway).toEqual({ days: 4, overCap: false });
  });

  test('no realized pace and no plan → no runway (never a fabricated number)', () => {
    expect(shape(detailStore({ candidates: 100, follows7d: 0 }), 0)?.runway).toBeNull();
  });

  test('runway clamp: a projection past the cap is flagged overCap, not falsely precise', () => {
    const d = shape(detailStore({ candidates: 10_000, follows7d: 7 }), 0); // 1/day
    expect(d?.runway?.overCap).toBe(true);
    expect(d?.runway?.days).toBeGreaterThan(RUNWAY_CAP_DAYS);
  });
});

describe('shapeQueueList', () => {
  function record(pk: string, over: Partial<FollowRecord> = {}): FollowRecord {
    return { accountPk: pk, targetPk: null, state: 'queued', retryCount: 0, ...over };
  }

  test('joins each record to its account and carries the lifecycle timestamps', () => {
    const records: FollowRecord[] = [
      record('1', { state: 'followed_back', followedAt: 100, holdUntil: 200, unfollowDueAt: 300 }),
    ];
    const accounts: Record<string, AccountState> = {
      '1': account('1', { username: 'bravo', ratio: 0.8, isPrivate: true }),
    };
    const store: QueueReadStore = {
      followRecordsByState: (state) => {
        expect(state).toBe('followed_back');
        return records;
      },
      getAccount: (pk) => accounts[pk] ?? null,
    };

    const { rows, truncated } = shapeQueueList(store, 'followed_back');

    expect(truncated).toBe(false);
    expect(rows).toEqual([
      {
        pk: '1',
        username: 'bravo',
        ratio: 0.8,
        isPrivate: true,
        mutuals: null,
        score: null,
        followedAt: 100,
        holdUntil: 200,
        unfollowDueAt: 300,
      },
    ]);
  });

  test('nulls missing account fields rather than throwing', () => {
    const store: QueueReadStore = {
      followRecordsByState: () => [record('9')],
      getAccount: () => null,
    };
    const { rows } = shapeQueueList(store, 'queued');
    expect(rows[0]).toMatchObject({ pk: '9', username: null, ratio: null, isPrivate: null });
  });

  test('caps rows at the limit and flags truncation', () => {
    const records = Array.from({ length: 5 }, (_, i) => record(String(i)));
    const store: QueueReadStore = {
      followRecordsByState: () => records,
      getAccount: (pk) => account(pk),
    };
    const { rows, truncated } = shapeQueueList(store, 'queued', 3);
    expect(rows).toHaveLength(3);
    expect(truncated).toBe(true);
    expect(rows.map((r) => r.pk)).toEqual(['0', '1', '2']);
  });

  test('does not flag truncation at exactly the cap', () => {
    const records = Array.from({ length: QUEUE_ROW_CAP }, (_, i) => record(String(i)));
    const store: QueueReadStore = {
      followRecordsByState: () => records,
      getAccount: (pk) => account(pk),
    };
    const { rows, truncated } = shapeQueueList(store, 'queued');
    expect(rows).toHaveLength(QUEUE_ROW_CAP);
    expect(truncated).toBe(false);
  });

  test('queued rows are ordered best-score first, matching the follow order', () => {
    const records = [
      record('low', { score: 0.3 }),
      record('top', { score: 2.4 }),
      record('mid', { score: 1.1 }),
      record('none'), // scoreless (non-Scanner record) sorts last
    ];
    const store: QueueReadStore = {
      followRecordsByState: () => records,
      getAccount: (pk) => account(pk),
    };
    const { rows } = shapeQueueList(store, 'queued');
    expect(rows.map((r) => r.pk)).toEqual(['top', 'mid', 'low', 'none']);
    expect(rows[0].score).toBe(2.4);
  });

  test('ordering happens BEFORE the cap: the page is the true top-N', () => {
    // Best record inserted LAST — a slice-then-sort would drop it.
    const records = [
      record('c', { score: 0.5 }),
      record('b', { score: 1.0 }),
      record('a', { score: 9.9 }),
    ];
    const store: QueueReadStore = {
      followRecordsByState: () => records,
      getAccount: (pk) => account(pk),
    };
    const { rows, truncated } = shapeQueueList(store, 'queued', 2);
    expect(truncated).toBe(true);
    expect(rows.map((r) => r.pk)).toEqual(['a', 'b']);
  });

  test('lifecycle stages order by their governing timestamp (nearest deadline first)', () => {
    const records = [
      record('late', { state: 'followed_back', holdUntil: 900 }),
      record('soon', { state: 'followed_back', holdUntil: 100 }),
    ];
    const store: QueueReadStore = {
      followRecordsByState: () => records,
      getAccount: (pk) => account(pk),
    };
    const { rows } = shapeQueueList(store, 'followed_back');
    expect(rows.map((r) => r.pk)).toEqual(['soon', 'late']);
  });
});

import {
  shapeChainList,
  shapeQueueList,
  QUEUE_ROW_CAP,
  type ChainReadStore,
  type QueueReadStore,
} from '@/main/foundation-reads';
import type { AccountState, FollowRecord, Target } from '@/store/types';
import type { TargetYield } from '@/types';

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
});

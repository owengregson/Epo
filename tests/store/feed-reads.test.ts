/**
 * The live feed's reads (spec §12.9, Appendix C.4): settled writes newest first with the reason a lifecycle
 * unfollow carried, follow-backs dated by event time when known, new followers past a bound that exclude managed
 * records and accepted requests, lost followers counted per check, the last settled write; the two
 * migration-17 indexes carry the hot reads, and a large store reads in milliseconds.
 */

import type { SqliteDriver } from '@/store/driver/driver';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { FEED_SQL } from '@/store/repos/feed-reads';
import type { EffectChannel, EffectResult, MutationAction } from '@/store/types';
import { openTestStore } from '../kit/store';

const OWN = 'own';
const HOUR = 3_600_000;
const T0 = 1_800_000_000_000;

let store: KnowledgeStore;
beforeEach(() => {
  store = openTestStore();
  store.setOwnPk(OWN);
});
afterEach(() => store.close());

const dbOf = (s: KnowledgeStore): SqliteDriver => (s as unknown as { db: SqliteDriver }).db;

function settled(pk: string, action: MutationAction, channel: EffectChannel, at: number, result: EffectResult): string {
  const intent = store.beginEffectIntent({ accountPk: pk, username: `u${pk}`, action, channel, at: at - 1 });
  store.markEffectDispatched(intent.id, at - 1);
  store.settleEffectIntent(intent.id, { at, result, ledger: 'none' });
  return intent.id;
}

function named(pk: string, username: string): void {
  store.observe({ accountPk: pk, observedAt: T0, source: 'profile', fields: { username } });
}

describe('settledEffects', () => {
  test('settled writes the feed narrates, newest first, inside the bound and the limit', () => {
    settled('a', 'follow', 'growth', T0 + 1 * HOUR, 'ok');
    settled('b', 'follow', 'growth', T0 + 2 * HOUR, 'simulated');
    settled('c', 'unfollow', 'prune', T0 + 3 * HOUR, 'fail');
    settled('d', 'follow', 'manual', T0 + 4 * HOUR, 'expired');
    settled('e', 'accept-request', 'accept-request', T0 + 5 * HOUR, 'ok');
    settled('f', 'follow', 'growth', T0 + 6 * HOUR, 'external');
    settled('g', 'follow', 'growth', T0 + 7 * HOUR, 'cancelled');
    store.beginEffectIntent({ accountPk: 'h', username: 'uh', action: 'follow', channel: 'growth', at: T0 + 8 * HOUR });
    settled('z', 'follow', 'growth', T0 - HOUR, 'ok');

    const rows = store.feed.settledEffects(T0, 10);
    expect(rows.map((r) => [r.pk, r.action, r.channel, r.result])).toEqual([
      ['e', 'accept', 'accept-request', 'ok'],
      ['d', 'follow', 'manual', 'expired'],
      ['c', 'unfollow', 'prune', 'fail'],
      ['b', 'follow', 'growth', 'simulated'],
      ['a', 'follow', 'growth', 'ok'],
    ]);
    expect(rows[0]).toMatchObject({ username: 'ue', settledAt: T0 + 5 * HOUR, unfollowReason: null });
    expect(store.feed.settledEffects(T0, 2).map((r) => r.pk)).toEqual(['e', 'd']);
  });

  test("a lifecycle unfollow carries its record's reason", () => {
    store.upsertFollowRecord({ accountPk: 'q', targetPk: null, state: 'unfollowed', retryCount: 0, unfollowReason: 'hold-expired' });
    const id = settled('q', 'unfollow', 'growth', T0 + HOUR, 'ok');
    expect(store.feed.settledEffects(T0, 5)).toEqual([{
      id, pk: 'q', username: 'uq', action: 'unfollow', channel: 'growth', result: 'ok', settledAt: T0 + HOUR,
      unfollowReason: 'hold-expired',
    }]);
  });
});

describe('followBacks', () => {
  test('dated by the event when known, else by when Epo saw it; never one that predates our follow', () => {
    named('dated', 'dana');
    store.upsertFollowRecord({ accountPk: 'dated', targetPk: null, state: 'followed_back', retryCount: 0,
      followedAt: T0, followedBackAt: T0 + 2 * HOUR, followbackObservedAt: T0 + 3 * HOUR });
    store.upsertFollowRecord({ accountPk: 'seen', targetPk: null, state: 'followed_back', retryCount: 0,
      followedAt: T0, followbackObservedAt: T0 + 4 * HOUR });
    store.upsertFollowRecord({ accountPk: 'first', targetPk: null, state: 'followed_back', retryCount: 0,
      followedAt: T0 + 5 * HOUR, followedBackAt: T0 + HOUR, followbackObservedAt: T0 + 5 * HOUR });
    store.upsertFollowRecord({ accountPk: 'old', targetPk: null, state: 'followed_back', retryCount: 0,
      followedAt: T0 - 9 * HOUR, followedBackAt: T0 - 8 * HOUR, followbackObservedAt: T0 - 8 * HOUR });
    store.upsertFollowRecord({ accountPk: 'pending', targetPk: null, state: 'pending_followback', retryCount: 0, followedAt: T0 });

    expect(store.feed.followBacks(T0, 10)).toEqual([
      { pk: 'seen', username: null, at: T0 + 4 * HOUR, dated: false, followedAt: T0 },
      { pk: 'dated', username: 'dana', at: T0 + 2 * HOUR, dated: true, followedAt: T0 },
    ]);
    expect(store.feed.followBacks(T0, 1).map((r) => r.pk)).toEqual(['seen']);
  });
});

describe('newFollowers', () => {
  test('active edges into our account from the bound on, without managed records or accepted requests', () => {
    named('n1', 'nina');
    store.observeEdge('n1', OWN, 'follows', true, T0 + HOUR);
    store.observeEdge('n2', OWN, 'follows', true, T0 + 2 * HOUR);
    store.observeEdge('gone', OWN, 'follows', true, T0 + 3 * HOUR);
    store.observeEdge('gone', OWN, 'follows', false, T0 + 4 * HOUR);
    store.observeEdge('n3', 'someone-else', 'follows', true, T0 + 2 * HOUR);
    store.observeEdge('early', OWN, 'follows', true, T0 - HOUR);
    store.observeEdge('managed', OWN, 'follows', true, T0 + 2 * HOUR);
    store.upsertFollowRecord({ accountPk: 'managed', targetPk: null, state: 'pending_followback', retryCount: 0, followedAt: T0 });
    store.observeEdge('queued', OWN, 'follows', true, T0 + 5 * HOUR);
    store.upsertFollowRecord({ accountPk: 'queued', targetPk: null, state: 'queued', retryCount: 0 });
    store.observeEdge('asked', OWN, 'follows', true, T0 + 2 * HOUR);
    settled('asked', 'accept-request', 'accept-request', T0 + 2 * HOUR, 'ok');

    expect(store.feed.newFollowers(OWN, T0, 10)).toEqual([
      { pk: 'queued', username: null, at: T0 + 5 * HOUR, dated: false },
      { pk: 'n2', username: null, at: T0 + 2 * HOUR, dated: false },
      { pk: 'n1', username: 'nina', at: T0 + HOUR, dated: false },
    ]);
    expect(store.feed.newFollowers(OWN, T0, 1)).toHaveLength(1);
  });

  test('dated only when the latest gain row was exact', () => {
    store.observeEdge('exact', OWN, 'follows', true, T0 + HOUR);
    store.observeEdge('ranged', OWN, 'follows', true, T0 + 2 * HOUR);
    const add = dbOf(store).prepare(
      'INSERT INTO follower_changes (account_pk, delta, lo, hi, source, found_at) VALUES (?, ?, ?, ?, ?, ?)');
    add.run('exact', 1, T0 - 9 * HOUR, T0 - 8 * HOUR, 'head', T0);
    add.run('exact', 1, T0 + HOUR, T0 + HOUR, 'drawer', T0 + HOUR);
    add.run('ranged', 1, T0 + HOUR, T0 + HOUR, 'drawer', T0 + HOUR);
    add.run('ranged', 1, T0, T0 + 2 * HOUR, 'head', T0 + 2 * HOUR);

    expect(store.feed.newFollowers(OWN, T0, 10).map((r) => [r.pk, r.dated])).toEqual([['ranged', false], ['exact', true]]);
  });
});

test('lostFollowerCount: removed edges into our account, counted per detection', () => {
  for (const pk of ['l1', 'l2', 'l3', 'stay']) store.observeEdge(pk, OWN, 'follows', true, T0 - HOUR);
  store.observeEdge('l1', OWN, 'follows', false, T0 + HOUR);
  store.observeEdge('l2', OWN, 'follows', false, T0 + HOUR);
  store.observeEdge('l3', OWN, 'follows', false, T0 + 3 * HOUR);
  store.observeEdge('x', 'other', 'follows', true, T0 - HOUR);
  store.observeEdge('x', 'other', 'follows', false, T0 + HOUR);
  store.observeEdge('older', OWN, 'follows', true, T0 - 3 * HOUR);
  store.observeEdge('older', OWN, 'follows', false, T0 - 2 * HOUR);

  expect(store.feed.lostFollowerCount(OWN, T0)).toEqual([{ at: T0 + 3 * HOUR, count: 1 }, { at: T0 + HOUR, count: 2 }]);
});

test('lastSettledMutationAt: the newest settled write that landed or was practised', () => {
  expect(store.feed.lastSettledMutationAt()).toBeNull();
  settled('a', 'follow', 'growth', T0 + HOUR, 'ok');
  settled('b', 'unfollow', 'growth', T0 + 2 * HOUR, 'simulated');
  settled('c', 'follow', 'growth', T0 + 3 * HOUR, 'fail');
  settled('d', 'follow', 'growth', T0 + 4 * HOUR, 'cancelled');
  expect(store.feed.lastSettledMutationAt()).toBe(T0 + 2 * HOUR);
});

describe('the migration-17 indexes carry the hot reads', () => {
  const plan = (sql: string, ...params: (string | number)[]): string =>
    dbOf(store).prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>(...params).map((r) => r.detail).join('\n');

  test('settled writes and the last write walk idx_effect_state_settled', () => {
    expect(plan(FEED_SQL.settledEffects, T0, 10)).toMatch(/USING (COVERING )?INDEX idx_effect_state_settled/);
    expect(plan(FEED_SQL.lastSettledMutationAt)).toMatch(/USING (COVERING )?INDEX idx_effect_state_settled/);
    expect(plan(FEED_SQL.settledEffects, T0, 10)).not.toMatch(/TEMP B-TREE/);
  });

  test('new followers walk idx_edges_dst_status_first_seen without a sort', () => {
    const detail = plan(FEED_SQL.newFollowers, OWN, T0, 10);
    expect(detail).toMatch(/SEARCH e USING INDEX idx_edges_dst_status_first_seen/);
    expect(detail).not.toMatch(/TEMP B-TREE FOR ORDER BY/);
  });
});

test('a large store (100k edges, 20k records, 10k intents) reads the feed in milliseconds', () => {
  const db = dbOf(store);
  const now = T0 + 60 * 24 * HOUR;
  db.transaction(() => {
    const edge = db.prepare(
      'INSERT INTO edges (src_pk, dst_pk, type, first_seen_at, last_confirmed_at, status) VALUES (?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < 100_000; i++) {
      const own = i % 5 !== 0;
      const at = T0 + (i % 1_440) * HOUR;
      edge.run(`p${i}`, own ? OWN : `t${i % 97}`, 'follows', at, at, i % 10 === 0 ? 'removed' : 'active');
    }
    const record = db.prepare(`INSERT INTO follow_records (account_pk, state, followed_at, followed_back_at, followback_observed_at,
      retry_count) VALUES (?, ?, ?, ?, ?, 0)`);
    for (let i = 0; i < 20_000; i++) {
      const at = T0 + (i % 1_440) * HOUR;
      record.run(`p${i * 3}`, i % 4 === 0 ? 'followed_back' : 'pending_followback', at, i % 4 === 0 ? at + HOUR : null, null);
    }
    const intent = db.prepare(`INSERT INTO effect_intents (id, account_pk, username, action, channel, state, created_at,
      dispatched_at, settled_at, result, ledger) VALUES (?, ?, ?, ?, 'growth', 'settled', ?, ?, ?, ?, 'growth')`);
    for (let i = 0; i < 10_000; i++) {
      const at = T0 + (i % 1_440) * HOUR;
      intent.run(`i${i}`, `p${i * 7}`, `u${i}`, i % 3 === 0 ? 'unfollow' : 'follow', at, at, at, i % 9 === 0 ? 'fail' : 'ok');
    }
  });
  const since = now - 7 * 24 * HOUR;
  const read = (): void => {
    store.feed.settledEffects(since, 1_200);
    store.feed.followBacks(since, 1_200);
    store.feed.newFollowers(OWN, since, 1_200);
    store.feed.lostFollowerCount(OWN, since);
    store.feed.lastSettledMutationAt();
  };
  read();
  const runs = Array.from({ length: 5 }, () => {
    const t = performance.now();
    read();
    return performance.now() - t;
  });
  expect(Math.min(...runs)).toBeLessThanOrEqual(15);
});

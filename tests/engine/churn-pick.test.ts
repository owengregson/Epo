import type { KnowledgeStore } from '@/store/knowledge-store';
import { makeChurnHarness as makeHarness, rec, T0 } from '../kit/engine-harness';

/** Give an account a known username so the scheduler can action it. */
const seedUsername = (store: KnowledgeStore, pk: string, username: string): void =>
  store.observe({
    accountPk: pk,
    observedAt: T0,
    source: 'profile',
    fields: { username, followers: 100, following: 100 },
  });

describe('nextDue(now, kind)', () => {
  test('kind undefined keeps the precedence: a due unfollow before a queued follow', () => {
    const { store, sched } = makeHarness();
    store.upsertFollowRecord(rec({ accountPk: 'f1', state: 'queued', score: 5 }));
    store.upsertFollowRecord(rec({ accountPk: 'u1', state: 'unfollow_queued', unfollowDueAt: T0 }));

    expect(sched.nextDue(T0)?.accountPk).toBe('u1');
    expect(sched.nextDue(T0, 'follow')?.accountPk).toBe('f1');
    expect(sched.nextDue(T0, 'unfollow')?.accountPk).toBe('u1');
  });

  test('after two unfollows in a row the default turns to the follow; kind unfollow still picks one', async () => {
    const { store, sched } = makeHarness();
    for (const pk of ['a', 'b']) {
      seedUsername(store, pk, `user-${pk}`);
      store.upsertFollowRecord(rec({ accountPk: pk, state: 'unfollow_queued', unfollowDueAt: T0 }));
      await sched.tick();
      expect(store.getFollowRecord(pk)?.state).toBe('unfollowed');
    }
    store.upsertFollowRecord(rec({ accountPk: 'f1', state: 'queued', score: 5 }));
    store.upsertFollowRecord(rec({ accountPk: 'u2', state: 'unfollow_queued', unfollowDueAt: T0 }));

    expect(sched.nextDue(T0)?.accountPk).toBe('f1');
    expect(sched.nextDue(T0, 'unfollow')?.accountPk).toBe('u2');
  });

  test('unfollows order by due time then pk; a verb with nothing due picks nothing', () => {
    const { store, sched } = makeHarness();
    store.upsertFollowRecord(rec({ accountPk: 'u9', state: 'unfollow_queued', unfollowDueAt: T0 + 5 }));
    store.upsertFollowRecord(rec({ accountPk: 'u2', state: 'unfollow_queued', unfollowDueAt: T0 }));
    store.upsertFollowRecord(rec({ accountPk: 'u1', state: 'unfollow_queued', unfollowDueAt: T0 }));

    expect(sched.nextDue(T0, 'unfollow')?.accountPk).toBe('u1');
    expect(sched.nextDue(T0, 'follow')).toBeNull();
    expect(makeHarness().sched.nextDue(T0, 'unfollow')).toBeNull();
  });
});

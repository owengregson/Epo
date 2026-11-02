import { ChurnScheduler } from '@/engine/churn-scheduler';
import { journaledMutation } from '@/engine/journaled-mutation';
import { FakeClock } from '@/governors/clock';
import type { RateGovernor } from '@/governors/rate-governor';
import { setLevel } from '@/utils/logger';
import { kitStore } from '../kit/engine-harness';

beforeAll(() => setLevel('error'));

test.each(['failed', 'thrown'] as const)('growth %s after dispatch stays uncertain and cannot retry', async (failure) => {
  const store = kitStore();
  const clock = new FakeClock(10_000);
  store.observe({ accountPk: 'a', observedAt: clock.now(), source: 'profile', fields: { username: 'alice' } });
  store.upsertFollowRecord({ accountPk: 'a', targetPk: null, state: 'queued', retryCount: 0 });
  const follow = jest.fn(async (_username: string, _pk?: string, dispatched?: () => void) => {
    dispatched?.();
    if (failure === 'thrown') throw new Error('connection lost after dispatch');
    return { status: 'failed' as const, cause: 'drift' as const };
  });
  const churn = new ChurnScheduler({ store, clock, ownPk: 'me', rate: {} as RateGovernor,
    actions: { follow, unfollow: async () => ({ status: 'ok' }) } });
  expect(await churn.execute(store.getFollowRecord('a')!)).toBe('blocked');
  expect(store.getFollowRecord('a')).toMatchObject({ state: 'queued', retryCount: 0 });
  expect(store.pendingEffectIntents()[0].state).toBe('uncertain');
  expect(store.actionCountSince(0)).toBe(0);
  expect(store.additionalMutationCountSince(0)).toBe(1);
  expect(await churn.execute(store.getFollowRecord('a')!)).toBe('blocked');
  expect(follow).toHaveBeenCalledTimes(1);
});

test.each(['manual', 'prune'] as const)('%s post-dispatch failed result is not a definitive failure ledger or repeatable effect', async (channel) => {
  const store = kitStore();
  const clock = new FakeClock(10_000);
  const unfollow = jest.fn(async (_username: string, _pk?: string, dispatched?: () => void) => {
    dispatched?.(); return { status: 'failed' as const };
  });
  const deps = { store, clock, ownPk: 'me', actions: { unfollow }, action: 'unfollow' as const,
    accountPk: 'a', username: 'alice', channel };
  expect(await journaledMutation(deps)).toMatchObject({ status: 'blocked', unverifiedClick: true });
  expect(store.pendingEffectIntents()[0].state).toBe('uncertain');
  expect(store.actionCountSince(0) + store.pruneCountSince(0)).toBe(0);
  await journaledMutation(deps);
  expect(unfollow).toHaveBeenCalledTimes(1);
});

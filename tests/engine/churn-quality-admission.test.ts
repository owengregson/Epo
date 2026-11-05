import { ChurnScheduler } from '@/engine/churn-scheduler';
import { SCORER_DEFAULTS } from '@/engine/scorer';
import { SourceFrontier } from '@/engine/source-frontier';
import { FakeClock } from '@/governors/clock';
import { RateGovernor } from '@/governors/rate-governor';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { DEFAULT_CONFIGS } from '../kit/configs';
import { FakeActions } from '../kit/engine-harness';
import { openTestStore } from '../kit/store';

let store: KnowledgeStore;
const clock = new FakeClock(100_000);
beforeEach(() => { store = openTestStore(':memory:'); });
afterEach(() => store.close());

test('a quality-only refusal preserves an eligible queue record and spends no intent or action', async () => {
  let allowed = false;
  const actions = new FakeActions();
  const scheduler = new ChurnScheduler({ store, clock, actions,
    rate: new RateGovernor(store, clock, { dailyHardCeiling: 100 }), cfg: DEFAULT_CONFIGS.churn,
    validateFollow: () => true, mayFollow: () => allowed });
  store.observe({ accountPk: 'a', observedAt: clock.now(), source: 'profile', fields: { username: 'alice' } });
  const record = { accountPk: 'a', targetPk: 'seed', state: 'queued' as const, retryCount: 0, score: 0.8 };
  store.upsertFollowRecord(record);
  await expect(scheduler.execute(record)).resolves.toBe('noop');
  expect(store.getFollowRecord('a')).toMatchObject(record);
  expect(store.effectIntents.pending()).toEqual([]);
  expect(store.actionCountSince(0)).toBe(0);
  expect(actions.followCalls).toEqual([]);
  allowed = true;
  await expect(scheduler.execute(record)).resolves.toBe('ok');
  expect(actions.followCalls).toEqual(['alice']);
});

test('hard ineligibility still zeroes the score before quality admission', async () => {
  const mayFollow = jest.fn(() => true);
  const scheduler = new ChurnScheduler({ store, clock, actions: new FakeActions(),
    rate: new RateGovernor(store, clock, { dailyHardCeiling: 100 }), cfg: DEFAULT_CONFIGS.churn,
    validateFollow: () => false, mayFollow });
  const record = { accountPk: 'a', targetPk: 'seed', state: 'queued' as const, retryCount: 0, score: 0.8 };
  store.upsertFollowRecord(record);
  await expect(scheduler.execute(record)).resolves.toBe('noop');
  expect(store.getFollowRecord('a')).toMatchObject({ state: 'queued', score: 0 });
  expect(mayFollow).not.toHaveBeenCalled();
});

test.each([false, true])('fresh selection %s controls whether the scheduler reconsiders a stale zero score', (freshCandidateSelection) => {
  const frontier = new SourceFrontier({ store, clock, quality: {
    scorer: () => SCORER_DEFAULTS, readyCount: () => 1, capacity: () => 10,
  } });
  store.addTarget({ accountPk: 'source', source: 'seed', status: 'active', chainIndex: 0 });
  store.observe({ accountPk: 'a', observedAt: clock.now(), source: 'profile',
    fields: { username: 'alice', followers: 500, following: 0 } });
  store.upsertFollowRecord({ accountPk: 'a', targetPk: 'source', state: 'queued', retryCount: 0, score: 0 });
  const scheduler = new ChurnScheduler({ store, clock, actions: new FakeActions(),
    rate: new RateGovernor(store, clock, { dailyHardCeiling: 100 }), cfg: DEFAULT_CONFIGS.churn,
    freshCandidateSelection, pickQueued: (records) => frontier.pickQueued(records),
    mayFollow: (record) => frontier.allowsFollow(record) });
  frontier.refreshQuality();
  expect(scheduler.nextDue(clock.now(), 'follow')).toBeNull();
  store.observe({ accountPk: 'a', observedAt: clock.now() + 1, source: 'profile', fields: { following: 550 } });
  frontier.refreshQuality();
  expect(frontier.goodQueuedCount('source')).toBe(1);
  const picked = scheduler.nextDue(clock.now(), 'follow');
  if (freshCandidateSelection) expect(picked).toMatchObject({ accountPk: 'a', score: 1 });
  else expect(picked).toBeNull();
  expect(store.getFollowRecord('a')?.score).toBe(0);
});

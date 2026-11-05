import { ChurnScheduler } from '@/engine/churn-scheduler';
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

import { SCORER_DEFAULTS } from '@/engine/scorer';
import { SourceFrontier } from '@/engine/source-frontier';
import { FakeClock } from '@/governors/clock';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { FollowRecord } from '@/store/types';
import { openTestStore } from '../kit/store';

let store: KnowledgeStore;
let frontier: SourceFrontier;
const clock = new FakeClock(1_000_000);
beforeEach(() => {
  store = openTestStore(':memory:');
  frontier = new SourceFrontier({ store, clock, quality: {
    scorer: () => SCORER_DEFAULTS, readyCount: () => 5, capacity: () => 10,
  } });
});
afterEach(() => store.close());

function batch(username: string | undefined = 'fifth', target = true): FollowRecord[] {
  if (target) store.addTarget({ accountPk: 'source', source: 'seed', status: 'active', chainIndex: 0 });
  return Array.from({ length: 5 }, (_, i) => {
    const pk = `person-${i}`;
    store.observe({ accountPk: pk, observedAt: clock.now(), source: 'profile',
      fields: { username: i === 4 ? username : pk, followers: 1000, following: 1100 } });
    const record: FollowRecord = { accountPk: pk, targetPk: 'source', state: 'queued', retryCount: 0, score: 1 };
    store.upsertFollowRecord(record);
    return record;
  });
}

test.each(['', '   '])('an unusable username (%j) cannot complete source readiness', (username) => {
  batch(username);
  frontier.refreshQuality();
  expect(frontier.goodQueuedCount('source')).toBe(4);
  expect(frontier.snapshot().quality ?? null).toBeNull();
  expect(frontier.pickQueued(store.followRecordsByState('queued'))).toBeNull();
});

test('a missing username cannot complete source readiness', () => {
  const records = batch();
  const get = store.getAccount.bind(store);
  jest.spyOn(store, 'getAccount').mockImplementation((pk) => {
    const account = get(pk);
    return pk === records[4].accountPk && account !== null ? { ...account, username: undefined } : account;
  });
  frontier.refreshQuality();
  expect(frontier.goodQueuedCount('source')).toBe(4);
  expect(frontier.snapshot().quality ?? null).toBeNull();
});

test('a dangling source cannot establish a benchmark or survive reset as usable supply', () => {
  batch('fifth', false);
  frontier.refreshQuality();
  expect(frontier.goodQueuedCount('source')).toBe(0);
  expect(frontier.snapshot().quality ?? null).toBeNull();
  store.setSourceFrontierState(null);
  frontier.refreshQuality();
  expect(frontier.pickQueued(store.followRecordsByState('queued'))).toBeNull();
});

test.each(['username', 'target', 'retired'] as const)('at-act admission rechecks %s after a cohort was prepared', (change) => {
  const records = batch();
  frontier.refreshQuality();
  expect(frontier.allowsFollow(records[0])).toBe(true);
  if (change === 'username') store.observe({ accountPk: records[0].accountPk,
    observedAt: clock.now() + 1, source: 'profile', fields: { username: '' } });
  else if (change === 'target') jest.spyOn(store, 'getTarget').mockReturnValue(null);
  else store.setTargetStatus('source', 'retired');
  expect(frontier.allowsFollow(records[0])).toBe(false);
});

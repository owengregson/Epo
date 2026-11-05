import { SourceFrontier } from '@/engine/source-frontier';
import { FakeClock } from '@/governors/clock';
import { EXPLORATION_POLICY as POLICY } from '@/kernel/exploration-policy';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { FOLLOW_STATES, type FollowRecord, type FollowState } from '@/store/types';
import { openTestStore } from '../kit/store';

let store: KnowledgeStore;
let frontier: SourceFrontier;
const clock = new FakeClock(100 * 86_400_000);
beforeEach(() => {
  store = openTestStore(':memory:');
  frontier = new SourceFrontier({ store, clock });
});
afterEach(() => store.close());

function offer(pk: string): void {
  store.observe({ accountPk: pk, observedAt: clock.now(), source: 'profile', fields: { username: pk } });
  frontier.offer(pk, 'seed');
}

function queue(pk: string, source: string): FollowRecord {
  return { accountPk: pk, targetPk: source, state: 'queued', retryCount: 0, score: 1 };
}

function followed(pk: string, source: string, state: FollowState = 'pending_followback'): void {
  store.upsertFollowRecord({ ...queue(pk, source), state, followedAt: 1 });
  store.recordAction(pk, 'follow', 'ok', 1);
}

test('an absent legacy source receives credit for its recent follows on exploration', () => {
  offer('live');
  for (let i = 0; i < 3; i++) frontier.noteFollow('legacy');
  frontier.noteFollow('live');
  const before = store.getSourceFrontierState();
  expect(frontier.pickQueued([queue('legacy-person', 'legacy'), queue('live-person', 'live')])?.targetPk).toBe('live');
  expect(store.getSourceFrontierState()).toBe(before);
  expect(frontier.snapshot().sources.map((source) => source.pk)).toEqual(['live']);
  expect(frontier.pickQueued([queue('legacy-person', 'legacy')])?.targetPk).toBe('legacy');
});

test.each(FOLLOW_STATES)('retained %s follow history survives absence from the rolling window and restart', (state) => {
  offer('live');
  for (let i = 0; i < 6; i++) followed(`old-${i}`, 'legacy', state);
  for (let i = 0; i < 4; i++) frontier.noteFollow('live');
  const before = store.getSourceFrontierState();
  frontier = new SourceFrontier({ store, clock });
  expect(frontier.snapshot().recentFollowSources).not.toContain('legacy');
  expect(frontier.pickQueued([queue('legacy-person', 'legacy'), queue('live-person', 'live')])?.targetPk).toBe('live');
  expect(store.getSourceFrontierState()).toBe(before);
});

test('a newly offered legacy source retains its historical use for both queue and visit selection', () => {
  offer('live');
  for (let i = 0; i < 6; i++) followed(`old-${i}`, 'legacy');
  for (let i = 0; i < 4; i++) frontier.noteFollow('live');
  offer('legacy');
  expect(frontier.snapshot().sources.find((source) => source.pk === 'legacy')?.totalFollows).toBe(0);
  expect(frontier.pickQueued([queue('legacy-person', 'legacy'), queue('live-person', 'live')])?.targetPk).toBe('live');
  expect(frontier.next()?.pk).toBe('live');
});

test('queued and cleanup-only records without a follow timestamp do not fabricate lifetime use', () => {
  offer('live');
  for (const state of FOLLOW_STATES) {
    store.upsertFollowRecord({ ...queue(`unfollowed-${state}`, 'legacy'), state });
  }
  for (let i = 0; i < 4; i++) frontier.noteFollow('live');
  expect(frontier.pickQueued([queue('legacy-person', 'legacy'), queue('live-person', 'live')])?.targetPk).toBe('legacy');
});

test('old cycles, simulated timestamps, failed follows and unfollows cannot credit the current source', () => {
  offer('live');
  followed('requeued', 'old-source');
  store.upsertFollowRecord({ ...queue('requeued', 'legacy'), followedAt: 2 });
  for (const pk of ['simulated', 'failed', 'cleanup']) {
    store.upsertFollowRecord({ ...queue(pk, 'legacy'), followedAt: 2 });
  }
  store.recordAction('failed', 'follow', 'fail', 2);
  store.recordAction('cleanup', 'unfollow', 'ok', 2);
  expect(store.followRecords.successfulFollowsBySource()).toEqual(new Map());
  for (let i = 0; i < 4; i++) frontier.noteFollow('live');
  expect(frontier.pickQueued([queue('legacy-person', 'legacy'), queue('live-person', 'live')])?.targetPk).toBe('legacy');
});

test('overlapping frontier, recent and record evidence is not added together', () => {
  offer('a'); offer('b');
  for (let i = 0; i < 4; i++) { followed(`a-${i}`, 'a'); frontier.noteFollow('a'); }
  for (let i = 0; i < 5; i++) frontier.noteFollow('b');
  expect(frontier.pickQueued([queue('a-person', 'a'), queue('b-person', 'b')])?.targetPk).toBe('a');
});

test('ordinary opportunities keep recent-source diversity ahead of lifetime use', () => {
  offer('live');
  for (let i = 0; i < 6; i++) followed(`old-${i}`, 'legacy');
  frontier.noteFollow('live');
  expect(frontier.pickQueued([queue('legacy-person', 'legacy'), queue('live-person', 'live')])?.targetPk).toBe('legacy');
});

test('empty history and duplicate ledger evidence produce honest source counts', () => {
  expect(store.followRecords.successfulFollowsBySource()).toEqual(new Map());
  expect(frontier.pickQueued([])).toBeNull();
  followed('one-person', 'legacy');
  store.recordAction('one-person', 'follow', 'ok', 1);
  expect(store.followRecords.successfulFollowsBySource()).toEqual(new Map([['legacy', 1]]));
});

test('historical queues preserve the live-source cap and read history once only on exploration', () => {
  for (let i = 0; i < POLICY.maxSources; i++) offer(`live-${i}`);
  const candidates = Array.from({ length: POLICY.maxSources * 2 }, (_, i) => queue(`person-${i}`, `legacy-${i}`));
  for (const record of candidates) followed(`old-${record.accountPk}`, record.targetPk!);
  const read = jest.spyOn(store.followRecords, 'successfulFollowsBySource');
  frontier.pickQueued(candidates);
  expect(read).not.toHaveBeenCalled();
  for (let i = 0; i < 4; i++) frontier.noteFollow('live-0');
  expect(frontier.pickQueued(candidates)).not.toBeNull();
  expect(read).toHaveBeenCalledTimes(1);
  expect(frontier.snapshot().sources).toHaveLength(POLICY.maxSources);
});

test('a failed history read cannot silently make every source look unused', () => {
  for (let i = 0; i < 4; i++) frontier.noteFollow('live');
  const failure = new Error('history read failed');
  jest.spyOn(store.followRecords, 'successfulFollowsBySource').mockImplementation(() => { throw failure; });
  expect(() => frontier.pickQueued([queue('person', 'legacy')])).toThrow(failure);
});

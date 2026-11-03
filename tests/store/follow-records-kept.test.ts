/**
 * The kept moves on the follow-records repo (spec §7.5): into `kept` with its stamp, back out to
 * the lifecycle, and back into the unfollow queue for an unreadable re-check; one transaction per
 * batch, guarded by the state each move leaves from.
 */
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { FollowRecord } from '@/store/types';
import { memoryStore } from '../kit/store';

let s: KnowledgeStore;
let pulses: number;
beforeEach(() => {
  s = memoryStore();
  pulses = 0;
  s.onMutation(() => { pulses += 1; });
});
afterEach(() => s.close());

const rec = (over: Partial<FollowRecord> & { accountPk: string }): FollowRecord => ({
  targetPk: null, state: 'unfollow_queued', retryCount: 0, followedAt: 10, unfollowDueAt: 50, ...over,
});
const stamp = { reason: 'bio-word' as const, match: 'cafe', at: 100, recheckAt: null, checks: 0 };

test('keep moves an active record into kept with its stamp; the queue position is kept', () => {
  s.upsertFollowRecord(rec({ accountPk: 'a', reconciledAt: 40 }));
  pulses = 0;
  expect(s.followRecords.review([{ pk: 'a', move: 'keep', stamp }])).toBe(1);
  expect(s.getFollowRecord('a')).toMatchObject({
    state: 'kept', keptReason: 'bio-word', keptMatch: 'cafe', keptAt: 100, checkFailures: 0, unfollowDueAt: 50,
  });
  expect(s.getFollowRecord('a')?.recheckAt).toBeUndefined();
  expect(pulses).toBe(1);
});

test('keep never touches a terminal or queued-for-follow record', () => {
  for (const state of ['queued', 'unfollowed', 'abandoned', 'external'] as const) {
    s.upsertFollowRecord(rec({ accountPk: state, state }));
  }
  const moved = s.followRecords.review(
    (['queued', 'unfollowed', 'abandoned', 'external'] as const).map((pk) => ({ pk, move: 'keep' as const, stamp })),
  );
  expect(moved).toBe(0);
  expect(s.followRecordsByState('kept')).toEqual([]);
});

test('release returns a kept record to the lifecycle with its kept columns cleared', () => {
  s.upsertFollowRecord(rec({ accountPk: 'a', state: 'kept', keptReason: 'unreadable-bio', keptAt: 100,
    recheckAt: 200, checkFailures: 2, reconciledAt: 90 }));
  expect(s.followRecords.review([{ pk: 'a', move: 'release', to: 'followed_back' }])).toBe(1);
  const got = s.getFollowRecord('a');
  expect(got).toMatchObject({ state: 'followed_back', checkFailures: 0 });
  expect([got?.keptReason, got?.keptMatch, got?.keptAt, got?.recheckAt, got?.reconciledAt])
    .toEqual([undefined, undefined, undefined, undefined, undefined]);
});

test('recheck sends a kept record back to the unfollow queue and keeps its failure count', () => {
  s.upsertFollowRecord(rec({ accountPk: 'a', state: 'kept', keptReason: 'unreadable-bio', keptAt: 100,
    recheckAt: 200, checkFailures: 2 }));
  expect(s.followRecords.review([{ pk: 'a', move: 'recheck' }])).toBe(1);
  expect(s.getFollowRecord('a')).toMatchObject({ state: 'unfollow_queued', checkFailures: 2, unfollowDueAt: 50 });
  expect(s.getFollowRecord('a')?.recheckAt).toBeUndefined();
});

test('release and recheck move only kept records', () => {
  s.upsertFollowRecord(rec({ accountPk: 'a', state: 'pending_followback' }));
  expect(s.followRecords.review([{ pk: 'a', move: 'release', to: 'followed_back' }, { pk: 'a', move: 'recheck' }])).toBe(0);
  expect(s.getFollowRecord('a')?.state).toBe('pending_followback');
});

test('a batch is one transaction: one pulse, and nothing for an empty batch', () => {
  s.upsertFollowRecord(rec({ accountPk: 'a' }));
  s.upsertFollowRecord(rec({ accountPk: 'b', state: 'followed_back' }));
  pulses = 0;
  expect(s.followRecords.review([])).toBe(0);
  expect(pulses).toBe(0);
  expect(s.followRecords.review([{ pk: 'a', move: 'keep', stamp }, { pk: 'b', move: 'keep', stamp }])).toBe(2);
  expect(pulses).toBe(1);
});

test('kept pages, counts and the due re-checks', () => {
  s.upsertFollowRecord(rec({ accountPk: 'a', state: 'kept', keptReason: 'account', keptAt: 30 }));
  s.upsertFollowRecord(rec({ accountPk: 'b', state: 'kept', keptReason: 'unreadable-bio', keptAt: 20, recheckAt: 500 }));
  s.upsertFollowRecord(rec({ accountPk: 'c', state: 'kept', keptReason: 'unreadable-verified', keptAt: 10, recheckAt: 900 }));
  s.upsertFollowRecord(rec({ accountPk: 'd', state: 'pending_followback' }));
  expect(s.followRecords.kept(0, 2).map((r) => r.accountPk)).toEqual(['a', 'b']);
  expect(s.followRecords.kept(1, 2).map((r) => r.accountPk)).toEqual(['c']);
  expect(s.followRecords.keptCounts()).toEqual({ total: 3, unreadable: 2 });
  expect(s.followRecords.recheckDue(499).map((r) => r.accountPk)).toEqual([]);
  expect(s.followRecords.recheckDue(500).map((r) => r.accountPk)).toEqual(['b']);
  expect(s.followRecords.recheckDue(1_000).map((r) => r.accountPk).sort()).toEqual(['b', 'c']);
});

test('the funnel counts kept records', () => {
  s.upsertFollowRecord(rec({ accountPk: 'a', targetPk: 'T', state: 'kept', keptReason: 'verified', keptAt: 1 }));
  expect(s.targetFunnel('T').states.kept).toBe(1);
});

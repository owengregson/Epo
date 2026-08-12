import { KnowledgeStore } from '@/store/knowledge-store';
import type { FollowRecord } from '@/store/types';

let s: KnowledgeStore;
beforeEach(() => { s = new KnowledgeStore(':memory:'); });
afterEach(() => s.close());

const rec = (over: Partial<FollowRecord> & { accountPk: string }): FollowRecord => ({
  targetPk: null,
  state: 'queued',
  retryCount: 0,
  ...over,
});

test('upsertFollowRecord round-trips all fields via getFollowRecord', () => {
  const r = rec({
    accountPk: '10',
    targetPk: 'T',
    state: 'followed_back',
    followedAt: 100,
    followedBackAt: 200,
    holdUntil: 300,
    unfollowDueAt: 400,
    retryCount: 2,
  });
  s.upsertFollowRecord(r);
  expect(s.getFollowRecord('10')).toEqual(r);
  expect(s.getFollowRecord('nope')).toBeNull();
});

test('upsert on conflict replaces all columns for the same account_pk', () => {
  s.upsertFollowRecord(rec({ accountPk: '10', state: 'queued', retryCount: 0 }));
  s.upsertFollowRecord(
    rec({ accountPk: '10', targetPk: 'T', state: 'pending_followback', followedAt: 500, retryCount: 1 }),
  );
  const got = s.getFollowRecord('10')!;
  expect(got.state).toBe('pending_followback');
  expect(got.targetPk).toBe('T');
  expect(got.followedAt).toBe(500);
  expect(got.retryCount).toBe(1);
});

test('followRecordsByState filters correctly', () => {
  s.upsertFollowRecord(rec({ accountPk: '1', state: 'queued' }));
  s.upsertFollowRecord(rec({ accountPk: '2', state: 'pending_followback' }));
  s.upsertFollowRecord(rec({ accountPk: '3', state: 'queued' }));
  const queued = s.followRecordsByState('queued').map((r) => r.accountPk).sort();
  expect(queued).toEqual(['1', '3']);
  expect(s.followRecordsByState('unfollowed')).toEqual([]);
});

test('activeFollowRecords excludes terminal states', () => {
  s.upsertFollowRecord(rec({ accountPk: '1', state: 'queued' }));
  s.upsertFollowRecord(rec({ accountPk: '2', state: 'pending_followback' }));
  s.upsertFollowRecord(rec({ accountPk: '3', state: 'unfollowed' }));
  s.upsertFollowRecord(rec({ accountPk: '4', state: 'abandoned' }));
  const active = s.activeFollowRecords().map((r) => r.accountPk).sort();
  expect(active).toEqual(['1', '2']);
});

test('followRecordPks returns all account_pks with a record', () => {
  s.upsertFollowRecord(rec({ accountPk: '1' }));
  s.upsertFollowRecord(rec({ accountPk: '2', state: 'unfollowed' }));
  expect(s.followRecordPks()).toEqual(new Set(['1', '2']));
});

test('followersOf returns only active-edge sources for the target', () => {
  s.observeEdge('A', 'T', 'follows', true, 100);   // A follows T (active)
  s.observeEdge('B', 'T', 'follows', true, 100);   // B follows T (active)
  s.observeEdge('C', 'T', 'follows', false, 100);  // C unfollowed T (removed)
  s.observeEdge('A', 'OTHER', 'follows', true, 100); // unrelated target
  expect(s.followersOf('T').sort()).toEqual(['A', 'B']);
  expect(s.followersOf('none')).toEqual([]);
});

test('candidatePksForTarget excludes existing follow_records and the target itself', () => {
  s.observeEdge('A', 'T', 'follows', true, 100);
  s.observeEdge('B', 'T', 'follows', true, 100);
  s.observeEdge('C', 'T', 'follows', true, 100);
  s.observeEdge('T', 'T', 'follows', true, 100);   // self-edge; target must be excluded
  s.upsertFollowRecord(rec({ accountPk: 'B' }));    // B already in a record
  expect(s.candidatePksForTarget('T').sort()).toEqual(['A', 'C']);
});

test('setRole + getAccount().role round-trips', () => {
  s.observe({ accountPk: '9', observedAt: 100, source: 'profile', fields: { followers: 1, following: 1 } });
  expect(s.getAccount('9')!.role).toBeUndefined();
  s.setRole('9', 'target');
  expect(s.getAccount('9')!.role).toBe('target');
});

import { KnowledgeStore } from '@/store/knowledge-store';
import type { FollowRecord, Target } from '@/store/types';

const OWN = 'me';

let s: KnowledgeStore;
beforeEach(() => { s = new KnowledgeStore(':memory:'); });
afterEach(() => s.close());

const target = (over: Partial<Target> & { accountPk: string }): Target => ({
  source: 'seed',
  status: 'active',
  chainIndex: null,
  ...over,
});

const rec = (over: Partial<FollowRecord> & { accountPk: string }): FollowRecord => ({
  targetPk: null,
  state: 'queued',
  retryCount: 0,
  ...over,
});

test('addTarget + getTarget round-trips all fields', () => {
  const t = target({ accountPk: 'T1', source: 'discovered', status: 'active', chainIndex: 3 });
  s.addTarget(t);
  expect(s.getTarget('T1')).toEqual(t);
  expect(s.getTarget('nope')).toBeNull();
});

test('addTarget upserts on conflict (same account_pk replaces columns)', () => {
  s.addTarget(target({ accountPk: 'T1', source: 'seed', status: 'active', chainIndex: 0 }));
  s.addTarget(target({ accountPk: 'T1', source: 'discovered', status: 'retained', chainIndex: 5 }));
  expect(s.getTarget('T1')).toEqual(
    target({ accountPk: 'T1', source: 'discovered', status: 'retained', chainIndex: 5 }),
  );
});

test('setTargetStatus updates only status', () => {
  s.addTarget(target({ accountPk: 'T1', chainIndex: 0 }));
  s.setTargetStatus('T1', 'exhausted');
  expect(s.getTarget('T1')!.status).toBe('exhausted');
  expect(s.getTarget('T1')!.chainIndex).toBe(0);
});

test('listTargets orders by chain_index, nulls last', () => {
  s.addTarget(target({ accountPk: 'B', chainIndex: 1 }));
  s.addTarget(target({ accountPk: 'A', chainIndex: 0 }));
  s.addTarget(target({ accountPk: 'Z', chainIndex: null }));
  s.addTarget(target({ accountPk: 'C', chainIndex: 2 }));
  expect(s.listTargets().map((t) => t.accountPk)).toEqual(['A', 'B', 'C', 'Z']);
});

test('nextChainIndex is (MAX ?? -1) + 1', () => {
  expect(s.nextChainIndex()).toBe(0);
  s.addTarget(target({ accountPk: 'A', chainIndex: 0 }));
  expect(s.nextChainIndex()).toBe(1);
  s.addTarget(target({ accountPk: 'B', chainIndex: 4 }));
  expect(s.nextChainIndex()).toBe(5);
  // Null chain_index does not affect MAX.
  s.addTarget(target({ accountPk: 'C', chainIndex: null }));
  expect(s.nextChainIndex()).toBe(5);
});

test('targetYield counts followed records aimed at the target, computes rate', () => {
  // Aimed at T and past follow stage: 4 total, 2 reciprocated.
  s.upsertFollowRecord(
    rec({ accountPk: '1', targetPk: 'T', state: 'pending_followback' }),
  );
  s.upsertFollowRecord(
    rec({ accountPk: '2', targetPk: 'T', state: 'followed_back', followedBackAt: 500 }),
  );
  s.upsertFollowRecord(
    rec({ accountPk: '3', targetPk: 'T', state: 'unfollow_queued', followedBackAt: 600 }),
  );
  s.upsertFollowRecord(rec({ accountPk: '4', targetPk: 'T', state: 'unfollowed' }));
  // Excluded: still queued (never followed), and a different target.
  s.upsertFollowRecord(rec({ accountPk: '5', targetPk: 'T', state: 'queued' }));
  s.upsertFollowRecord(
    rec({ accountPk: '6', targetPk: 'OTHER', state: 'followed_back', followedBackAt: 700 }),
  );

  const y = s.targetYield('T', OWN);
  expect(y.total).toBe(4);
  expect(y.followedBack).toBe(2);
  expect(y.followBackRate).toBeCloseTo(0.5);
});

test('targetYield returns 0 rate when no follows exist for the target', () => {
  const y = s.targetYield('EMPTY', OWN);
  expect(y).toEqual({
    total: 0,
    followedBack: 0,
    followBackRate: 0,
    poolSize: 0,
    mutualOverlap: 0,
  });
});

test('targetYield poolSize + mutualOverlap from active edges', () => {
  // Followers of T: A, B, C active; D removed (excluded from pool).
  s.observeEdge('A', 'T', 'follows', true, 100);
  s.observeEdge('B', 'T', 'follows', true, 100);
  s.observeEdge('C', 'T', 'follows', true, 100);
  s.observeEdge('D', 'T', 'follows', false, 100);
  // We already actively follow A and C; our follow of B was removed (no overlap).
  s.observeEdge(OWN, 'A', 'follows', true, 100);
  s.observeEdge(OWN, 'C', 'follows', true, 100);
  s.observeEdge(OWN, 'B', 'follows', false, 100);

  const y = s.targetYield('T', OWN);
  expect(y.poolSize).toBe(3);
  expect(y.mutualOverlap).toBe(2);
});

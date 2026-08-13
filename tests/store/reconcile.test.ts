import { KnowledgeStore } from '@/store/knowledge-store';
import type { FollowRecord } from '@/store/types';
import { setLevel } from '@/utils/logger';

// Keep test output quiet; reconciliation logs info/warn on every drop.
beforeAll(() => setLevel('error'));

const OWN = 'ME';
const AT = 1_700_000_000_000;

let s: KnowledgeStore;
beforeEach(() => { s = new KnowledgeStore(':memory:'); });
afterEach(() => s.close());

const rec = (over: Partial<FollowRecord> & { accountPk: string }): FollowRecord => ({
  targetPk: null,
  state: 'queued',
  retryCount: 0,
  ...over,
});

/** Give a pk an accounts row so `setRole` (an UPDATE) has something to mark. */
const seedAccount = (pk: string): void =>
  s.observe({ accountPk: pk, observedAt: AT, source: 'profile', fields: { followers: 1, following: 1 } });

describe('KnowledgeStore.reconcileOwnFollow (leave-alone policy sink)', () => {
  test('ownPk unset → noop, no edge written', () => {
    s.upsertFollowRecord(rec({ accountPk: '1', state: 'pending_followback', followedAt: AT }));
    expect(s.reconcileOwnFollow('1', false, AT)).toBe('noop');
    expect(s.getFollowRecord('1')!.state).toBe('pending_followback');
    expect(s.getEdge(OWN, '1', 'follows')).toBeNull();
  });

  test('self pk → noop (never reconcile our own account)', () => {
    s.setOwnPk(OWN);
    expect(s.reconcileOwnFollow(OWN, true, AT)).toBe('noop');
    expect(s.getEdge(OWN, OWN, 'follows')).toBeNull();
  });

  test('held record + weFollow=false → dropped-held: external, role skipped, edge removed, NO ledger', () => {
    s.setOwnPk(OWN);
    for (const [pk, state] of [
      ['p', 'pending_followback'],
      ['f', 'followed_back'],
      ['u', 'unfollow_queued'],
    ] as const) {
      seedAccount(pk);
      s.upsertFollowRecord(rec({ accountPk: pk, state, followedAt: AT }));
      expect(s.reconcileOwnFollow(pk, false, AT)).toBe('dropped-held');
      expect(s.getFollowRecord(pk)!.state).toBe('external');
      expect(s.getAccount(pk)!.role).toBe('skipped');
      expect(s.getEdge(OWN, pk, 'follows')!.status).toBe('removed');
    }
    // Reconciliation is not our action — never a ledger row.
    expect(s.actionCountSince(0)).toBe(0);
  });

  test('queued record + weFollow=true → dropped-queued: external, role skipped, edge active, NO ledger', () => {
    s.setOwnPk(OWN);
    seedAccount('q');
    s.upsertFollowRecord(rec({ accountPk: 'q', state: 'queued' }));
    expect(s.reconcileOwnFollow('q', true, AT)).toBe('dropped-queued');
    expect(s.getFollowRecord('q')!.state).toBe('external');
    expect(s.getAccount('q')!.role).toBe('skipped');
    expect(s.getEdge(OWN, 'q', 'follows')!.status).toBe('active');
    expect(s.actionCountSince(0)).toBe(0);
  });

  test('consistent / terminal / recordless observations → edge-only', () => {
    s.setOwnPk(OWN);
    // No record at all: the edge is still recorded as truth.
    expect(s.reconcileOwnFollow('x', true, AT)).toBe('edge-only');
    expect(s.getEdge(OWN, 'x', 'follows')!.status).toBe('active');
    // Consistent held record (we DO follow): left alone.
    s.upsertFollowRecord(rec({ accountPk: 'h', state: 'pending_followback', followedAt: AT }));
    expect(s.reconcileOwnFollow('h', true, AT)).toBe('edge-only');
    expect(s.getFollowRecord('h')!.state).toBe('pending_followback');
    // Consistent queued record (we do NOT follow yet): left alone.
    s.upsertFollowRecord(rec({ accountPk: 'q', state: 'queued' }));
    expect(s.reconcileOwnFollow('q', false, AT)).toBe('edge-only');
    expect(s.getFollowRecord('q')!.state).toBe('queued');
    // Terminal record: never resurrected.
    s.upsertFollowRecord(rec({ accountPk: 't', state: 'unfollowed' }));
    expect(s.reconcileOwnFollow('t', true, AT)).toBe('edge-only');
    expect(s.getFollowRecord('t')!.state).toBe('unfollowed');
  });
});

describe('KnowledgeStore.accountsWeFollow', () => {
  test('returns dst_pks of our own ACTIVE follows edges; empty when ownPk unset', () => {
    s.observeEdge(OWN, 'a', 'follows', true, AT);
    s.observeEdge(OWN, 'b', 'follows', false, AT); // removed → excluded
    s.observeEdge('other', 'c', 'follows', true, AT); // not ours → excluded
    expect(s.accountsWeFollow()).toEqual(new Set());
    s.setOwnPk(OWN);
    expect(s.accountsWeFollow()).toEqual(new Set(['a']));
  });
});

describe("'external' is terminal", () => {
  test('activeFollowRecords excludes external records', () => {
    s.upsertFollowRecord(rec({ accountPk: '1', state: 'queued' }));
    s.upsertFollowRecord(rec({ accountPk: '2', state: 'external' }));
    expect(s.activeFollowRecords().map((r) => r.accountPk)).toEqual(['1']);
  });
});

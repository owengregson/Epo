import { KnowledgeStore } from '@/store/knowledge-store';
import type { FollowRecord } from '@/store/types';

/**
 * The Targets console's store reads (`targetFunnel`, `followbackTimingFor`,
 * `followActionCountSince`) — COUNT-only SQL twins of the candidate/yield
 * walks, safe in projection position. Real in-memory SQLite, no browser.
 */

const OWN = 'me';

let s: KnowledgeStore;
beforeEach(() => {
  s = new KnowledgeStore(':memory:');
});
afterEach(() => s.close());

const rec = (over: Partial<FollowRecord> & { accountPk: string }): FollowRecord => ({
  targetPk: null,
  state: 'queued',
  retryCount: 0,
  ...over,
});

/** Observe a bare account row so `setRole` (an UPDATE) has a row to hit. */
const seen = (pk: string): void =>
  s.observe({ accountPk: pk, observedAt: 100, source: 'followers-list', fields: {} });

describe('targetFunnel', () => {
  test('groups records by state, zero-filled across the WHOLE union (abandoned + external included)', () => {
    s.upsertFollowRecord(rec({ accountPk: '1', targetPk: 'T', state: 'queued' }));
    s.upsertFollowRecord(rec({ accountPk: '2', targetPk: 'T', state: 'queued' }));
    s.upsertFollowRecord(rec({ accountPk: '3', targetPk: 'T', state: 'pending_followback' }));
    s.upsertFollowRecord(rec({ accountPk: '4', targetPk: 'T', state: 'followed_back' }));
    s.upsertFollowRecord(rec({ accountPk: '5', targetPk: 'T', state: 'abandoned' }));
    s.upsertFollowRecord(rec({ accountPk: '6', targetPk: 'T', state: 'external' }));
    // A different target's record never leaks into T's funnel.
    s.upsertFollowRecord(rec({ accountPk: '7', targetPk: 'OTHER', state: 'unfollowed' }));

    expect(s.targetFunnel('T').states).toEqual({
      queued: 2,
      pending_followback: 1,
      followed_back: 1,
      unfollow_queued: 0,
      unfollowed: 0,
      abandoned: 1,
      external: 1,
    });
  });

  test('observed mirrors observedFollowerCount (active edges only)', () => {
    s.observeEdge('A', 'T', 'follows', true, 100);
    s.observeEdge('B', 'T', 'follows', true, 100);
    s.observeEdge('C', 'T', 'follows', false, 100); // removed — not observed pool
    const f = s.targetFunnel('T');
    expect(f.observed).toBe(2);
    expect(f.observed).toBe(s.observedFollowerCount('T'));
  });

  test('candidates is the COUNT twin of candidatePksForTarget (all exclusions)', () => {
    s.setOwnPk(OWN);
    // Followers of T: A clean · B recorded · C skipped · D already followed ·
    // OWN (we appear in follower lists) · E removed edge.
    for (const pk of ['A', 'B', 'C', 'D']) {
      seen(pk);
      s.observeEdge(pk, 'T', 'follows', true, 100);
    }
    s.observeEdge(OWN, 'T', 'follows', true, 100);
    s.observeEdge('E', 'T', 'follows', false, 100);
    s.upsertFollowRecord(rec({ accountPk: 'B', targetPk: 'T', state: 'unfollowed' }));
    s.setRole('C', 'skipped');
    s.observeEdge(OWN, 'D', 'follows', true, 100);

    const f = s.targetFunnel('T');
    expect(f.candidates).toBe(1); // A alone survives
    expect(f.candidates).toBe(s.candidatePksForTarget('T').length);
  });

  test('candidates parity holds with the own pk UNSET (no self/we-follow exclusion)', () => {
    seen('A');
    seen('D');
    s.observeEdge('A', 'T', 'follows', true, 100);
    s.observeEdge('D', 'T', 'follows', true, 100);
    s.observeEdge(OWN, 'D', 'follows', true, 100); // not attributable without ownPk

    const f = s.targetFunnel('T');
    expect(f.candidates).toBe(s.candidatePksForTarget('T').length);
    expect(f.candidates).toBe(2);
  });

  test('a target with nothing recorded reads all-zero, not an error', () => {
    expect(s.targetFunnel('EMPTY')).toEqual({
      states: {
        queued: 0,
        pending_followback: 0,
        followed_back: 0,
        unfollow_queued: 0,
        unfollowed: 0,
        abandoned: 0,
        external: 0,
      },
      observed: 0,
      candidates: 0,
    });
  });
});

describe('followbackTimingFor', () => {
  test('empty sample → resolved 0, median null', () => {
    expect(s.followbackTimingFor('T')).toEqual({ resolved: 0, medianMs: null });
  });

  test('odd count → the middle delta; rows missing either stamp are excluded', () => {
    s.upsertFollowRecord(
      rec({ accountPk: '1', targetPk: 'T', state: 'followed_back', followedAt: 0, followedBackAt: 100 }),
    );
    s.upsertFollowRecord(
      rec({ accountPk: '2', targetPk: 'T', state: 'followed_back', followedAt: 0, followedBackAt: 900 }),
    );
    s.upsertFollowRecord(
      rec({ accountPk: '3', targetPk: 'T', state: 'unfollowed', followedAt: 100, followedBackAt: 400 }),
    );
    // No followed_back_at (still waiting) — never part of the sample.
    s.upsertFollowRecord(
      rec({ accountPk: '4', targetPk: 'T', state: 'pending_followback', followedAt: 0 }),
    );
    // Another target's resolution stays out.
    s.upsertFollowRecord(
      rec({ accountPk: '5', targetPk: 'OTHER', state: 'followed_back', followedAt: 0, followedBackAt: 5 }),
    );

    expect(s.followbackTimingFor('T')).toEqual({ resolved: 3, medianMs: 300 });
  });

  test('even count → the average of the two middle deltas', () => {
    const deltas = [100, 200, 400, 1000];
    deltas.forEach((d, i) => {
      s.upsertFollowRecord(
        rec({
          accountPk: String(i),
          targetPk: 'T',
          state: 'followed_back',
          followedAt: 0,
          followedBackAt: d,
        }),
      );
    });
    expect(s.followbackTimingFor('T')).toEqual({ resolved: 4, medianMs: 300 });
  });
});

describe('followActionCountSince', () => {
  test('counts landed follows only — unfollows and failures excluded, window respected', () => {
    s.recordAction('1', 'follow', 'ok', 1_000);
    s.recordAction('2', 'follow', 'ok', 2_000);
    s.recordAction('3', 'follow', 'fail', 2_500); // failure — not realized pace
    s.recordAction('4', 'unfollow', 'ok', 3_000); // not forward progress
    s.recordAction('5', 'follow', 'ok', 500); // before the window

    expect(s.followActionCountSince(900)).toBe(2);
    expect(s.actionCountSince(900)).toBe(4); // sanity: the plain count still sees all
  });
});

/**
 * Protection on the churn paths (spec §7.4): P1 (no-follow-back reclaim), P2 (hold-expired rotation),
 * P3 (the unfollow itself) and P4 (a healer requeue). Selection judges stored facts before any
 * evidence logic: protected → kept, paused → no unfollow while follows continue.
 */
import { CHURN_DEFAULTS, type ChurnConfig, ChurnScheduler } from '@/engine/churn-scheduler';
import { FakeClock } from '@/governors/clock';
import { RateGovernor } from '@/governors/rate-governor';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { FollowRecord } from '@/store/types';
import { rec as baseRecord, FakeActions, kitStore, T0 } from '../kit/engine-harness';
import { ProtectionRig } from '../kit/harness-journal';

const OWN = 'me';
const WAIT = 1_000;
const rec = (over: Partial<FollowRecord> & { accountPk: string }): FollowRecord => baseRecord({ reconciledAt: T0, ...over });

function build(cfg: Partial<ChurnConfig> = {}) {
  const store = kitStore();
  const clock = new FakeClock(T0);
  const rate = new RateGovernor(store, clock, { dailyHardCeiling: 1000, dailyOperatingRate: 1000, minDelayMs: 0,
    maxDelayMs: 0, jitterPercent: 0, activeHoursStart: 0, activeHoursEnd: 24 });
  const actions = new FakeActions();
  const rig = new ProtectionRig(clock);
  const synced: number[] = [];
  const sched = new ChurnScheduler({ store, clock, rate, actions, ownPk: OWN,
    cfg: { ...CHURN_DEFAULTS, maxWaitForFollowbackMs: WAIT, ...cfg }, protection: rig.port,
    reconciler: { sync: (now) => { synced.push(now); } } });
  return { store, clock, actions, rig, sched, synced };
}

const profile = (store: KnowledgeStore, pk: string, fields: { bio?: string; isVerified?: boolean } = {}): void =>
  store.observe({ accountPk: pk, observedAt: T0, source: 'profile', fields: { username: `user${pk}`, ...fields } });

/** No follow-back since the follow, freshly confirmed: P1's evidence is complete. */
const unfollowedUs = (store: KnowledgeStore, pk: string, at: number): void => {
  store.observeEdge(pk, OWN, 'follows', true, T0 - 1);
  store.observeEdge(pk, OWN, 'follows', false, at);
};

describe('P1 — the no-follow-back reclaim', () => {
  test('a protected record past its wait is kept, before any evidence is asked for', () => {
    const { store, clock, rig, sched } = build();
    rig.words('cafe');
    profile(store, '1', { bio: 'Cafe owner' });
    store.upsertFollowRecord(rec({ accountPk: '1', state: 'pending_followback', followedAt: T0 }));
    clock.advance(WAIT);
    sched.advanceTimers();
    expect(store.getFollowRecord('1')).toMatchObject({ state: 'kept', keptReason: 'bio-word', keptMatch: 'cafe' });
  });

  test('bio words protect everyone, not only people who follow back', () => {
    const { store, clock, rig, sched } = build();
    rig.words('cal');
    profile(store, '1', { bio: 'calpico gaming' });
    store.upsertFollowRecord(rec({ accountPk: '1', state: 'pending_followback', followedAt: T0 }));
    clock.advance(WAIT);
    unfollowedUs(store, '1', clock.now());
    sched.advanceTimers();
    expect(store.getFollowRecord('1')?.state).toBe('kept');
  });

  test('paused: the record stays where it is and nothing is queued', () => {
    const { store, clock, rig, sched } = build();
    rig.pause('needs-review');
    profile(store, '1');
    store.upsertFollowRecord(rec({ accountPk: '1', state: 'pending_followback', followedAt: T0 }));
    clock.advance(WAIT);
    unfollowedUs(store, '1', clock.now());
    sched.advanceTimers();
    expect(store.getFollowRecord('1')?.state).toBe('pending_followback');
  });

  test('unknown at selection (no stored bio) keeps the normal timers: the click decides', () => {
    const { store, clock, rig, sched } = build();
    rig.words('cafe');
    profile(store, '1');
    store.upsertFollowRecord(rec({ accountPk: '1', state: 'pending_followback', followedAt: T0 }));
    clock.advance(WAIT);
    unfollowedUs(store, '1', clock.now());
    sched.advanceTimers();
    expect(store.getFollowRecord('1')?.state).toBe('unfollow_queued');
  });
});

describe('P2 — the hold-expired rotation', () => {
  test('a protected held mutual is kept instead of rotated out', () => {
    const { store, clock, rig, sched } = build();
    rig.verified();
    profile(store, '1', { isVerified: true });
    store.upsertFollowRecord(rec({ accountPk: '1', state: 'followed_back', followedBackAt: T0, holdUntil: T0 + 500 }));
    clock.advance(500);
    sched.advanceTimers();
    expect(store.getFollowRecord('1')).toMatchObject({ state: 'kept', keptReason: 'verified' });
  });

  test('keep-people-who-follow-back: a held mutual is never rotated out', () => {
    const { store, clock, sched } = build({ rotateMutuals: false });
    profile(store, '1');
    store.upsertFollowRecord(rec({ accountPk: '1', state: 'followed_back', followedBackAt: T0, holdUntil: T0 + 500 }));
    clock.advance(10 * 500);
    sched.advanceTimers();
    expect(store.getFollowRecord('1')?.state).toBe('followed_back');
  });

  test('an unprotected held mutual still rotates', () => {
    const { store, clock, rig, sched } = build();
    rig.words('cafe');
    profile(store, '1', { bio: 'photographer' });
    store.upsertFollowRecord(rec({ accountPk: '1', state: 'followed_back', followedBackAt: T0, holdUntil: T0 + 500 }));
    clock.advance(500);
    sched.advanceTimers();
    expect(store.getFollowRecord('1')?.state).toBe('unfollow_queued');
  });
});

describe('P3/P4 — the queued unfollow', () => {
  test('a queued unfollow a rule now protects (a healer requeue included) moves to kept', () => {
    const { store, clock, rig, sched } = build();
    rig.account('1', 'user1');
    profile(store, '1');
    store.upsertFollowRecord(rec({ accountPk: '1', state: 'abandoned', followedAt: T0, abandonedAt: T0 + 1 }));
    store.healAbandonedInWindow({ windowStartMs: T0, windowEndMs: T0 + 2, cap: 10, now: T0 + 3 });
    expect(store.getFollowRecord('1')?.state).toBe('unfollow_queued');
    clock.advance(5);
    sched.advanceTimers();
    expect(store.getFollowRecord('1')).toMatchObject({ state: 'kept', keptReason: 'account', keptMatch: '1' });
  });

  test('the unfollow re-checks right before the click: protected → kept, never clicked', async () => {
    const { store, actions, rig, sched } = build();
    profile(store, '1', { bio: 'cafe' });
    store.upsertFollowRecord(rec({ accountPk: '1', state: 'unfollow_queued', unfollowDueAt: T0 }));
    const due = sched.nextDue(T0, 'unfollow');
    rig.words('cafe');
    expect(await sched.execute(due as FollowRecord)).toBe('noop');
    expect(actions.unfollowCalls).toEqual([]);
    expect(store.getFollowRecord('1')?.state).toBe('kept');
  });

  test('paused: no unfollow is offered or clicked, and follows continue', async () => {
    const { store, actions, rig, sched } = build();
    profile(store, 'u');
    profile(store, 'f');
    store.upsertFollowRecord(rec({ accountPk: 'u', state: 'unfollow_queued', unfollowDueAt: T0 }));
    store.upsertFollowRecord(rec({ accountPk: 'f', state: 'queued', score: 1 }));
    rig.pause('unavailable');
    expect(sched.nextDue(T0, 'unfollow')).toBeNull();
    expect(sched.nextDue(T0)?.accountPk).toBe('f');
    expect(await sched.execute(store.getFollowRecord('u') as FollowRecord)).toBe('noop');
    await sched.tick();
    expect(actions.unfollowCalls).toEqual([]);
    expect(actions.followCalls).toEqual(['userf']);
    expect(store.getFollowRecord('u')?.state).toBe('unfollow_queued');
  });
});

test('the kept records are re-judged before every selection pass and on a settings reload', () => {
  const { clock, sched, synced } = build();
  sched.advanceTimers();
  clock.advance(7);
  sched.applyConfig({ ...CHURN_DEFAULTS, maxWaitForFollowbackMs: WAIT });
  expect(synced).toEqual([T0, T0 + 7]);
});

import { KnowledgeStore } from '@/store/knowledge-store';
import { FakeClock } from '@/governors/clock';
import { RateGovernor, type RateGovernorConfig } from '@/governors/rate-governor';
import {
  ChurnScheduler,
  CHURN_DEFAULTS,
  type ChurnActions,
  type ChurnActionOutcome,
  type ChurnConfig,
} from '@/engine/churn-scheduler';
import { setLevel } from '@/utils/logger';
import type { FollowRecord } from '@/store/types';

// Keep test output quiet; the scheduler logs info/warn on every transition.
beforeAll(() => setLevel('error'));

const T0 = Date.parse('2026-08-12T12:00:00');
const OWN = 'me';

/**
 * Records every call and returns a configurable discriminated outcome (R4). The
 * legacy `followOk`/`unfollowOk` booleans still map to `'ok'`/`'failed'` so the
 * pre-R4 tests read unchanged; `followStatus`/`unfollowStatus` override outright
 * for the `'blocked'`/`'simulated'` cases. No browser involved.
 */
class FakeActions implements ChurnActions {
  followCalls: string[] = [];
  unfollowCalls: string[] = [];
  followOk = true;
  unfollowOk = true;
  followStatus?: ChurnActionOutcome['status'];
  unfollowStatus?: ChurnActionOutcome['status'];
  /** Phase A: report an `ok` that clicked nothing (already in the target state). */
  followAlreadyInState?: boolean;
  unfollowAlreadyInState?: boolean;
  /** Recovery-ladder classification of a non-ok outcome (tab stall / drift). */
  followCause?: ChurnActionOutcome['cause'];
  unfollowCause?: ChurnActionOutcome['cause'];
  /** Amendment C: the click was dispatched but its verification stalled. */
  followUnverifiedClick?: boolean;
  unfollowUnverifiedClick?: boolean;
  async follow(username: string): Promise<ChurnActionOutcome> {
    this.followCalls.push(username);
    return {
      status: this.followStatus ?? (this.followOk ? 'ok' : 'failed'),
      alreadyInState: this.followAlreadyInState,
      cause: this.followCause,
      unverifiedClick: this.followUnverifiedClick,
    };
  }
  async unfollow(username: string): Promise<ChurnActionOutcome> {
    this.unfollowCalls.push(username);
    return {
      status: this.unfollowStatus ?? (this.unfollowOk ? 'ok' : 'failed'),
      alreadyInState: this.unfollowAlreadyInState,
      cause: this.unfollowCause,
      unverifiedClick: this.unfollowUnverifiedClick,
    };
  }
}

const rateCfg = (ceiling: number): RateGovernorConfig => ({
  dailyHardCeiling: ceiling,
  dailyOperatingRate: ceiling,
  minDelayMs: 0,
  maxDelayMs: 0,
  jitterPercent: 0,
  activeHoursStart: 0,
  activeHoursEnd: 24,
});

const rec = (over: Partial<FollowRecord> & { accountPk: string }): FollowRecord => ({
  targetPk: null,
  state: 'queued',
  retryCount: 0,
  ...over,
});

interface Harness {
  store: KnowledgeStore;
  clock: FakeClock;
  actions: FakeActions;
  sched: ChurnScheduler;
}

const makeHarness = (opts?: {
  ceiling?: number;
  cfg?: Partial<ChurnConfig>;
  ownPk?: string;
}): Harness => {
  const store = new KnowledgeStore(':memory:');
  const clock = new FakeClock(T0);
  const rate = new RateGovernor(store, clock, rateCfg(opts?.ceiling ?? 1000));
  const actions = new FakeActions();
  const sched = new ChurnScheduler({
    store,
    clock,
    rate,
    actions,
    ownPk: opts?.ownPk,
    cfg: { ...CHURN_DEFAULTS, ...opts?.cfg },
  });
  return { store, clock, actions, sched };
};

/** Give an account a known username so the scheduler can action it. */
const seedUsername = (store: KnowledgeStore, pk: string, username: string): void =>
  store.observe({
    accountPk: pk,
    observedAt: T0,
    source: 'profile',
    fields: { username, followers: 100, following: 100 },
  });

test('queued → tick → follow called, state pending_followback, followedAt set, ledger records follow', async () => {
  const { store, actions, sched } = makeHarness({ ownPk: OWN });
  seedUsername(store, '1', 'user1');
  store.upsertFollowRecord(rec({ accountPk: '1', targetPk: 'T', state: 'queued' }));

  await sched.tick();

  expect(actions.followCalls).toEqual(['user1']);
  const got = store.getFollowRecord('1')!;
  expect(got.state).toBe('pending_followback');
  expect(got.followedAt).toBe(T0);
  expect(store.actionCountSince(0)).toBe(1);
  // ownPk set → the follow is recorded as an active directed edge.
  expect(store.getEdge(OWN, '1', 'follows')?.status).toBe('active');
});

test('pending_followback past maxWaitForFollowbackMs → tick → unfollow_queued with unfollowDueAt', async () => {
  const { store, clock, sched } = makeHarness({ cfg: { maxWaitForFollowbackMs: 1000 } });
  // No username seeded → the timer transition is observable in isolation (action step skips).
  store.upsertFollowRecord(rec({ accountPk: '2', state: 'pending_followback', followedAt: T0 }));

  clock.advance(1000); // now - followedAt === maxWait
  await sched.tick();

  const got = store.getFollowRecord('2')!;
  expect(got.state).toBe('unfollow_queued');
  expect(got.unfollowDueAt).toBe(T0 + 1000);
});

test('followed_back with past holdUntil → tick → unfollow_queued', async () => {
  const { store, clock, sched } = makeHarness();
  // No username seeded → isolate the hold-timer transition from the unfollow action.
  store.upsertFollowRecord(
    rec({ accountPk: '3', state: 'followed_back', followedBackAt: T0, holdUntil: T0 + 500 }),
  );

  clock.advance(500); // now === holdUntil
  await sched.tick();

  const got = store.getFollowRecord('3')!;
  expect(got.state).toBe('unfollow_queued');
  expect(got.unfollowDueAt).toBe(T0 + 500);
});

test('unfollow_queued → tick → unfollow called, state unfollowed, edge removed', async () => {
  const { store, actions, sched } = makeHarness({ ownPk: OWN });
  seedUsername(store, '4', 'user4');
  store.observeEdge(OWN, '4', 'follows', true, T0); // we currently follow them
  store.upsertFollowRecord(rec({ accountPk: '4', state: 'unfollow_queued', unfollowDueAt: T0 }));

  await sched.tick();

  expect(actions.unfollowCalls).toEqual(['user4']);
  expect(store.getFollowRecord('4')!.state).toBe('unfollowed');
  expect(store.getEdge(OWN, '4', 'follows')?.status).toBe('removed');
});

test('failing follow increments retryCount and abandons once maxRetries exceeded', async () => {
  const { store, actions, sched } = makeHarness({ cfg: { maxRetries: 2 } });
  seedUsername(store, '5', 'user5');
  actions.followOk = false;
  store.upsertFollowRecord(rec({ accountPk: '5', state: 'queued' }));

  await sched.tick(); // fail → retryCount 1, still queued
  expect(store.getFollowRecord('5')).toMatchObject({ state: 'queued', retryCount: 1 });
  expect(store.getFollowRecord('5')!.abandonedAt).toBeUndefined(); // retries left: no stamp

  await sched.tick(); // fail → retryCount 2, still queued (2 > 2 is false)
  expect(store.getFollowRecord('5')).toMatchObject({ state: 'queued', retryCount: 2 });

  await sched.tick(); // fail → retryCount 3 > maxRetries → abandoned
  // The abandoning transition stamps WHEN it happened (the requeue-healer's
  // window signal) — at the same moment as its fail ledger row.
  expect(store.getFollowRecord('5')).toMatchObject({
    state: 'abandoned',
    retryCount: 3,
    abandonedAt: T0,
  });
  expect(actions.followCalls).toHaveLength(3);
});

test('at hard ceiling: no actions run and due records are NOT dropped', async () => {
  const { store, clock, actions, sched } = makeHarness({ ceiling: 3 });
  // Seed today's ledger up to the hard ceiling.
  for (let i = 0; i < 3; i++) store.recordAction(`x${i}`, 'follow', 'ok', clock.now());

  seedUsername(store, '6', 'user6');
  seedUsername(store, '7', 'user7');
  store.upsertFollowRecord(rec({ accountPk: '6', state: 'queued' }));
  store.upsertFollowRecord(rec({ accountPk: '7', state: 'unfollow_queued', unfollowDueAt: T0 }));

  // The Engine gates on the ceiling BEFORE calling nextDue/execute; here we assert
  // that advancing timers alone (the only thing safe at the ceiling) touches no actions.
  sched.advanceTimers(clock.now());

  expect(actions.followCalls).toEqual([]);
  expect(actions.unfollowCalls).toEqual([]);
  // The critical invariant: nothing is silently discarded — both remain active & due.
  const active = store.activeFollowRecords().map((r) => r.accountPk).sort();
  expect(active).toEqual(['6', '7']);
  expect(store.getFollowRecord('6')!.state).toBe('queued');
  expect(store.getFollowRecord('7')!.state).toBe('unfollow_queued');
});

// ── The three-method split (§3.2) ──────────────────────────────────────────────

test('advanceTimers applies timeouts and holds with ZERO calls to actions', async () => {
  const { store, clock, actions, sched } = makeHarness({ cfg: { maxWaitForFollowbackMs: 1000 } });
  // A pending_followback whose max wait has elapsed, and a held-out followed_back.
  store.upsertFollowRecord(rec({ accountPk: 'p', state: 'pending_followback', followedAt: T0 }));
  store.upsertFollowRecord(
    rec({ accountPk: 'h', state: 'followed_back', followedBackAt: T0, holdUntil: T0 + 500 }),
  );

  clock.advance(1000);
  sched.advanceTimers(clock.now());

  expect(store.getFollowRecord('p')!.state).toBe('unfollow_queued');
  expect(store.getFollowRecord('p')!.unfollowDueAt).toBe(T0 + 1000);
  expect(store.getFollowRecord('h')!.state).toBe('unfollow_queued');
  expect(store.getFollowRecord('h')!.unfollowDueAt).toBe(T0 + 1000);
  // No Instagram traffic whatsoever from the timer step.
  expect(actions.followCalls).toEqual([]);
  expect(actions.unfollowCalls).toEqual([]);
});

test('nextDue prefers unfollow_queued over queued when both exist', () => {
  const { store, clock, sched } = makeHarness();
  store.upsertFollowRecord(rec({ accountPk: 'q1', state: 'queued' }));
  store.upsertFollowRecord(rec({ accountPk: 'u1', state: 'unfollow_queued', unfollowDueAt: T0 }));

  const due = sched.nextDue(clock.now());
  expect(due?.accountPk).toBe('u1');
  expect(due?.state).toBe('unfollow_queued');
});

test('nextDue orders unfollow_queued by unfollowDueAt then accountPk', () => {
  const { store, clock, sched } = makeHarness();
  // Two share the earliest due time → accountPk breaks the tie ('a' < 'b').
  store.upsertFollowRecord(rec({ accountPk: 'b', state: 'unfollow_queued', unfollowDueAt: T0 + 10 }));
  store.upsertFollowRecord(rec({ accountPk: 'a', state: 'unfollow_queued', unfollowDueAt: T0 + 10 }));
  store.upsertFollowRecord(rec({ accountPk: 'z', state: 'unfollow_queued', unfollowDueAt: T0 + 5 }));

  // Earliest unfollowDueAt wins regardless of pk order.
  expect(sched.nextDue(clock.now())?.accountPk).toBe('z');
});

test('nextDue with no scores falls back to accountPk order; null when nothing actionable', () => {
  const { store, clock, sched } = makeHarness();
  expect(sched.nextDue(clock.now())).toBeNull();

  store.upsertFollowRecord(rec({ accountPk: 'm', state: 'queued' }));
  store.upsertFollowRecord(rec({ accountPk: 'a', state: 'queued' }));
  // Non-actionable states are ignored entirely.
  store.upsertFollowRecord(rec({ accountPk: 'x', state: 'pending_followback', followedAt: T0 }));

  expect(sched.nextDue(clock.now())?.accountPk).toBe('a');
});

test('nextDue follows the BEST-scored queued candidate first, not the lowest pk', () => {
  const { store, clock, sched } = makeHarness();
  // 'z' has the highest score but the highest pk; the old pk-order code would
  // have picked 'a' (a mediocre 1:1/low-mutual account). Score must win.
  store.upsertFollowRecord(rec({ accountPk: 'a', state: 'queued', score: 0.4 }));
  store.upsertFollowRecord(rec({ accountPk: 'b', state: 'queued', score: 1.9 }));
  store.upsertFollowRecord(rec({ accountPk: 'z', state: 'queued', score: 2.3 }));

  expect(sched.nextDue(clock.now())?.accountPk).toBe('z');
});

test('nextDue tie-breaks equal scores by accountPk (deterministic)', () => {
  const { store, clock, sched } = makeHarness();
  store.upsertFollowRecord(rec({ accountPk: 'n', state: 'queued', score: 1.0 }));
  store.upsertFollowRecord(rec({ accountPk: 'c', state: 'queued', score: 1.0 }));
  expect(sched.nextDue(clock.now())?.accountPk).toBe('c');
});

test('a scored queued record survives its follow → pending_followback transition', async () => {
  const { store, sched } = makeHarness();
  seedUsername(store, '9', 'user9');
  store.upsertFollowRecord(rec({ accountPk: '9', state: 'queued', score: 1.75 }));

  await sched.tick(); // queued → pending_followback

  const got = store.getFollowRecord('9')!;
  expect(got.state).toBe('pending_followback');
  expect(got.score).toBe(1.75); // the score is preserved across the transition
});

test('execute performs exactly ONE action and transitions only that record', async () => {
  const { store, clock, actions, sched } = makeHarness({ ownPk: OWN });
  seedUsername(store, 'a', 'usera');
  seedUsername(store, 'b', 'userb');
  store.upsertFollowRecord(rec({ accountPk: 'a', state: 'queued' }));
  store.upsertFollowRecord(rec({ accountPk: 'b', state: 'queued' }));

  const due = sched.nextDue(clock.now())!;
  await sched.execute(due, clock.now());

  // One action, on exactly the one due record; the other is untouched.
  expect(actions.followCalls).toEqual(['usera']);
  expect(store.getFollowRecord('a')!.state).toBe('pending_followback');
  expect(store.getFollowRecord('a')!.followedAt).toBe(T0);
  expect(store.getFollowRecord('b')!.state).toBe('queued');
});

test('execute is a no-op (no action) on a non-actionable record', async () => {
  const { store, clock, actions, sched } = makeHarness();
  const held = rec({ accountPk: 'h', state: 'followed_back', followedBackAt: T0, holdUntil: T0 + 999 });
  store.upsertFollowRecord(held);

  await sched.execute(held, clock.now());

  expect(actions.followCalls).toEqual([]);
  expect(actions.unfollowCalls).toEqual([]);
  expect(store.getFollowRecord('h')!.state).toBe('followed_back');
});

// ── R4: blocked ≠ failed ────────────────────────────────────────────────────────

test('R4: a BLOCKED follow leaves the record’s state/retryCount UNCHANGED and writes NO ledger row', async () => {
  const { store, actions, sched } = makeHarness({ ownPk: OWN });
  seedUsername(store, 'b1', 'userb1');
  actions.followStatus = 'blocked';
  store.upsertFollowRecord(rec({ accountPk: 'b1', state: 'queued', retryCount: 1 }));

  await sched.tick();

  expect(actions.followCalls).toEqual(['userb1']);
  const got = store.getFollowRecord('b1')!;
  expect(got.state).toBe('queued'); // untouched
  expect(got.retryCount).toBe(1); // NOT bumped
  expect(got.followedAt).toBeUndefined();
  expect(store.actionCountSince(0)).toBe(0); // no ledger row
  expect(store.getEdge(OWN, 'b1', 'follows')).toBeNull(); // no edge
});

test('R4: a BLOCKED unfollow leaves the record and its active edge UNTOUCHED', async () => {
  const { store, clock, actions, sched } = makeHarness({ ownPk: OWN });
  seedUsername(store, 'b2', 'userb2');
  store.observeEdge(OWN, 'b2', 'follows', true, T0);
  actions.unfollowStatus = 'blocked';
  store.upsertFollowRecord(
    rec({ accountPk: 'b2', state: 'unfollow_queued', unfollowDueAt: T0, retryCount: 2 }),
  );

  const due = sched.nextDue(clock.now())!;
  await sched.execute(due, clock.now());

  expect(actions.unfollowCalls).toEqual(['userb2']);
  const got = store.getFollowRecord('b2')!;
  expect(got.state).toBe('unfollow_queued'); // untouched
  expect(got.retryCount).toBe(2); // NOT bumped
  expect(store.actionCountSince(0)).toBe(0); // no ledger row
  expect(store.getEdge(OWN, 'b2', 'follows')?.status).toBe('active'); // edge intact
});

// ── f12: dry-run advances state but writes no real edge/ledger ────────────────────

test('f12: a SIMULATED follow transitions state but writes NO active edge and NO ledger row', async () => {
  const { store, actions, sched } = makeHarness({ ownPk: OWN });
  seedUsername(store, 's1', 'users1');
  actions.followStatus = 'simulated';
  store.upsertFollowRecord(rec({ accountPk: 's1', state: 'queued' }));

  await sched.tick();

  const got = store.getFollowRecord('s1')!;
  expect(got.state).toBe('pending_followback'); // lifecycle advanced
  expect(got.followedAt).toBe(T0);
  expect(store.getEdge(OWN, 's1', 'follows')).toBeNull(); // NO fake follow edge
  expect(store.actionCountSince(0)).toBe(0); // NO ledger row
});

test('f12: a SIMULATED unfollow transitions to unfollowed but leaves any edge/ledger alone', async () => {
  const { store, clock, actions, sched } = makeHarness({ ownPk: OWN });
  seedUsername(store, 's2', 'users2');
  actions.unfollowStatus = 'simulated';
  store.upsertFollowRecord(rec({ accountPk: 's2', state: 'unfollow_queued', unfollowDueAt: T0 }));

  const due = sched.nextDue(clock.now())!;
  await sched.execute(due, clock.now());

  expect(store.getFollowRecord('s2')!.state).toBe('unfollowed'); // lifecycle advanced
  expect(store.getEdge(OWN, 's2', 'follows')).toBeNull(); // no edge written
  expect(store.actionCountSince(0)).toBe(0); // no ledger row
});

// ── Phase A: ok + alreadyInState = an external actor owns the relationship ────────

test('Phase A: follow ok+alreadyInState drops the record to external with NO ledger/pending', async () => {
  const { store, actions, sched } = makeHarness({ ownPk: OWN });
  store.setOwnPk(OWN); // the reconciliation sink anchors edges on the store-side own pk
  seedUsername(store, 'e1', 'usere1');
  actions.followAlreadyInState = true;
  store.upsertFollowRecord(rec({ accountPk: 'e1', state: 'queued' }));

  await sched.tick();

  expect(actions.followCalls).toEqual(['usere1']);
  const got = store.getFollowRecord('e1')!;
  expect(got.state).toBe('external'); // dropped, NOT pending_followback
  expect(got.followedAt).toBeUndefined();
  expect(store.actionCountSince(0)).toBe(0); // no ledger row — not our action
  expect(store.getEdge(OWN, 'e1', 'follows')?.status).toBe('active'); // truth recorded
  expect(store.getAccount('e1')!.role).toBe('skipped'); // out of the pool for good
});

test('Phase A: unfollow ok+alreadyInState reconciles to unfollowed with NO ledger', async () => {
  const { store, clock, actions, sched } = makeHarness({ ownPk: OWN });
  store.setOwnPk(OWN);
  seedUsername(store, 'e2', 'usere2');
  store.observeEdge(OWN, 'e2', 'follows', true, T0); // we believed we still followed them
  actions.unfollowAlreadyInState = true;
  store.upsertFollowRecord(rec({ accountPk: 'e2', state: 'unfollow_queued', unfollowDueAt: T0 }));

  const due = sched.nextDue(clock.now())!;
  await sched.execute(due, clock.now());

  expect(actions.unfollowCalls).toEqual(['usere2']);
  expect(store.getFollowRecord('e2')!.state).toBe('unfollowed');
  expect(store.actionCountSince(0)).toBe(0); // no ledger row — the external actor unfollowed
  expect(store.getEdge(OWN, 'e2', 'follows')?.status).toBe('removed'); // truth recorded
});

test('advanceTimers + nextDue + execute matches the old tick end-state (hold → unfollowed)', async () => {
  const { store, clock, actions, sched } = makeHarness({ ownPk: OWN });
  seedUsername(store, 'r', 'userr');
  store.observeEdge(OWN, 'r', 'follows', true, T0); // we currently follow them
  store.upsertFollowRecord(
    rec({ accountPk: 'r', state: 'followed_back', followedBackAt: T0, holdUntil: T0 + 500 }),
  );

  clock.advance(500); // now === holdUntil
  // Explicit Engine-style sequence.
  sched.advanceTimers(clock.now());
  const due = sched.nextDue(clock.now())!;
  await sched.execute(due, clock.now());

  // Same end-state the single-pass tick used to produce: unfollowed + edge removed.
  expect(actions.unfollowCalls).toEqual(['userr']);
  expect(store.getFollowRecord('r')!.state).toBe('unfollowed');
  expect(store.getEdge(OWN, 'r', 'follows')?.status).toBe('removed');
});

// --- Consecutive-failure counter (the engine's systemic-breakage signal) -----------

test('consecutive failures accumulate ACROSS records and reset on a verified success', async () => {
  const { store, clock, actions, sched } = makeHarness();
  for (const pk of ['f1', 'f2', 'f3']) {
    seedUsername(store, pk, `user${pk}`);
    store.upsertFollowRecord(rec({ accountPk: pk }));
  }

  actions.followOk = false;
  await sched.execute(sched.nextDue(clock.now())!, clock.now());
  await sched.execute(sched.nextDue(clock.now())!, clock.now());
  expect(sched.consecutiveFailureCount()).toBe(2);

  // A verified success anywhere clears the window — the machinery works.
  actions.followOk = true;
  await sched.execute(sched.nextDue(clock.now())!, clock.now());
  expect(sched.consecutiveFailureCount()).toBe(0);
});

test('blocked outcomes are NEUTRAL for the failure window (nothing was clicked)', async () => {
  const { store, clock, actions, sched } = makeHarness();
  seedUsername(store, 'b1', 'userb1');
  store.upsertFollowRecord(rec({ accountPk: 'b1' }));

  actions.followOk = false;
  await sched.execute(sched.nextDue(clock.now())!, clock.now());
  expect(sched.consecutiveFailureCount()).toBe(1);

  // A sentinel block neither adds a failure nor forgives the streak.
  actions.followStatus = 'blocked';
  await sched.execute(sched.nextDue(clock.now())!, clock.now());
  expect(sched.consecutiveFailureCount()).toBe(1);

  sched.resetConsecutiveFailures();
  expect(sched.consecutiveFailureCount()).toBe(0);
});

// --- Recovery-ladder plumbing: outcome returns + blocked/drift windows -------------

test('execute RETURNS the attempt outcome status (ok / failed / blocked / simulated)', async () => {
  const { store, clock, actions, sched } = makeHarness();
  for (const pk of ['r1', 'r2', 'r3', 'r4']) {
    seedUsername(store, pk, `user${pk}`);
  }
  store.upsertFollowRecord(rec({ accountPk: 'r1' }));
  await expect(sched.execute(sched.nextDue(clock.now())!, clock.now())).resolves.toBe('ok');

  store.upsertFollowRecord(rec({ accountPk: 'r2' }));
  actions.followStatus = 'failed';
  await expect(sched.execute(sched.nextDue(clock.now())!, clock.now())).resolves.toBe('failed');

  store.upsertFollowRecord(rec({ accountPk: 'r3' }));
  actions.followStatus = 'blocked';
  await expect(sched.execute(sched.nextDue(clock.now())!, clock.now())).resolves.toBe('blocked');

  actions.followStatus = 'simulated';
  await expect(sched.execute(sched.nextDue(clock.now())!, clock.now())).resolves.toBe('simulated');
});

test("execute returns 'noop' when nothing touched Instagram (no username / non-actionable)", async () => {
  const { store, clock, actions, sched } = makeHarness();
  // A due record whose account has no username: the retry burns store-side.
  store.upsertFollowRecord(rec({ accountPk: 'nn' }));
  await expect(sched.execute(sched.nextDue(clock.now())!, clock.now())).resolves.toBe('noop');
  expect(actions.followCalls).toEqual([]);

  // A non-actionable state is a warned no-op.
  const held = rec({ accountPk: 'h', state: 'followed_back', followedBackAt: T0, holdUntil: T0 + 999 });
  store.upsertFollowRecord(held);
  await expect(sched.execute(held, clock.now())).resolves.toBe('noop');
});

test('consecutiveBlockedCount counts blocked outcomes across records and resets on a verified success', async () => {
  const { store, clock, actions, sched } = makeHarness();
  for (const pk of ['b1', 'b2', 'b3']) {
    seedUsername(store, pk, `user${pk}`);
    store.upsertFollowRecord(rec({ accountPk: pk }));
  }

  actions.followStatus = 'blocked';
  await sched.execute(sched.nextDue(clock.now())!, clock.now());
  await sched.execute(sched.nextDue(clock.now())!, clock.now());
  expect(sched.consecutiveBlockedCount()).toBe(2);

  // A verified success clears the blocked window.
  actions.followStatus = undefined;
  await sched.execute(sched.nextDue(clock.now())!, clock.now());
  expect(sched.consecutiveBlockedCount()).toBe(0);

  // The explicit reset (used at ladder entry) also clears it.
  actions.followStatus = 'blocked';
  await sched.execute(sched.nextDue(clock.now())!, clock.now());
  expect(sched.consecutiveBlockedCount()).toBe(1);
  sched.resetConsecutiveBlocked();
  expect(sched.consecutiveBlockedCount()).toBe(0);
});

test('drift-caused fails are tallied inside the failure window and reset with it', async () => {
  const { store, clock, actions, sched } = makeHarness();
  for (const pk of ['d1', 'd2', 'd3']) {
    seedUsername(store, pk, `user${pk}`);
    store.upsertFollowRecord(rec({ accountPk: pk }));
  }

  actions.followStatus = 'failed';
  actions.followCause = 'drift';
  await sched.execute(sched.nextDue(clock.now())!, clock.now());
  await sched.execute(sched.nextDue(clock.now())!, clock.now());
  expect(sched.consecutiveFailureCount()).toBe(2);
  expect(sched.consecutiveDriftFailureCount()).toBe(2);

  sched.resetConsecutiveFailures();
  expect(sched.consecutiveDriftFailureCount()).toBe(0);
});

test('a tab-unhealthy blocked outcome is record-NEUTRAL: no retry burned, no fail row', async () => {
  const { store, clock, actions, sched } = makeHarness({ ownPk: OWN });
  seedUsername(store, 't1', 'usert1');
  store.upsertFollowRecord(rec({ accountPk: 't1', retryCount: 1 }));

  actions.followStatus = 'blocked';
  actions.followCause = 'tab-unhealthy';
  await expect(sched.execute(sched.nextDue(clock.now())!, clock.now())).resolves.toBe('blocked');

  const got = store.getFollowRecord('t1')!;
  expect(got.state).toBe('queued'); // untouched
  expect(got.retryCount).toBe(1); // NOT bumped
  expect(store.actionCountSince(0)).toBe(0); // no ledger row
  expect(sched.consecutiveFailureCount()).toBe(0); // never a record failure
});

// --- Amendment C: post-click tab failure → re-observe before re-claiming -----------

test('amendment C: an unverified post-click follow is claimed as OURS on the next already-in-state attempt', async () => {
  const { store, clock, actions, sched } = makeHarness({ ownPk: OWN });
  store.setOwnPk(OWN);
  seedUsername(store, 'uv', 'useruv');
  store.upsertFollowRecord(rec({ accountPk: 'uv', state: 'queued' }));

  // Attempt 1: the click was dispatched, then the tab stalled before verification.
  actions.followStatus = 'blocked';
  actions.followCause = 'tab-unhealthy';
  actions.followUnverifiedClick = true;
  await expect(sched.execute(sched.nextDue(clock.now())!, clock.now())).resolves.toBe('blocked');
  expect(store.getFollowRecord('uv')!.state).toBe('queued'); // untouched
  expect(store.actionCountSince(0)).toBe(0);

  // Attempt 2: the pre-check reads already-following — that is OUR landed click.
  actions.followStatus = undefined;
  actions.followCause = undefined;
  actions.followUnverifiedClick = undefined;
  actions.followAlreadyInState = true;
  await expect(sched.execute(sched.nextDue(clock.now())!, clock.now())).resolves.toBe('ok');

  const got = store.getFollowRecord('uv')!;
  expect(got.state).toBe('pending_followback'); // recorded as ours, NOT external
  expect(got.followedAt).toBe(T0);
  expect(store.actionCountSince(0)).toBe(1); // the ledger row was written
  expect(store.getEdge(OWN, 'uv', 'follows')?.status).toBe('active');
});

test('amendment C: an unverified post-click unfollow is claimed as OURS when already-not-following', async () => {
  const { store, clock, actions, sched } = makeHarness({ ownPk: OWN });
  store.setOwnPk(OWN);
  seedUsername(store, 'uw', 'useruw');
  store.observeEdge(OWN, 'uw', 'follows', true, T0);
  store.upsertFollowRecord(rec({ accountPk: 'uw', state: 'unfollow_queued', unfollowDueAt: T0 }));

  actions.unfollowStatus = 'blocked';
  actions.unfollowCause = 'tab-unhealthy';
  actions.unfollowUnverifiedClick = true;
  await expect(sched.execute(sched.nextDue(clock.now())!, clock.now())).resolves.toBe('blocked');
  expect(store.getFollowRecord('uw')!.state).toBe('unfollow_queued'); // untouched

  actions.unfollowStatus = undefined;
  actions.unfollowCause = undefined;
  actions.unfollowUnverifiedClick = undefined;
  actions.unfollowAlreadyInState = true;
  await expect(sched.execute(sched.nextDue(clock.now())!, clock.now())).resolves.toBe('ok');

  expect(store.getFollowRecord('uw')!.state).toBe('unfollowed');
  expect(store.actionCountSince(0)).toBe(1); // ours: ledger row written
  expect(store.getEdge(OWN, 'uw', 'follows')?.status).toBe('removed');
});

test('amendment C: WITHOUT the marker, already-in-state stays the external leave-alone (no ledger)', async () => {
  const { store, clock, actions, sched } = makeHarness({ ownPk: OWN });
  store.setOwnPk(OWN);
  seedUsername(store, 'ex', 'userex');
  store.upsertFollowRecord(rec({ accountPk: 'ex', state: 'queued' }));

  actions.followAlreadyInState = true;
  await sched.execute(sched.nextDue(clock.now())!, clock.now());

  expect(store.getFollowRecord('ex')!.state).toBe('external'); // Phase A unchanged
  expect(store.actionCountSince(0)).toBe(0);
});

test('amendment C: a definitive FAILED attempt clears the marker (the click did not land)', async () => {
  const { store, clock, actions, sched } = makeHarness({ ownPk: OWN });
  store.setOwnPk(OWN);
  seedUsername(store, 'fm', 'userfm');
  store.upsertFollowRecord(rec({ accountPk: 'fm', state: 'queued' }));

  actions.followStatus = 'blocked';
  actions.followCause = 'tab-unhealthy';
  actions.followUnverifiedClick = true;
  await sched.execute(sched.nextDue(clock.now())!, clock.now());

  // A later verified FAILURE proves the earlier click never landed.
  actions.followStatus = 'failed';
  actions.followCause = undefined;
  actions.followUnverifiedClick = undefined;
  await sched.execute(sched.nextDue(clock.now())!, clock.now());

  // A subsequent already-in-state is external again (the marker is gone).
  actions.followStatus = undefined;
  actions.followAlreadyInState = true;
  await sched.execute(sched.nextDue(clock.now())!, clock.now());
  expect(store.getFollowRecord('fm')!.state).toBe('external');
  expect(store.actionCountSince(0)).toBe(1); // only the failed attempt's row
});

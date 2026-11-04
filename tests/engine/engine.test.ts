/**
 * Engine runtime tests (the loop's precedence, interruptible waits, halt/status).
 *
 * Real `:memory:` KnowledgeStore + real governors beneath a FakeClock; the shared
 * engine kit supplies every fake port and the one fake-time contract (a sleep
 * advances the clock unless deliberately hung). A shared `events` log proves
 * ordering — most importantly that the loop can NEVER perform two actions
 * without an interposed paced delay.
 */

import type { ChurnActionOutcome } from '@/engine/churn-scheduler';
import {
  ACTIONS_FAILING_HALT,
  ENRICH_BATCH_SIZE,
  Engine,
  type EngineUnfollowFeed,
  MAX_ENRICH_PASSES_PER_CYCLE,
} from '@/engine/engine';
import { FakeClock } from '@/governors/clock';
import { referenceTempoSource } from '@/kernel/tempo';
import type { AccountFields, FollowRecord } from '@/store/types';
import { ENGINE, NOISE, RECOVERY } from '@/timing/config';
import { DelayManager } from '@/timing/delay-manager';
import {
  DELAY_MS,
  FakeChurn,
  FakeSentinel,
  type EngineHarness as Harness,
  HOUR,
  makeEngineHarness as makeHarness,
  rec,
  T0,
  testDeps,
} from '../kit/engine-harness';
import { FakePlan as FakePacing } from '../kit/harness-plan';
import { fixedTempo } from '../kit/tempo';

// --- Tests ---------------------------------------------------------------------------

/** The idle beat's bound: the `beat.transient` base at the reference tempo (today's 30 s). */
const ENGINE_IDLE_MS = referenceTempoSource().base('beat.transient');

describe('Engine.stepOnce — one major thing per iteration', () => {
  test("an 'acted' step executes exactly ONE churn action then sleeps nextDelayMs", async () => {
    const h = makeHarness();
    h.churn.due = [rec({ accountPk: 'a' }), rec({ accountPk: 'b' })];

    const result = await h.engine.stepOnce();

    expect(result).toBe('acted');
    expect(h.churn.executed.map((r) => r.accountPk)).toEqual(['a']); // ONE action only
    expect(h.sleep.calls).toEqual([DELAY_MS]); // the fake sleep saw THE paced delay
    expect(h.events).toEqual(['execute:a', `sleep:${DELAY_MS}`]); // delay AFTER the action
    // Nothing else happened in this step:
    expect(h.followback.checks).toBe(0);
    expect(h.acquisition.calls).toEqual([]);
    expect(h.chain.advanceCalls).toEqual([]);
  });

  test('the loop CANNOT act twice without an interposed delay', async () => {
    const h = makeHarness();
    h.churn.due = [rec({ accountPk: 'a' }), rec({ accountPk: 'b' })];

    expect(await h.engine.stepOnce()).toBe('acted');
    expect(await h.engine.stepOnce()).toBe('acted');

    // Strict alternation: every execute is immediately followed by a delay sleep.
    expect(h.events).toEqual([
      'execute:a',
      `sleep:${DELAY_MS}`,
      'execute:b',
      `sleep:${DELAY_MS}`,
    ]);
  });

  test('a failing streak at the cold breaker routes to a recovery HOLD, not a terminal halt', async () => {
    const h = makeHarness();
    h.churn.due = [rec({ accountPk: 'a' })];
    h.churn.outcome = 'failed';
    h.churn.failStreak = ACTIONS_FAILING_HALT - 1; // one below the breaker → keeps going
    expect(await h.engine.stepOnce()).toBe('acted');

    h.churn.due = [rec({ accountPk: 'b' })];
    h.churn.failStreak = ACTIONS_FAILING_HALT; // the D5 cold threshold (7) → enter the recovery ladder
    expect(await h.engine.stepOnce()).toBe('recovering');
    expect(h.halts).toEqual([]); // no terminal halt
    expect(h.engine.status().state).not.toBe('halted');
    // Both streak windows were cleared so each rung burns a fresh window.
    expect(h.churn.resetCalls).toBe(1);
    expect(h.churn.resetBlockedCalls).toBe(1);
    // The hold was drawn within rung 1's clamp band and served (fake sleep).
    const hold = h.sleep.calls[h.sleep.calls.length - 1];
    expect(hold).toBeGreaterThanOrEqual(RECOVERY.HOLD_MIN_FACTOR * RECOVERY.HOLD_MEDIANS_MS[0]);
    expect(hold).toBeLessThanOrEqual(RECOVERY.HOLD_MAX_FACTOR * RECOVERY.HOLD_MEDIANS_MS[0]);
    // Mid-hold the status carried the recovery park; served → probing.
    expect(h.statuses.some((s) => s.parkReason === 'recovery')).toBe(true);
    expect(h.engine.status().recovery).toEqual({
      phase: 'probing',
      attempt: 1,
      maxAttempts: RECOVERY.MAX_HOLDS,
      resumeAt: null,
    });
  });

  test('emits onStatus after every step, carrying lastStep', async () => {
    const h = makeHarness();
    h.churn.due = [rec({ accountPk: 'a' })];
    await h.engine.stepOnce();
    await h.engine.stepOnce();
    // Three emissions: one DURING the action-delay wait (real nextActionAt for
    // the renderer countdown), then the post-step emission of each step.
    expect(h.statuses.length).toBe(3);
    expect(h.statuses[0].lastStep).toBeNull(); // mid-wait: the step hasn't returned
    expect(h.statuses[0].nextActionAt).toBe(T0 + DELAY_MS);
    expect(h.statuses[1].lastStep).toBe('acted');
    expect(h.statuses[2].lastStep).toBe('idle');
    expect(h.statuses[1].lastSentinel).toBe('ok');
    expect(h.statuses[1].lastActionAt).toBe(T0);
  });
});

describe('Engine — sentinel gate (precedence 2)', () => {
  test('an action-blocked sentinel enters RECOVERY (hold), not a terminal halt', async () => {
    const h = makeHarness({ sentinel: ['action-blocked'] });
    h.churn.due = [rec({ accountPk: 'a' })];

    const result = await h.engine.stepOnce();

    expect(result).toBe('recovering');
    expect(h.halts).toEqual([]); // no longer terminal
    expect(h.churn.executed).toEqual([]); // no action past the block
    expect(h.engine.status().state).not.toBe('halted');
    expect(h.engine.status().lastSentinel).toBe('action-blocked');
    // Exactly one wait was served: rung 1's hold, within its clamp band.
    expect(h.sleep.calls.length).toBe(1);
    expect(h.sleep.calls[0]).toBeGreaterThanOrEqual(
      RECOVERY.HOLD_MIN_FACTOR * RECOVERY.HOLD_MEDIANS_MS[0],
    );
    expect(h.sleep.calls[0]).toBeLessThanOrEqual(
      RECOVERY.HOLD_MAX_FACTOR * RECOVERY.HOLD_MEDIANS_MS[0],
    );
    expect(h.engine.status().recovery?.phase).toBe('probing');
  });

  test('an AUTH sentinel state (challenge) stays terminal and refuses further steps', async () => {
    const h = makeHarness({ sentinel: ['challenge'] });
    h.churn.due = [rec({ accountPk: 'a' })];

    expect(await h.engine.stepOnce()).toBe('halted');
    expect(h.halts).toEqual(['sentinel:challenge']);
    expect(h.churn.executed).toEqual([]);
    expect(h.sleep.calls).toEqual([]);
    expect(h.engine.status().state).toBe('halted');

    // A halted engine refuses further steps.
    expect(await h.engine.stepOnce()).toBe('aborted');
    expect(h.churn.executed).toEqual([]);
  });
});

describe('Engine — the plan\'s session and ceiling gates (precedence 3–4)', () => {
  test('between sessions: waits exactly until the next session opens, no action', async () => {
    const pacing = new FakePacing(T0 + 6 * HOUR);
    pacing.open = false;
    const h = makeHarness({ pacing });
    h.churn.due = [rec({ accountPk: 'a' })];

    const result = await h.engine.stepOnce();

    expect(result).toBe('waited-session');
    // The plan's park is exact (spec §5.16): no jitter, the next session's start.
    expect(h.sleep.calls).toEqual([6 * HOUR]);
    expect(h.churn.executed).toEqual([]);
    expect(h.churn.advanceCalls).toBe(0); // gate fires before timers

    // The session opened while the loop slept: the next step acts.
    pacing.open = true;
    expect(await h.engine.stepOnce()).toBe('acted');
  });

  test("at the hard ceiling: waits exactly to the plan-day's boundary, no action", async () => {
    const pacing = new FakePacing(T0 + HOUR);
    const h = makeHarness({ ceiling: 2, pacing });
    h.store.recordAction('x', 'follow', 'ok', T0 - HOUR);
    h.store.recordAction('y', 'follow', 'ok', T0 - HOUR / 2);
    h.churn.due = [rec({ accountPk: 'a' })];

    const result = await h.engine.stepOnce();

    expect(result).toBe('waited-ceiling');
    expect(h.sleep.calls).toEqual([pacing.view(T0).window.endsAt - T0]);
    expect(h.churn.executed).toEqual([]);
  });
});

describe('Engine — long parks surface parkedUntil/parkReason (§2 live status)', () => {
  test('a fresh start between sessions pushes the park BEFORE it elapses', async () => {
    const pacing = new FakePacing(T0 + 9 * HOUR);
    pacing.open = false;
    const h = makeHarness({ pacing });
    h.sleep.hang = true; // the session park blocks until aborted

    const started = h.engine.start();
    await new Promise((r) => setTimeout(r, 0)); // let the loop reach the park

    // The projection pushed AT REGISTRATION carries the hold: reason + real
    // deadline, while lastStep is still null (the park has NOT completed) —
    // without these fields this state was indistinguishable from a dead run.
    const pushed = h.statuses[h.statuses.length - 1];
    expect(pushed.state).toBe('running');
    expect(pushed.parkReason).toBe('session');
    expect(pushed.parkedUntil).toBe(T0 + 9 * HOUR);
    expect(pushed.lastStep).toBeNull();
    expect(h.engine.status().parkReason).toBe('session');

    h.engine.stop();
    await started;
    // The hold dies with the run: nothing advertises a stale park.
    expect(h.engine.status().parkReason).toBeNull();
    expect(h.engine.status().parkedUntil).toBeNull();
  });

  test('the park clears once the wait elapses (resume shows unparked)', async () => {
    const pacing = new FakePacing(T0 + 6 * HOUR);
    pacing.open = false;
    const h = makeHarness({ pacing });

    const result = await h.engine.stepOnce(); // the fake sleep advances through the park

    expect(result).toBe('waited-session');
    // A mid-park push carried the hold with its exact deadline...
    const mid = h.statuses.find((s) => s.parkReason === 'session');
    expect(mid?.parkedUntil).toBe(T0 + 6 * HOUR);
    // ...and the post-step push (and the live read) show it cleared.
    const last = h.statuses[h.statuses.length - 1];
    expect(last.parkReason).toBeNull();
    expect(last.parkedUntil).toBeNull();
    expect(last.lastStep).toBe('waited-session');
    expect(h.engine.status().parkReason).toBeNull();
  });

  test('an organic session park surfaces reason "session" with the next session start', async () => {
    const pacing = new FakePacing(T0 + HOUR);
    pacing.open = false;
    const h = makeHarness({ pacing });
    h.sleep.hang = true;

    const stepping = h.engine.stepOnce();
    await new Promise((r) => setTimeout(r, 0));

    const st = h.engine.status();
    expect(st.parkReason).toBe('session');
    expect(st.parkedUntil).toBe(T0 + HOUR);

    h.engine.stop();
    expect(await stepping).toBe('waited-session');
    expect(h.engine.status().parkReason).toBeNull();
  });

  test('a daily-ceiling park surfaces reason "daily-ceiling" until the plan-day boundary, exactly', async () => {
    const pacing = new FakePacing(T0 + HOUR);
    const h = makeHarness({ ceiling: 2, pacing });
    h.store.recordAction('x', 'follow', 'ok', T0 - HOUR);
    h.store.recordAction('y', 'follow', 'ok', T0 - HOUR / 2);
    h.churn.due = [rec({ accountPk: 'a' })];
    h.sleep.hang = true;

    const stepping = h.engine.stepOnce();
    await new Promise((r) => setTimeout(r, 0));

    expect(h.engine.status().parkReason).toBe('daily-ceiling');
    // The plan's park is exact (spec §5.16): the plan-day boundary, no jitter.
    expect(h.engine.status().parkedUntil).toBe(pacing.view(T0).window.endsAt);

    h.engine.stop();
    expect(await stepping).toBe('waited-ceiling');
  });

  test('short operational waits (idle beat) do NOT read as parks', async () => {
    const h = makeHarness(); // nothing due → the step ends in the idle sleep
    expect(await h.engine.stepOnce()).toBe('idle');
    expect(h.statuses.every((s) => s.parkReason == null)).toBe(true);
    expect(h.engine.status().parkReason).toBeNull();
    expect(h.engine.status().parkedUntil).toBeNull();
  });
});

describe('Engine — follow-back sweep cadence (precedence 6)', () => {
  test('sweeps when due, then not again until the cadence elapses', async () => {
    const h = makeHarness({ settings: { followbackSweepHours: 4 } });

    // Fresh engine: catch-up sweep on the first eligible step.
    expect(await h.engine.stepOnce()).toBe('swept-followback');
    expect(h.followback.checks).toBe(1);

    // Immediately after: not due — the step falls through to idle.
    expect(await h.engine.stepOnce()).toBe('idle');
    expect(h.followback.checks).toBe(1);

    // Drive the FakeClock well past the cadence: due again.
    h.clock.advance(2 * 4 * HOUR);
    expect(await h.engine.stepOnce()).toBe('swept-followback');
    expect(h.followback.checks).toBe(2);
  });

  test('the sweep is the step’s ONE thing: a due action waits for the next step', async () => {
    const h = makeHarness({ settings: { followbackSweepHours: 4 } });
    h.churn.due = [rec({ accountPk: 'a' })];

    expect(await h.engine.stepOnce()).toBe('swept-followback');
    expect(h.churn.executed).toEqual([]);
    expect(await h.engine.stepOnce()).toBe('acted');
  });
});

describe('Engine — pool refill (precedence 7) and the acquisition guard', () => {
  test("pool low triggers acquire then planTarget — and outranks a due action", async () => {
    const h = makeHarness({ settings: { lowWaterCandidates: 5 } });
    h.acquisition.script = [{ observed: 10, targetPk: 't1' }];
    h.scanner.script = [['c1', 'c2']];
    h.churn.due = [rec({ accountPk: 'a' })];

    const result = await h.engine.stepOnce();

    expect(result).toBe('acquired');
    expect(h.acquisition.calls).toEqual(['targetone']); // scraped by username
    expect(h.scanner.planCalls).toEqual(['t1']); // then ranked + enqueued
    expect(h.churn.executed).toEqual([]); // refill was the ONE thing
    expect(h.engine.status().queued).toBe(2);
  });

  test('a dry target is acquired once, then the chain advances (no infinite re-acquire)', async () => {
    const h = makeHarness({ settings: { lowWaterCandidates: 5 } });
    h.store.observe({
      accountPk: 't2',
      observedAt: T0,
      source: 'profile',
      fields: { username: 'targettwo' },
    });
    h.chain.script = [{ nextTargetPk: 't2', source: 'own_followers', reason: 'fallback' }];

    // Step 1: pool empty → acquire; nothing observed, nothing enqueued (guard sets).
    expect(await h.engine.stepOnce()).toBe('acquired');
    expect(h.acquisition.calls).toEqual(['targetone']);

    // Step 2: still dry, guard set → exhausted → chain advances; NO re-acquire.
    expect(await h.engine.stepOnce()).toBe('advanced-chain');
    expect(h.acquisition.calls).toEqual(['targetone']);
    expect(h.chain.advanceCalls).toEqual(['t1']);
    expect(h.engine.status().currentTargetPk).toBe('t2');
    expect(h.engine.status().currentTargetUsername).toBe('targettwo');

    // Step 3: the guard reset on adoption → the NEW target gets its refill.
    expect(await h.engine.stepOnce()).toBe('acquired');
    expect(h.acquisition.calls).toEqual(['targetone', 'targettwo']);
  });

  test('chain returning no next target halts with chain-exhausted', async () => {
    const h = makeHarness({ settings: { lowWaterCandidates: 5 } });
    h.chain.script = [{ nextTargetPk: null, source: 'none', reason: 'no-target-available' }];

    expect(await h.engine.stepOnce()).toBe('acquired'); // dry acquire, guard set
    expect(await h.engine.stepOnce()).toBe('halted');
    expect(h.halts).toEqual(['chain-exhausted']);
    expect(h.engine.status().state).toBe('halted');
  });
});

// --- Exhaustion latches only on positive evidence (chain-burn fix) --------------------

describe('Engine — acquire end reasons gate the exhaustion latch', () => {
  test('a FAILED acquire does not latch, keeps the cycle slot, and takes the long backoff park', async () => {
    const h = makeHarness({ settings: { lowWaterCandidates: 5 } });
    h.acquisition.script = [
      { observed: 0, targetPk: 't1', endReason: 'fetch-failed' },
      { observed: 3, targetPk: 't1' }, // the retry after the park reads genuinely
    ];
    h.scanner.script = [['c1', 'c2']];

    // Step 1: the failed read parks LONG — no plan, no latch, no chain advance.
    expect(await h.engine.stepOnce()).toBe('idle');
    expect(h.scanner.planCalls).toEqual([]); // an empty pool was never planned into exhaustion
    expect(h.chain.advanceCalls).toEqual([]);
    expect(h.statuses.some((s) => s.parkReason === 'enrich-backoff')).toBe(true);
    // The park is the noisified long backoff, never the short refill pacing.
    expect(h.sleep.calls.length).toBe(1);
    expect(h.sleep.calls[0]).toBeGreaterThanOrEqual(
      ENGINE.ENRICH_BACKOFF_MS * NOISE.BACKOFF_MIN_FACTOR,
    );
    expect(h.sleep.calls[0]).toBeLessThanOrEqual(
      ENGINE.ENRICH_BACKOFF_MS * NOISE.BACKOFF_MAX_FACTOR,
    );

    // Step 2: the cycle's acquisition slot was NOT pre-consumed — the refill
    // re-acquires, and the genuine read plans normally.
    expect(await h.engine.stepOnce()).toBe('acquired');
    expect(h.acquisition.calls).toEqual(['targetone', 'targetone']);
    expect(h.scanner.planCalls).toEqual(['t1']);
    expect(h.engine.status().queued).toBe(2);
    expect(h.halts).toEqual([]);
  });

  test('repeatedly failing acquires escalate to the recovery ladder, never burn the chain', async () => {
    const h = makeHarness({ settings: { lowWaterCandidates: 5 } });
    h.acquisition.script = [
      { observed: 0, targetPk: 't1', endReason: 'fetch-failed' },
      { observed: 0, targetPk: 't1', endReason: 'sentinel-blocked' },
      { observed: 0, targetPk: 't1', endReason: 'fetch-failed' },
    ];

    expect(await h.engine.stepOnce()).toBe('idle'); // walled 1 — long park
    expect(await h.engine.stepOnce()).toBe('idle'); // walled 2 — long park
    expect(await h.engine.stepOnce()).toBe('recovering'); // walled 3 — the ladder
    expect(h.engine.status().recovery?.phase).toBe('probing'); // hold served by fake sleep
    expect(h.chain.advanceCalls).toEqual([]); // the target was never burned
    expect(h.halts).toEqual([]);
  });

  test("a 'coverage-cap' zero IS positive evidence: the target latches and the chain advances", async () => {
    const h = makeHarness({ settings: { lowWaterCandidates: 5 } });
    h.store.observe({
      accountPk: 't2',
      observedAt: T0,
      source: 'profile',
      fields: { username: 'targettwo' },
    });
    h.acquisition.script = [{ observed: 0, targetPk: 't1', endReason: 'coverage-cap' }];
    h.chain.script = [{ nextTargetPk: 't2', source: 'own_followers', reason: 'fallback' }];

    expect(await h.engine.stepOnce()).toBe('acquired'); // the designed close latches
    expect(await h.engine.stepOnce()).toBe('advanced-chain');
    expect(h.chain.advanceCalls).toEqual(['t1']);
    expect(h.acquisition.calls).toEqual(['targetone']); // never re-scraped past the cap
  });

  test("a slice-bounding zero ('page-budget') does NOT latch: acquisition reopens and continues", async () => {
    const h = makeHarness({ settings: { lowWaterCandidates: 5 } });
    h.store.observe({
      accountPk: 't2',
      observedAt: T0,
      source: 'profile',
      fields: { username: 'targettwo' },
    });
    h.acquisition.script = [
      { observed: 0, targetPk: 't1', endReason: 'page-budget' },
      { observed: 0, targetPk: 't1', endReason: 'no-more-pages' },
    ];
    h.chain.script = [{ nextTargetPk: 't2', source: 'own_followers', reason: 'fallback' }];

    // Step 1: the zero only bounded a slice — no latch, the cycle reopens.
    expect(await h.engine.stepOnce()).toBe('acquired');
    expect(h.chain.advanceCalls).toEqual([]);
    // Step 2: the reopened cycle re-acquires (cursor-resumed) and verifies the end.
    expect(await h.engine.stepOnce()).toBe('acquired');
    expect(h.acquisition.calls).toEqual(['targetone', 'targetone']);
    // Step 3: verified end + drained pool → NOW the chain advances.
    expect(await h.engine.stepOnce()).toBe('advanced-chain');
    expect(h.chain.advanceCalls).toEqual(['t1']);
  });

  test('zero-yield slice reopens park long from the walled threshold on (no hot loop)', async () => {
    const h = makeHarness({ settings: { lowWaterCandidates: 5 } });
    h.acquisition.script = [
      { observed: 0, targetPk: 't1', endReason: 'stagnant' },
      { observed: 0, targetPk: 't1', endReason: 'stagnant' },
      { observed: 0, targetPk: 't1', endReason: 'stagnant' },
    ];

    expect(await h.engine.stepOnce()).toBe('acquired'); // reopen 1 — prompt retry
    expect(await h.engine.stepOnce()).toBe('acquired'); // reopen 2 — prompt retry
    expect(await h.engine.stepOnce()).toBe('idle'); // reopen 3 — long park first
    expect(h.statuses.some((s) => s.parkReason === 'enrich-backoff')).toBe(true);
    expect(h.chain.advanceCalls).toEqual([]); // still never latched or burned
  });
});

describe('Engine — chain dead-end re-verifies a recently exhausted target', () => {
  /** Seed a prior hop `t0` as evidence-stamped exhausted at `at`. */
  const exhaustedHop = (h: Harness, at: number): void => {
    h.store.observe({
      accountPk: 't0',
      observedAt: T0,
      source: 'profile',
      fields: { username: 'targetzero' },
    });
    h.store.addTarget({
      accountPk: 't0',
      source: 'seed',
      status: 'exhausted',
      chainIndex: 0,
      exhaustedAt: at,
    });
  };

  test('a dead-end revives the recent hop instead of halting, then heals on a fresh acquire', async () => {
    const h = makeHarness({ settings: { lowWaterCandidates: 5 } });
    exhaustedHop(h, T0 - HOUR); // stamped during e.g. a rate-wall window
    h.acquisition.script = [
      { observed: 0, targetPk: 't1', endReason: 'no-more-pages' }, // t1 genuinely dry
      { observed: 5, targetPk: 't0', endReason: 'target-reached' }, // t0's re-verify succeeds
    ];
    h.scanner.script = [[], ['c1', 'c2']];
    // The chain has nowhere to go (FakeChain unscripted → null).

    expect(await h.engine.stepOnce()).toBe('acquired'); // t1 latches exhausted
    expect(await h.engine.stepOnce()).toBe('advanced-chain'); // dead-end → t0 revived
    expect(h.halts).toEqual([]);
    expect(h.engine.status().currentTargetPk).toBe('t0');
    expect(h.store.getTarget('t0')!.status).toBe('active');
    expect(h.store.getTarget('t0')!.exhaustedAt).toBeUndefined(); // the latch was cleared

    // The revived target gets its ONE fresh acquisition and the chain heals.
    expect(await h.engine.stepOnce()).toBe('acquired');
    expect(h.acquisition.calls).toEqual(['targetone', 'targetzero']);
    expect(h.engine.status().queued).toBe(2);
  });

  test('a STALE stamp (outside the re-verify window) is final — the chain halts', async () => {
    const h = makeHarness({ settings: { lowWaterCandidates: 5 } });
    exhaustedHop(h, T0 - RECOVERY.EXHAUSTED_REVERIFY_WINDOW_MS - HOUR);

    expect(await h.engine.stepOnce()).toBe('acquired'); // t1 latches (dry, verified end)
    expect(await h.engine.stepOnce()).toBe('halted');
    expect(h.halts).toEqual(['chain-exhausted']);
    expect(h.store.getTarget('t0')!.status).toBe('exhausted'); // untouched
  });

  test('a target is re-verified at most ONCE per run — a re-exhaustion halts honestly', async () => {
    const h = makeHarness({ settings: { lowWaterCandidates: 5 } });
    exhaustedHop(h, T0 - HOUR);

    expect(await h.engine.stepOnce()).toBe('acquired'); // t1 latches (dry)
    expect(await h.engine.stepOnce()).toBe('advanced-chain'); // t0 revived
    expect(await h.engine.stepOnce()).toBe('acquired'); // t0's retry is ALSO dry → latches
    // Simulate the real controller's fresh evidence stamp for the re-exhaustion
    // (FakeChain does not touch the store).
    h.store.setTargetStatus('t0', 'exhausted', h.clock.now());
    expect(await h.engine.stepOnce()).toBe('halted'); // fresh stamp, but its chance is spent
    expect(h.halts).toEqual(['chain-exhausted']);
  });
});

describe('Engine — target resolution on start', () => {
  test('adopts the ACTIVE store target with the highest chainIndex', async () => {
    const h = makeHarness({ seedTarget: false });
    for (const [pk, username, chainIndex, status] of [
      ['t1', 'one', 0, 'exhausted'],
      ['t2', 'two', 1, 'active'],
      ['t3', 'three', 4, 'active'],
    ] as const) {
      h.store.observe({ accountPk: pk, observedAt: T0, source: 'profile', fields: { username } });
      h.store.addTarget({ accountPk: pk, source: 'seed', status, chainIndex });
    }

    expect(await h.engine.stepOnce()).toBe('idle'); // adoption is free; step idles
    const s = h.engine.status();
    expect(s.currentTargetPk).toBe('t3');
    expect(s.currentTargetUsername).toBe('three');
    expect(s.chainIndex).toBe(4);
  });

  test('no stored target: bootstraps the seed via one acquisition pass', async () => {
    const h = makeHarness({ seedTarget: false });
    h.acquisition.script = [{ observed: 40, targetPk: 'sp' }];
    h.scanner.script = [['c1']];

    const result = await h.engine.stepOnce();

    expect(result).toBe('acquired');
    expect(h.acquisition.calls).toEqual(['seeduser']);
    expect(h.store.getTarget('sp')).toEqual({
      accountPk: 'sp',
      source: 'seed',
      status: 'active',
      chainIndex: 0,
    });
    expect(h.scanner.planCalls).toEqual(['sp']);
    expect(h.engine.status().currentTargetPk).toBe('sp');
    expect(h.engine.status().currentTargetUsername).toBe('seeduser');
  });

  test('an empty seed halts (nothing safe to do without a target)', async () => {
    const h = makeHarness({ seedTarget: false, settings: { seed: '' } });
    expect(await h.engine.stepOnce()).toBe('halted');
    expect(h.halts).toEqual(['seed-missing']);
  });

  test('an unresolvable seed halts', async () => {
    const h = makeHarness({ seedTarget: false });
    h.acquisition.script = [{ observed: 0, targetPk: null }];
    expect(await h.engine.stepOnce()).toBe('halted');
    expect(h.halts).toEqual(['seed-unresolved']);
  });
});

describe('Engine — lifecycle: start/stop/pause (E1)', () => {
  test('stop() aborts the in-flight sleep and start() resolves promptly', async () => {
    const h = makeHarness();
    h.sleep.hang = true; // the idle sleep now blocks until aborted

    const started = h.engine.start();
    await new Promise((r) => setTimeout(r, 0)); // let the loop reach its first sleep
    expect(h.engine.status().state).toBe('running');
    // Parked in the idle sleep — a local beat, drawn inside its band.
    expect(h.sleep.calls.length).toBe(1);
    expect(h.sleep.calls[0]).toBeGreaterThanOrEqual(ENGINE_IDLE_MS * NOISE.BEAT_MIN_FACTOR);
    expect(h.sleep.calls[0]).toBeLessThanOrEqual(ENGINE_IDLE_MS * NOISE.BEAT_MAX_FACTOR);

    h.engine.stop();
    await started; // resolves cleanly — the sleep was interrupted

    expect(h.sleep.aborted).toBe(1);
    expect(h.engine.status().state).toBe('idle');
    expect(await h.engine.stepOnce()).toBe('aborted'); // stopped engine refuses steps
  });

  test("a step that outlives its generation (stop()+start() mid-action) reports 'aborted' and leaves pacing to the new run", async () => {
    const pacing = new FakePacing(T0 + 3600_000);
    const h = makeHarness({ pacing });
    // Two due records: the stale generation consumes the first (its click DID
    // land), so the new generation has its own action to perform.
    h.churn.due = [rec({ accountPk: 'a' }), rec({ accountPk: 'b' })];

    // Gate churn.execute so the step can be caught mid-action (a non-signal-
    // linked await — exactly where a stale generation can wake up).
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let reached!: () => void;
    const reachedGate = new Promise<void>((r) => {
      reached = r;
    });
    const orig = h.churn.execute.bind(h.churn);
    h.churn.execute = async (r: FollowRecord, actAt: number) => {
      reached();
      await gate;
      return orig(r, actAt);
    };

    const stale = h.engine.stepOnce(); // old generation, parked inside the action
    await reachedGate;

    h.engine.stop(); // aborts the old generation…
    const started = h.engine.start(); // …and a NEW generation takes over
    h.engine.pause(); // park the new loop once its in-flight step settles

    release();
    // The stale step must not claim it acted — the new generation owns pacing.
    expect(await stale).toBe('aborted');

    await new Promise((r) => setTimeout(r, 0));
    // Both clicks landed and each dispatch armed its own deadline; the stale step armed nothing of its own,
    // so the deadline owed is the new generation's dispatch gap.
    expect(h.churn.executed.map((r) => r.accountPk)).toEqual(['a', 'b']);
    expect(h.store.getActionDelayDeadline()).toBeGreaterThanOrEqual(T0 + DELAY_MS);

    h.engine.stop();
    await started;
  });

  test('pause() interrupts the sleep and parks the loop; resume() continues it', async () => {
    const h = makeHarness();
    h.sleep.hang = true;

    const started = h.engine.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.sleep.calls.length).toBe(1);

    h.engine.pause();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.engine.status().state).toBe('paused');
    expect(h.sleep.aborted).toBe(1); // control was instant, not queued behind a wait
    const sleepsWhilePaused = h.sleep.calls.length;

    await new Promise((r) => setTimeout(r, 0));
    expect(h.sleep.calls.length).toBe(sleepsWhilePaused); // parked: no further steps

    h.engine.resume();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.engine.status().state).toBe('running');
    expect(h.sleep.calls.length).toBeGreaterThan(sleepsWhilePaused); // stepping again

    h.engine.stop();
    await started;
    expect(h.engine.status().state).toBe('idle');
  });

  test('resume serves the OWED inter-action delay before the next action (no instant act)', async () => {
    const h = makeHarness();
    h.churn.due = [rec({ accountPk: 'a' }), rec({ accountPk: 'b' })];
    h.sleep.hang = true; // the action-delay wait blocks until aborted

    const started = h.engine.start();
    await new Promise((r) => setTimeout(r, 0));
    // Acted once ('a'), now parked in a's inter-action delay.
    expect(h.churn.executed.map((r) => r.accountPk)).toEqual(['a']);
    expect(h.sleep.calls).toEqual([DELAY_MS]);

    h.engine.pause();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.engine.status().state).toBe('paused');
    // The owed delay survives the pause: the countdown still points at it, and
    // 'b' has NOT been executed.
    expect(h.engine.status().nextActionAt).toBe(T0 + DELAY_MS);
    expect(h.churn.executed.map((r) => r.accountPk)).toEqual(['a']);

    // Resume: the loop re-enters the inter-action delay to serve the owed
    // remainder — it does NOT execute 'b' immediately. It re-parks in that
    // wait (still hung), so only a SECOND delay was opened and 'b' is untouched.
    h.engine.resume();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.sleep.calls).toEqual([DELAY_MS, DELAY_MS]); // a's delay + the remainder
    expect(h.churn.executed.map((r) => r.accountPk)).toEqual(['a']); // 'b' NOT acted early

    h.engine.stop();
    await started;
  });

  test('a persisted action-delay deadline is served before the first action of a NEW engine (relaunch)', async () => {
    // Simulate an app relaunch mid-delay: the previous session armed the
    // deadline (T0 + DELAY_MS) and quit; this harness's fresh Engine hydrates
    // it from the store and must wait the remainder before acting.
    const h = makeHarness({
      preseedStore: (store) => store.setActionDelayDeadline(T0 + DELAY_MS),
    });
    h.churn.due = [rec({ accountPk: 'a' })];

    expect(await h.engine.stepOnce()).toBe('acted');

    // The remainder wait came BEFORE the action; the action's own dispatch then armed the next one.
    expect(h.events.slice(0, 2)).toEqual([`sleep:${DELAY_MS}`, 'execute:a']);
    expect(h.store.getActionDelayDeadline()).toBe(T0 + DELAY_MS + DELAY_MS);
  });

  test('an ELAPSED persisted deadline (long app closure) acts immediately', async () => {
    const h = makeHarness({
      preseedStore: (store) => store.setActionDelayDeadline(T0 - 1_000), // already past
    });
    h.churn.due = [rec({ accountPk: 'a' })];

    expect(await h.engine.stepOnce()).toBe('acted');
    expect(h.events[0]).toBe('execute:a'); // no pre-wait — the delay already elapsed offline
  });

  test('stop() mid-delay keeps the owed deadline durable (persisted for the next launch)', async () => {
    const h = makeHarness();
    h.churn.due = [rec({ accountPk: 'a' })];
    h.sleep.hang = true; // park in a's inter-action delay

    const started = h.engine.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.churn.executed.map((r) => r.accountPk)).toEqual(['a']);

    h.engine.stop();
    await started;

    // The deadline survives the stop in the store — a relaunch resumes it.
    expect(h.store.getActionDelayDeadline()).toBe(T0 + DELAY_MS);
  });

  test('a fully-elapsed delay owes nothing: the countdown clears and the next action needs no wait', async () => {
    const h = makeHarness();
    h.churn.due = [rec({ accountPk: 'a' }), rec({ accountPk: 'b' })];

    await h.engine.stepOnce(); // fake sleep advances the clock — the delay completes

    expect(h.store.getActionDelayDeadline()).toBeLessThanOrEqual(h.clock.now());
    expect(h.engine.status().nextActionAt).toBeNull();
    h.sleep.calls = [];
    h.events.length = 0;
    await h.engine.stepOnce();
    expect(h.events[0]).toBe('execute:b');
  });

  test('awaitParked resolves once the paused loop quiesces at the gate (prune hand-off)', async () => {
    const h = makeHarness();
    h.sleep.hang = true; // parked in the idle sleep, still "running"

    const started = h.engine.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.engine.status().state).toBe('running');

    // Ask for the park BEFORE pausing: it must NOT resolve while a step could run.
    let resolved = false;
    const parked = h.engine.awaitParked(1_000).then((v) => {
      resolved = true;
      return v;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toBe(false); // running → not quiesced

    h.engine.pause(); // aborts the in-flight sleep; the loop heads to the gate
    expect(await parked).toBe(true);
    expect(h.engine.status().state).toBe('paused');

    // Already parked → a fresh wait resolves true immediately.
    expect(await h.engine.awaitParked(1_000)).toBe(true);

    h.engine.stop();
    await started;
  });

  test('awaitParked resolves true immediately for an engine that never started', async () => {
    const h = makeHarness();
    expect(await h.engine.awaitParked(1_000)).toBe(true); // idle → not driving the tab
  });

  test('start() halts the loop when the sentinel blocks mid-run', async () => {
    const h = makeHarness({ sentinel: ['ok', 'challenge'] });
    h.churn.due = [rec({ accountPk: 'a' })];

    await h.engine.start(); // resolves on its own: halted on the second iteration

    expect(h.churn.executed.map((r) => r.accountPk)).toEqual(['a']);
    expect(h.halts).toEqual(['sentinel:challenge']);
    expect(h.engine.status().state).toBe('halted');
  });
});

describe('Engine — offline hold (connectivity)', () => {
  test('setOnline(false) parks the running loop; setOnline(true) resumes it', async () => {
    const h = makeHarness();
    h.sleep.hang = true; // the idle sleep now blocks until aborted

    const started = h.engine.start();
    await new Promise((r) => setTimeout(r, 0)); // let the loop reach its first sleep
    expect(h.engine.status().online).toBe(true);
    expect(h.sleep.calls.length).toBe(1); // parked in the idle sleep
    const sessionStartedAt = h.engine.status().sessionStartedAt;
    expect(sessionStartedAt).not.toBeNull();

    h.engine.setOnline(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.engine.status().state).toBe('running'); // offline is a hold, not a stop
    expect(h.engine.status().online).toBe(false);
    expect(h.sleep.aborted).toBe(1); // the in-flight sleep was aborted promptly
    const sleepsWhileOffline = h.sleep.calls.length;

    await new Promise((r) => setTimeout(r, 0));
    expect(h.sleep.calls.length).toBe(sleepsWhileOffline); // parked: no further steps
    expect(h.engine.status().sessionStartedAt).toBe(sessionStartedAt); // hold keeps the session

    h.engine.setOnline(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.engine.status().online).toBe(true);
    expect(h.sleep.calls.length).toBeGreaterThan(sleepsWhileOffline); // stepping again

    h.engine.stop();
    await started;
    expect(h.engine.status().state).toBe('idle');
  });

  test('stop() while offline-parked ends the loop cleanly', async () => {
    const h = makeHarness();
    h.sleep.hang = true;

    const started = h.engine.start();
    await new Promise((r) => setTimeout(r, 0));
    h.engine.setOnline(false);
    await new Promise((r) => setTimeout(r, 0)); // loop is parked in the offline gate

    h.engine.stop();
    await started; // resolves: the offline waiter was released and the token aborted

    expect(h.engine.status().state).toBe('idle');
    expect(await h.engine.stepOnce()).toBe('aborted'); // stopped engine refuses steps
  });

  test('pause() while offline-parked parks as paused; resume() re-parks for offline', async () => {
    const h = makeHarness();
    h.sleep.hang = true;

    const started = h.engine.start();
    await new Promise((r) => setTimeout(r, 0));
    h.engine.setOnline(false);
    await new Promise((r) => setTimeout(r, 0)); // loop is parked in the offline gate

    h.engine.pause();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.engine.status().state).toBe('paused');
    expect(h.engine.status().online).toBe(false);
    const sleepsWhilePaused = h.sleep.calls.length;

    // Resume while still offline: the loop wakes, sees offline, and re-parks —
    // no step runs until connectivity returns.
    h.engine.resume();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.engine.status().state).toBe('running');
    expect(h.sleep.calls.length).toBe(sleepsWhilePaused); // still no further steps

    h.engine.setOnline(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.sleep.calls.length).toBeGreaterThan(sleepsWhilePaused); // stepping again

    h.engine.stop();
    await started;
  });
});

describe('Engine — session tracking + netToday (status projection)', () => {
  test('sessionStartedAt is null when idle, set on start, cleared on stop', async () => {
    const h = makeHarness();
    h.sleep.hang = true; // park in the idle sleep so the clock does not advance

    expect(h.engine.status().sessionStartedAt).toBeNull();

    const started = h.engine.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.engine.status().sessionStartedAt).toBe(h.clock.now());

    h.engine.stop();
    await started;
    expect(h.engine.status().sessionStartedAt).toBeNull();
  });

  test('netToday is the edge-based net: gains today minus losses today', () => {
    const h = makeHarness();
    h.store.setOwnPk('ME');
    const startOfToday = new Date(T0).setHours(0, 0, 0, 0);
    // Gained today (counts) + gained yesterday (does not) + lost today (−1).
    h.store.observeEdge('x', 'ME', 'follows', true, T0);
    h.store.observeEdge('y', 'ME', 'follows', true, startOfToday - HOUR);
    h.store.observeEdge('z', 'ME', 'follows', true, startOfToday - HOUR);
    h.store.observeEdge('z', 'ME', 'follows', false, T0);
    expect(h.engine.status().netToday).toBe(0); // +x −z
  });
});

// --- R1: enrichment pipeline (REAL Scanner + store, fake enricher) -------------------

describe('Engine — R1 candidate enrichment + livelock guard (real Scanner)', () => {
  /** Seed a follower of t1 as the followers-list would: an edge + list fields. */
  const follower = (h: Harness, pk: string, fields: AccountFields): void => {
    h.store.observe({ accountPk: pk, observedAt: T0, source: 'followers-list', fields });
    h.store.observeEdge(pk, 't1', 'follows', true, T0);
  };

  test('acquire → enrich → plan: eligible enqueued, rejected skipped, then the chain ADVANCES', async () => {
    const h = makeHarness({ settings: { lowWaterCandidates: 5 }, useRealScanner: true });
    follower(h, 'f1', { username: 'fone' }); // no counts → enriches to in-band (peak ratio)
    follower(h, 'f2', { username: 'ftwo' }); // no counts → enriches to in-band private
    follower(h, 'f3', { username: 'fthree', followers: 1000, following: 5000 }); // counts KNOWN, ratio 5 → ineligible
    follower(h, 'f4', { username: 'ffour' }); // no counts → enriches to too-small
    h.enricher.profiles.set('fone', { pk: 'f1', fields: { followers: 1000, following: 1100 } });
    h.enricher.profiles.set('ftwo', {
      pk: 'f2',
      fields: { followers: 1000, following: 1150, isPrivate: true },
    });
    h.enricher.profiles.set('ffour', { pk: 'f4', fields: { followers: 10, following: 11 } });

    // Step 1: ONE acquisition + the first enrichment pass over the count-less trio
    // (f3 already has counts, so it is never sent to the enricher).
    expect(await h.engine.stepOnce()).toBe('acquired');
    expect(h.acquisition.calls).toEqual(['targetone']);
    expect(h.enricher.calls).toEqual([['fone', 'ftwo', 'ffour']]);

    // Step 2: everything has counts now → plan: eligible enqueued, rejected SKIPPED.
    expect(await h.engine.stepOnce()).toBe('acquired');
    expect(h.acquisition.calls).toEqual(['targetone']); // no re-acquire mid-cycle
    expect(h.store.getFollowRecord('f1')!.state).toBe('queued');
    expect(h.store.getFollowRecord('f2')!.state).toBe('queued');
    expect(h.store.getAccount('f3')!.role).toBe('skipped');
    expect(h.store.getAccount('f4')!.role).toBe('skipped');
    expect(h.store.candidatePksForTarget('t1')).toEqual([]); // the pool genuinely shrank
    expect(h.engine.status().queued).toBe(2);

    // Step 3: still under low-water, but progress opened a NEW cycle: one more
    // acquisition, nothing left to enrich, and the final plan enqueues 0 → EXHAUSTED.
    expect(await h.engine.stepOnce()).toBe('acquired');
    expect(h.acquisition.calls).toEqual(['targetone', 'targetone']);
    expect(h.enricher.calls.length).toBe(1);

    // Steps 4..8: step 7 is latched off — the refill can NEVER fire again for this
    // target. No acquisition, no enrichment: the livelock is structurally impossible.
    for (let i = 0; i < 5; i += 1) expect(await h.engine.stepOnce()).toBe('idle');
    expect(h.acquisition.calls.length).toBe(2);
    expect(h.enricher.calls.length).toBe(1);

    // Once the queue drains (records acted on), step 9 ADVANCES the chain.
    h.store.upsertFollowRecord(rec({ accountPk: 'f1', targetPk: 't1', state: 'pending_followback' }));
    h.store.upsertFollowRecord(rec({ accountPk: 'f2', targetPk: 't1', state: 'pending_followback' }));
    h.store.observe({
      accountPk: 't9',
      observedAt: T0,
      source: 'profile',
      fields: { username: 'targetnine' },
    });
    h.chain.script = [{ nextTargetPk: 't9', source: 'own_followers', reason: 'next' }];
    expect(await h.engine.stepOnce()).toBe('advanced-chain');
    expect(h.chain.advanceCalls).toEqual(['t1']);
    expect(h.engine.status().currentTargetPk).toBe('t9');
    expect(h.engine.status().currentTargetUsername).toBe('targetnine');
  });

  test('R1.5: enrichment is capped per cycle; a WALLED target backs off instead of burning', async () => {
    const h = makeHarness({ settings: { lowWaterCandidates: 5 }, useRealScanner: true });
    follower(h, 'f1', { username: 'fone' }); // its counts never arrive: enrichment walled

    // Pass 1 rides the one-and-only acquisition; passes 2..K each cost a step.
    for (let pass = 1; pass <= MAX_ENRICH_PASSES_PER_CYCLE; pass += 1) {
      expect(await h.engine.stepOnce()).toBe('acquired');
      expect(h.enricher.calls.length).toBe(pass);
      expect(h.enricher.calls[pass - 1]).toEqual(['fone']);
    }
    expect(h.acquisition.calls).toEqual(['targetone']); // exactly ONE acquire

    // Cap reached and the plan enqueues nothing — but the candidate was never
    // successfully enriched (a rate wall, not a dry target): the engine must
    // BACK OFF and keep the target, never latch it exhausted and burn the
    // chain during a transient outage.
    h.chain.script = [{ nextTargetPk: null, source: 'none', reason: 'no-target-available' }];
    expect(await h.engine.stepOnce()).toBe('idle'); // enrich-backoff park
    expect(h.chain.advanceCalls).toEqual([]); // the chain was NOT advanced
    expect(h.acquisition.calls.length).toBe(1);
    // The backoff is a LONG park: mid-park the pushed status carried the hold,
    // and it cleared once the wait elapsed.
    expect(h.statuses.some((s) => s.parkReason === 'enrich-backoff')).toBe(true);
    expect(h.engine.status().parkReason).toBeNull();

    // After the backoff a fresh cycle retries enrichment (bounded again).
    expect(await h.engine.stepOnce()).toBe('acquired');
    expect(h.enricher.calls.length).toBe(MAX_ENRICH_PASSES_PER_CYCLE + 1);
  });

  test('R1.5: a target whose whole pool was scored-and-rejected genuinely exhausts', async () => {
    const h = makeHarness({ settings: { lowWaterCandidates: 5 }, useRealScanner: true });
    // One follower whose profile DOES arrive but is hard-rejected (verified).
    follower(h, 'f1', { username: 'fone' });
    h.enricher.profiles.set('fone', {
      pk: 'f1',
      fields: { followers: 500, following: 550, isVerified: true },
    });

    expect(await h.engine.stepOnce()).toBe('acquired'); // acquire + enrich pass
    expect(await h.engine.stepOnce()).toBe('acquired'); // plan: f1 scored → rejected → skipped

    // Every candidate is now scored-and-skipped: the target is exhausted and
    // the chain advances (none left → halt).
    h.chain.script = [{ nextTargetPk: null, source: 'none', reason: 'no-target-available' }];
    expect(await h.engine.stepOnce()).toBe('halted');
    expect(h.halts).toEqual(['chain-exhausted']);
  });

  test('an enrichment pass sends at most ENRICH_BATCH_SIZE usernames', async () => {
    const h = makeHarness({ settings: { lowWaterCandidates: 5 }, useRealScanner: true });
    for (let i = 0; i < ENRICH_BATCH_SIZE + 3; i += 1) {
      follower(h, `f${i}`, { username: `user${i}` });
    }
    expect(await h.engine.stepOnce()).toBe('acquired');
    expect(h.enricher.calls[0]!.length).toBe(ENRICH_BATCH_SIZE);
  });

  test("an enrichment pass is the smaller of a slice and the open session's explore reads (spec §5.16)", async () => {
    const pacing = new FakePacing(T0 + HOUR);
    pacing.exploreLeft = 3;
    const h = makeHarness({ settings: { lowWaterCandidates: 5 }, useRealScanner: true, pacing });
    for (let i = 0; i < ENRICH_BATCH_SIZE; i += 1) follower(h, `f${i}`, { username: `user${i}` });
    expect(await h.engine.stepOnce()).toBe('acquired');
    expect(h.enricher.calls[0]).toHaveLength(3);
  });

  test('a session with no explore reads leaves enrichment to the next session — never a walled pass', async () => {
    const pacing = new FakePacing(T0 + HOUR);
    pacing.exploreLeft = 0;
    const h = makeHarness({ settings: { lowWaterCandidates: 5 }, useRealScanner: true, pacing });
    follower(h, 'f1', { username: 'fone' });
    expect(await h.engine.stepOnce()).toBe('idle');
    expect(h.enricher.calls).toEqual([]);
    expect(h.statuses.some((s) => s.parkReason === 'enrich-backoff')).toBe(false);
    // Reads wait for the session that has explore reads: the end of today's plan-day here.
    expect(h.engine.status().state).not.toBe('halted');
    expect(h.acquisition.calls).toEqual(['targetone']);
    await h.engine.stepOnce();
    expect(h.acquisition.calls).toEqual(['targetone']);
  });

  test('a profile read before the weekly cycle of plan-days is read again; one inside it is still fresh', async () => {
    const h = makeHarness({ settings: { lowWaterCandidates: 5 }, useRealScanner: true });
    const DAY = 24 * HOUR;
    const profiled = (pk: string, username: string, at: number): void => {
      h.store.observe({ accountPk: pk, observedAt: at, source: 'profile', fields: { username, followers: 10, following: 11 } });
      h.store.observeEdge(pk, 't1', 'follows', true, T0);
    };
    profiled('f6', 'inside', T0 - 6 * DAY - 11 * HOUR); // the sixth plan-day back, 01:00: fresh
    profiled('f7', 'before', T0 - 6 * DAY - 13 * HOUR); // the seventh plan-day back, 23:00: stale
    expect(await h.engine.stepOnce()).toBe('acquired');
    expect(h.enricher.calls[0]).toEqual(['before']);
  });

  test('refill traffic ends without a beat of its own: the next entry is the activity clock\'s (spec §5.16)', async () => {
    const h = makeHarness({ settings: { lowWaterCandidates: 5 }, useRealScanner: true });
    follower(h, 'f1', { username: 'fone' });
    h.enricher.profiles.set('fone', { pk: 'f1', fields: { followers: 1000, following: 1100 } });

    expect(await h.engine.stepOnce()).toBe('acquired'); // acquire + enrich: Instagram traffic
    expect(h.enricher.calls).toHaveLength(1);
    expect(h.sleep.calls).toEqual([]);
  });
});

// --- R2 / R4 / f9 ---------------------------------------------------------------------

describe('Engine — R2: one concurrent loop (generation token)', () => {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  test('stop()+start() around an in-flight step leaves exactly ONE loop running', async () => {
    const h = makeHarness();
    h.sleep.hang = true;
    h.churn.due = [rec({ accountPk: 'a' }), rec({ accountPk: 'b' }), rec({ accountPk: 'c' })];

    const first = h.engine.start();
    await tick();
    expect(h.churn.executed.map((r) => r.accountPk)).toEqual(['a']); // loop 1 acted, parked in its delay

    h.engine.stop(); // aborts loop 1's generation token + its hanging sleep
    // The owed inter-action delay now SURVIVES a stop; elapse it so the new
    // loop may act at all (stop/start is no longer a way around the pacing).
    h.clock.advance(DELAY_MS);
    const second = h.engine.start(); // restart while loop 1's step is still unwinding
    await first; // the STALE loop exits: its OWN token is aborted (identity check)
    await tick();
    await tick();

    // Only the new loop stepped: exactly one more action ('b'), never a third.
    expect(h.churn.executed.map((r) => r.accountPk)).toEqual(['a', 'b']);
    // The stale loop's exit did not clobber the new run's state.
    expect(h.engine.status().state).toBe('running');

    await tick();
    expect(h.churn.executed.map((r) => r.accountPk)).toEqual(['a', 'b']); // still ONE loop

    h.engine.stop();
    await second;
    expect(h.engine.status().state).toBe('idle');
    expect(h.churn.executed.map((r) => r.accountPk)).toEqual(['a', 'b']);
  });
});

describe('Engine — f9: per-step resilience', () => {
  test("a transient sentinel.check rejection yields 'idle' and the loop survives", async () => {
    const h = makeHarness();
    h.churn.due = [rec({ accountPk: 'a' })];
    h.sentinel.failNext = 1;

    expect(await h.engine.stepOnce()).toBe('idle'); // caught + logged, not a crash
    expect(h.halts).toEqual([]);
    expect(h.engine.status().state).not.toBe('halted');
    expect(h.churn.executed).toEqual([]);
    // One transient-backoff beat, drawn inside the local-beat band.
    expect(h.sleep.calls.length).toBe(1);
    expect(h.sleep.calls[0]).toBeGreaterThanOrEqual(ENGINE_IDLE_MS * NOISE.BEAT_MIN_FACTOR);
    expect(h.sleep.calls[0]).toBeLessThanOrEqual(ENGINE_IDLE_MS * NOISE.BEAT_MAX_FACTOR);

    expect(await h.engine.stepOnce()).toBe('acted'); // the next step proceeds normally
    expect(h.churn.executed.map((r) => r.accountPk)).toEqual(['a']);
  });

  test("a brisk session never shortens the transient backoff below today's band (beat.transient is pace-up)", async () => {
    const clock = new FakeClock(T0);
    const sentinel = new FakeSentinel();
    const churn = new FakeChurn([]);
    const sleeps: number[] = [];
    const engine = new Engine({ ...testDeps({ clock, sentinel, churn,
      delays: new DelayManager({ clock, sleep: async (ms) => { sleeps.push(ms); } }) }), tempo: fixedTempo(0.7) });
    const backoffs: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      churn.due = [rec({ accountPk: `a${i}` })];
      sentinel.failNext = 1;
      const before = sleeps.length;
      expect(await engine.stepOnce()).toBe('idle');
      backoffs.push(...sleeps.slice(before));
      // A healthy step between failures: a run of failures is the runtime-error halt, not a backoff.
      await engine.stepOnce();
    }
    expect(backoffs).toHaveLength(40);
    expect(Math.min(...backoffs)).toBeGreaterThanOrEqual(ENGINE_IDLE_MS * NOISE.BEAT_MIN_FACTOR);
  });

  test('a VERIFIED sentinel block still halts — resilience does not mask real blocks', async () => {
    const h = makeHarness({ sentinel: ['challenge'] });
    expect(await h.engine.stepOnce()).toBe('halted');
    expect(h.halts).toEqual(['sentinel:challenge']);
    expect(h.engine.status().state).toBe('halted');
  });
});

describe('Engine — injectable sweep cadence (persisted by the composition root)', () => {
  test('the follow-back sweep consults the injected cadence and marks the run', async () => {
    const marked: number[] = [];
    const h = makeHarness({
      settings: { followbackSweepHours: 4 },
      sweepCadence: {
        isDue: () => true,
        markRun: (now) => marked.push(now),
      },
    });

    expect(await h.engine.stepOnce()).toBe('swept-followback');
    expect(h.followback.checks).toBe(1);
    expect(marked).toEqual([T0]);
  });

  test('a not-due cadence skips the sweep', async () => {
    const h = makeHarness({
      settings: { followbackSweepHours: 4 },
      sweepCadence: { isDue: () => false, markRun: () => {} },
    });

    expect(await h.engine.stepOnce()).not.toBe('swept-followback');
    expect(h.followback.checks).toBe(0);
  });
});

describe('Engine — DelayManager integration', () => {
  test('status().nextActionAt carries the action-delay deadline while waiting, null after', async () => {
    const h = makeHarness();
    h.churn.due = [rec({ accountPk: 'a' })];

    await h.engine.stepOnce();

    // The mid-wait emission carried the REAL deadline; after the step it is null.
    const midWait = h.statuses.find((s) => s.nextActionAt !== null);
    expect(midWait).toBeDefined();
    expect(midWait!.nextActionAt).toBe(T0 + DELAY_MS);
    expect(h.engine.status().nextActionAt).toBeNull();
  });

  test('a sweep ends without a beat of its own: the step waits nothing after its reads', async () => {
    const h = makeHarness({ settings: { followbackSweepHours: 4 } });

    expect(await h.engine.stepOnce()).toBe('swept-followback');
    expect(h.sleep.calls).toEqual([]);
  });
});

describe('Engine — status projection', () => {
  test('counts follow-record states and governor numbers from the store', async () => {
    const h = makeHarness({ ceiling: 100 });
    h.store.upsertFollowRecord(rec({ accountPk: 'q1', targetPk: 't1', state: 'queued' }));
    h.store.upsertFollowRecord(rec({ accountPk: 'p1', state: 'pending_followback' }));
    h.store.upsertFollowRecord(rec({ accountPk: 'p2', state: 'pending_followback' }));
    h.store.upsertFollowRecord(rec({ accountPk: 'f1', state: 'followed_back' }));
    h.store.upsertFollowRecord(rec({ accountPk: 'u1', state: 'unfollow_queued' }));
    h.store.recordAction('q0', 'follow', 'ok', T0 - HOUR);

    const s = h.engine.status();
    expect(s.queued).toBe(1);
    expect(s.pendingFollowback).toBe(2);
    expect(s.followedBackHeld).toBe(1);
    expect(s.unfollowDue).toBe(1);
    expect(s.actionsToday).toBe(1);
    // The day's volume and what is left of it are the plan's (spec §5.7).
    const view = (h.engine as unknown as { pacing: FakePacing }).pacing.view(h.clock.now());
    expect(s.plannedToday).toBe(Math.max(view.plan.volume.drawn, view.plan.volume.planned));
    expect(s.remainingToday).toBe(view.remaining);
    expect(s.atHardCeiling).toBe(false);
    expect(s.state).toBe('idle');
    expect(s.lastStep).toBeNull();
  });
});

// --- The plan model (the plan service paces the organic model) -----------------------

describe('Engine — organic pacing model', () => {
  test('parks with waited-session when no session is open, taking no action', async () => {
    const pacing = new FakePacing(T0 + 3_600_000);
    pacing.open = false;
    const h = makeHarness({ pacing });
    h.churn.due = [rec({ accountPk: 'a' })];

    const result = await h.engine.stepOnce();

    expect(result).toBe('waited-session');
    expect(pacing.ensures).toBeGreaterThan(0);
    expect(h.churn.executed).toEqual([]); // the gate returns before any action
  });

  test('acts inside a session, then waits on the deadline its dispatch armed — no gap of its own', async () => {
    const pacing = new FakePacing(T0);
    const h = makeHarness({ pacing });
    const gap = 4 * 60_000;
    h.churn.onDispatch = (at) => h.store.setActionDelayDeadline(at + gap);
    h.churn.due = [rec({ accountPk: 'a', state: 'queued' })];

    const result = await h.engine.stepOnce();

    expect(result).toBe('acted');
    expect(h.churn.executed.map((r) => r.accountPk)).toEqual(['a']);
    expect(h.sleep.calls).toEqual([gap]); // the dispatch's deadline, not a draw of the loop's
  });

  test('a write that dispatched nothing (blocked before any press) arms nothing and owes nothing', async () => {
    const pacing = new FakePacing(T0);
    const h = makeHarness({ pacing });
    h.churn.outcome = 'blocked';
    h.churn.lastCause = 'tab-unhealthy';
    h.churn.due = [rec({ accountPk: 'u', state: 'unfollow_queued' })];

    await h.engine.stepOnce();

    expect(h.store.getActionDelayDeadline()).toBeNull();
  });

  test('a practice-mode write owes the gap a dispatch would (practice works as usual)', async () => {
    const pacing = new FakePacing(T0);
    const h = makeHarness({ pacing });
    h.churn.outcome = 'simulated';
    h.churn.due = [rec({ accountPk: 'a', state: 'queued' })];

    expect(await h.engine.stepOnce()).toBe('acted');
    expect(pacing.practices).toEqual([T0]);
  });

  test('a full rolling hour parks exactly to its window, taking no action', async () => {
    const pacing = new FakePacing(T0);
    pacing.velocityUntil = T0 + 7 * 60_000;
    const h = makeHarness({ pacing });
    h.churn.due = [rec({ accountPk: 'a' })];

    const result = await h.engine.stepOnce();

    expect(result).toBe('waited-session');
    expect(h.sleep.calls).toEqual([7 * 60_000]);
    expect(h.churn.executed).toEqual([]);
  });

  test('writes no planner snapshot: the plan service is the one writer of the day', async () => {
    const pacing = new FakePacing(T0);
    const h = makeHarness({ pacing });
    h.churn.due = [rec({ accountPk: 'a' })];

    await h.engine.stepOnce();

    expect(h.store.getPacingState()).toBeNull();
  });

  test("the day's volume spent parks to the next plan-day, not the next session", async () => {
    const pacing = new FakePacing(T0 + HOUR);
    pacing.usedAuto = pacing.target;
    const h = makeHarness({ pacing });
    h.churn.due = [rec({ accountPk: 'a' })];

    expect(await h.engine.stepOnce()).toBe('waited-ceiling');
    expect(h.churn.executed).toEqual([]);
  });

  test('status carries the pacing projection in organic mode', () => {
    const pacing = new FakePacing(T0 + 1000);
    pacing.open = false;
    pacing.target = 30;
    const h = makeHarness({ pacing });

    const s = h.engine.status();

    expect(s.pacing).not.toBeNull();
    expect(s.pacing?.dailyTarget).toBe(30);
    expect(s.pacing?.nextSessionAt).toBe(T0 + 1000);
  });

});

// --- Woven prune feed (organic model) ---------------------------------------------

class FakeFeed implements EngineUnfollowFeed {
  details: ChurnActionOutcome | null = null;
  lastActionOutcome(): ChurnActionOutcome | null { return this.details; }
  candidates: Array<{ pk: string; username: string }> = [];
  cap = false;
  executed: Array<{ pk: string; username: string }> = [];
  outcome: 'ok' | 'failed' | 'simulated' | 'blocked' = 'ok';
  /** The dispatch closure's arm (the cadence in production), when the write dispatched. */
  onDispatch: ((at: number) => void) | null = null;
  nextCandidate(): { pk: string; username: string } | null {
    return this.cap ? null : (this.candidates[0] ?? null);
  }
  async executeUnfollow(cand: { pk: string; username: string }, now: number): Promise<
    'ok' | 'failed' | 'simulated' | 'blocked'
  > {
    this.executed.push(cand);
    if (this.outcome !== 'blocked') this.candidates = this.candidates.filter((c) => c.pk !== cand.pk);
    if (this.outcome === 'ok' || this.outcome === 'failed') this.onDispatch?.(now);
    return this.outcome;
  }
  atDailyCap(): boolean {
    return this.cap;
  }
}

describe('Engine — woven prune feed', () => {
  test('a woven server refusal enters the same account-wide recovery as growth', async () => {
    const feed = new FakeFeed();
    feed.candidates = [{ pk: 'p1', username: 'prunee' }];
    feed.outcome = 'blocked';
    feed.details = { status: 'blocked', cause: 'rate-limited' };
    const h = makeHarness({ pacing: new FakePacing(T0), unfollowFeed: feed });
    expect(await h.engine.stepOnce()).toBe('recovering');
    expect(h.engine.status().recovery?.phase).toBe('probing');
    expect(h.churn.executed).toEqual([]);
    expect(feed.candidates).toHaveLength(1);
  });
  test('weaves a prune unfollow when no lifecycle action is due, paced by the deadline its dispatch armed', async () => {
    const pacing = new FakePacing(T0);
    const feed = new FakeFeed();
    feed.candidates = [{ pk: 'p1', username: 'prunee' }];
    const h = makeHarness({ pacing, unfollowFeed: feed });
    feed.onDispatch = (at) => h.store.setActionDelayDeadline(at + 4 * 60_000);
    // no churn.due → no lifecycle action

    const result = await h.engine.stepOnce();

    expect(result).toBe('acted');
    expect(feed.executed).toEqual([{ pk: 'p1', username: 'prunee' }]);
    expect(h.sleep.calls).toEqual([4 * 60_000]); // the dispatch's deadline
  });

  test('does not weave when weaveEnabled is false', async () => {
    const pacing = new FakePacing(T0);
    const feed = new FakeFeed();
    feed.candidates = [{ pk: 'p1', username: 'prunee' }];
    const h = makeHarness({ pacing, unfollowFeed: feed, settings: { weaveEnabled: false } });

    const result = await h.engine.stepOnce();

    expect(feed.executed).toEqual([]);
    expect(result).not.toBe('acted');
  });

  test('does not weave when the prune daily cap is hit', async () => {
    const pacing = new FakePacing(T0);
    const feed = new FakeFeed();
    feed.candidates = [{ pk: 'p1', username: 'prunee' }];
    feed.cap = true;
    const h = makeHarness({ pacing, unfollowFeed: feed });

    await h.engine.stepOnce();

    expect(feed.executed).toEqual([]);
  });

  test('a blocked woven unfollow parks and records no action', async () => {
    const pacing = new FakePacing(T0);
    const feed = new FakeFeed();
    feed.candidates = [{ pk: 'p1', username: 'prunee' }];
    feed.outcome = 'blocked';
    const h = makeHarness({ pacing, unfollowFeed: feed });

    const result = await h.engine.stepOnce();

    expect(result).toBe('idle');
    expect(feed.executed.length).toBe(1); // attempted
    expect(h.store.getActionDelayDeadline()).toBeNull(); // nothing dispatched, nothing owed
  });

  test.each([
    [0.1, 'the woven unfollow'],
    [0.9, 'the follow'],
  ] as const)('the plan mix: with both kinds available a draw of %s against the session share picks %s', async (draw, picked) => {
    const pacing = new FakePacing(T0);
    pacing.mixDrawValue = draw; // the session's shares are one follow and one unfollow: an unfollow share of 0.5
    const feed = new FakeFeed();
    feed.candidates = [{ pk: 'p1', username: 'prunee' }];
    const h = makeHarness({ pacing, unfollowFeed: feed });
    h.churn.due = [rec({ accountPk: 'f1', state: 'queued' })];

    await h.engine.stepOnce();

    expect(feed.executed.length).toBe(picked === 'the follow' ? 0 : 1);
    expect(h.churn.executed.map((r) => r.accountPk)).toEqual(picked === 'the follow' ? ['f1'] : []);
  });

  test('the mix never lets a woven candidate displace a due lifecycle unfollow', async () => {
    const pacing = new FakePacing(T0);
    const feed = new FakeFeed();
    feed.candidates = [{ pk: 'p1', username: 'prunee' }];
    const h = makeHarness({ pacing, unfollowFeed: feed });
    h.churn.due = [rec({ accountPk: 'u1', state: 'unfollow_queued' })];

    await h.engine.stepOnce();

    expect(h.churn.executed.map((r) => r.accountPk)).toEqual(['u1']); // lifecycle wins
    expect(feed.executed).toEqual([]);
  });

  test.each([
    ['a paused relationship surface', (p: FakePacing) => { p.pausedActivities.add('unfollows'); }],
    ["a spent session unfollow share (the follow takes it)", (p: FakePacing) => { p.unfollowsLeft = 0; }],
  ] as const)('unfollow work is unavailable under %s: the follow is chosen', async (_name, set) => {
    const pacing = new FakePacing(T0);
    set(pacing);
    const feed = new FakeFeed();
    feed.candidates = [{ pk: 'p1', username: 'prunee' }];
    const h = makeHarness({ pacing, unfollowFeed: feed });
    h.churn.due = [rec({ accountPk: 'u1', state: 'unfollow_queued' }), rec({ accountPk: 'f1', state: 'queued' })];

    await h.engine.stepOnce();

    expect(h.churn.executed.map((r) => r.accountPk)).toEqual(['f1']);
    expect(feed.executed).toEqual([]);
  });

  test('woven cleanup waits out the cool-down after a rate wall; the follow goes on', async () => {
    const pacing = new FakePacing(T0);
    const feed = new FakeFeed();
    feed.candidates = [{ pk: 'p1', username: 'prunee' }];
    const h = makeHarness({ pacing, unfollowFeed: feed });
    (h.engine as unknown as { lastHalt: { reason: string; at: number } }).lastHalt = { reason: 'rate-limited', at: T0 - 1 };
    h.churn.due = [rec({ accountPk: 'f1', state: 'queued' })];

    await h.engine.stepOnce();

    expect(feed.executed).toEqual([]);
    expect(h.churn.executed.map((r) => r.accountPk)).toEqual(['f1']);
  });

  test('finding new people waits while the list surface is paused: no refill, queued follows go on', async () => {
    const pacing = new FakePacing(T0);
    pacing.pausedActivities.add('exploration');
    const h = makeHarness({ pacing, settings: { lowWaterCandidates: 5 } });
    h.churn.due = [rec({ accountPk: 'f1', state: 'queued' })];

    await h.engine.stepOnce();

    expect(h.acquisition.calls).toEqual([]);
    expect(h.churn.executed.map((r) => r.accountPk)).toEqual(['f1']);
  });
});

// --- Recovery ladder (item #5) ------------------------------------------------------

describe('Engine — recovery ladder', () => {
  test('a blocked outcome takes a SHORT park (record untouched), never full-pace re-drive', async () => {
    const h = makeHarness();
    h.churn.due = [rec({ accountPk: 'a' })];
    h.churn.outcome = 'blocked';
    h.churn.blockedStreak = 1;

    expect(await h.engine.stepOnce()).toBe('idle');
    // The blocked park is a retry backoff: jittered around PRUNE.PARK_MS,
    // bounded — and NOT the paced delay (240s), which sits outside the band.
    expect(h.sleep.calls.length).toBe(1);
    expect(h.sleep.calls[0]).toBeGreaterThanOrEqual(30_000 * NOISE.BACKOFF_MIN_FACTOR);
    expect(h.sleep.calls[0]).toBeLessThanOrEqual(30_000 * NOISE.BACKOFF_MAX_FACTOR);
    expect(h.churn.due.map((r) => r.accountPk)).toEqual(['a']); // record untouched
    expect(h.engine.status().recovery).toBeNull(); // below the streak: no ladder
  });

  test('a DEFINITIVE rate limit (the server refused the mutation) enters recovery on the FIRST block', async () => {
    const h = makeHarness();
    h.churn.due = [rec({ accountPk: 'a' })];
    h.churn.outcome = 'blocked';
    h.churn.blockedStreak = 1; // far below the streak threshold…
    h.churn.lastCause = 'rate-limited'; // …but Instagram said so in the response body

    expect(await h.engine.stepOnce()).toBe('recovering');
    expect(h.churn.due.map((r) => r.accountPk)).toEqual(['a']); // record untouched
    expect(h.halts).toEqual([]);
    expect(h.engine.status().recovery?.phase).toBe('probing'); // hold served by fake sleep
  });

  test('a blocked streak of BLOCKED_STREAK_ENTRY enters recovery without touching records', async () => {
    const h = makeHarness();
    h.churn.due = [rec({ accountPk: 'a' })];
    h.churn.outcome = 'blocked';
    h.churn.blockedStreak = RECOVERY.BLOCKED_STREAK_ENTRY;

    expect(await h.engine.stepOnce()).toBe('recovering');
    expect(h.churn.due.map((r) => r.accountPk)).toEqual(['a']); // still untouched
    expect(h.churn.resetBlockedCalls).toBe(1);
    expect(h.halts).toEqual([]);
    expect(h.engine.status().recovery?.phase).toBe('probing'); // hold served by fake sleep
  });

  test('the THIRD consecutive walled enrichment cycle enters recovery', async () => {
    const h = makeHarness({ settings: { lowWaterCandidates: 5 }, useRealScanner: true });
    // A follower whose counts never arrive: every enrichment pass delivers 0.
    h.store.observe({
      accountPk: 'f1',
      observedAt: T0,
      source: 'followers-list',
      fields: { username: 'fone' },
    });
    h.store.observeEdge('f1', 't1', 'follows', true, T0);

    // Cycles 1 and 2: capped enrichment passes, then the flat walled backoff.
    for (let cycle = 1; cycle <= 2; cycle += 1) {
      for (let pass = 1; pass <= MAX_ENRICH_PASSES_PER_CYCLE; pass += 1) {
        expect(await h.engine.stepOnce()).toBe('acquired');
      }
      expect(await h.engine.stepOnce()).toBe('idle'); // enrich-backoff park
      expect(h.engine.status().recovery).toBeNull();
    }
    // Cycle 3: walls again → the recovery ladder, not another flat backoff.
    for (let pass = 1; pass <= MAX_ENRICH_PASSES_PER_CYCLE; pass += 1) {
      expect(await h.engine.stepOnce()).toBe('acquired');
    }
    expect(await h.engine.stepOnce()).toBe('recovering');
    expect(h.engine.status().recovery?.phase).toBe('probing');
    expect(h.halts).toEqual([]); // the target/chain was NOT burned
  });

  test('status carries the recovery hold (phase/attempt/resumeAt) while holding; a stop keeps it armed', async () => {
    const h = makeHarness({ sentinel: ['action-blocked'] });
    h.sleep.hang = true; // park in the hold

    const stepping = h.engine.stepOnce();
    await new Promise((r) => setTimeout(r, 0));

    const st = h.engine.status();
    expect(st.recovery?.phase).toBe('holding');
    expect(st.recovery?.attempt).toBe(1);
    expect(st.recovery?.maxAttempts).toBe(RECOVERY.MAX_HOLDS);
    expect(st.recovery?.resumeAt).toBe(st.parkedUntil); // the park IS the hold
    expect(st.parkReason).toBe('recovery');
    // The projection was PUSHED at registration, before the hold elapsed.
    const pushed = h.statuses[h.statuses.length - 1];
    expect(pushed.recovery?.phase).toBe('holding');

    h.engine.stop();
    expect(await stepping).toBe('recovering');
    // The interrupted hold's absolute deadline stays armed (durable).
    expect(h.engine.status().recovery?.phase).toBe('holding');
    expect(h.store.getRecoveryState()).not.toBeNull();
  });

  test('a relaunched engine serves the REMAINDER of a persisted hold before anything else', async () => {
    const h = makeHarness({
      preseedStore: (store) =>
        store.setRecoveryState(
          JSON.stringify({
            phase: 'holding',
            attempt: 2,
            holdUntil: T0 + 10 * 60_000,
            enteredAt: T0 - 60_000,
            kindTally: { 'rate-limited': 2 },
          }),
        ),
    });
    h.churn.due = [rec({ accountPk: 'a' })];

    expect(await h.engine.stepOnce()).toBe('recovering');
    expect(h.sleep.calls).toEqual([10 * 60_000]); // the remainder, not a fresh draw
    expect(h.engine.status().recovery).toEqual({
      phase: 'probing',
      attempt: 2,
      maxAttempts: RECOVERY.MAX_HOLDS,
      resumeAt: null,
    });
    // The next step acts normally — the probe.
    expect(await h.engine.stepOnce()).toBe('acted');
  });

  test('a persisted hold whose deadline already passed probes immediately', async () => {
    const h = makeHarness({
      preseedStore: (store) =>
        store.setRecoveryState(
          JSON.stringify({
            phase: 'holding',
            attempt: 1,
            holdUntil: T0 - 1_000,
            enteredAt: T0 - 3_600_000,
            kindTally: {},
          }),
        ),
    });
    h.churn.due = [rec({ accountPk: 'a' })];

    expect(await h.engine.stepOnce()).toBe('recovering'); // zero-remainder serve
    expect(h.sleep.calls).toEqual([]); // no wait at all
    expect(await h.engine.stepOnce()).toBe('acted');
  });

  test('a verified success while probing clears the ladder and its persisted state', async () => {
    const h = makeHarness({ sentinel: ['action-blocked'] });
    expect(await h.engine.stepOnce()).toBe('recovering'); // rung 1 served → probing
    expect(h.store.getRecoveryState()).not.toBeNull();

    h.churn.due = [rec({ accountPk: 'a' })];
    expect(await h.engine.stepOnce()).toBe('acted'); // the probe lands ok

    expect(h.engine.status().recovery).toBeNull();
    expect(h.store.getRecoveryState()).toBeNull();
  });

  test('while probing, REENTRY_FAILS consecutive fails re-enter the ladder (rung 2)', async () => {
    const h = makeHarness({ sentinel: ['action-blocked'] });
    expect(await h.engine.stepOnce()).toBe('recovering'); // rung 1 served → probing

    h.churn.due = [rec({ accountPk: 'a' })];
    h.churn.outcome = 'failed';
    h.churn.failStreak = RECOVERY.REENTRY_FAILS; // far below the cold threshold of 8
    expect(await h.engine.stepOnce()).toBe('recovering');
    expect(h.engine.status().recovery?.attempt).toBe(2);
  });

  test('exhaustion after MAX_HOLDS failed rungs halts recovery-exhausted; a manual Start clears it', async () => {
    const h = makeHarness({
      sentinel: ['action-blocked', 'action-blocked', 'action-blocked', 'action-blocked'],
    });
    expect(await h.engine.stepOnce()).toBe('recovering'); // rung 1
    expect(await h.engine.stepOnce()).toBe('recovering'); // rung 2
    expect(await h.engine.stepOnce()).toBe('recovering'); // rung 3
    expect(await h.engine.stepOnce()).toBe('halted'); // rungs spent → honest halt
    expect(h.halts).toEqual(['recovery-exhausted']);
    expect(h.engine.status().haltReason).toBe('recovery-exhausted');
    expect(h.store.getRecoveryState()).not.toBeNull(); // exhausted state persisted

    // User ack: a manual Start from the recovery halt clears the ladder.
    h.sleep.hang = true;
    const started = h.engine.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.store.getRecoveryState()).toBeNull();
    expect(h.engine.status().recovery).toBeNull();
    h.engine.stop();
    await started;
  });

  test('confirmed drift (two drift windows after a hold) halts adapter-drift', async () => {
    const h = makeHarness();
    // Window 1 — all-drift failing streak from a standing start: presumed
    // rate-limited is NOT applied to the kind note (the evidence is tallied),
    // but the FIRST response is still a hold, never the drift terminal.
    h.churn.due = [rec({ accountPk: 'a' })];
    h.churn.outcome = 'failed';
    h.churn.failStreak = 8;
    h.churn.driftStreak = 8;
    expect(await h.engine.stepOnce()).toBe('recovering'); // hold 1 — no drift halt yet
    expect(h.halts).toEqual([]);

    // Window 2 — the streak recurs while probing, again all drift-caused.
    h.churn.due = [rec({ accountPk: 'b' })];
    h.churn.failStreak = RECOVERY.REENTRY_FAILS;
    h.churn.driftStreak = RECOVERY.REENTRY_FAILS;
    expect(await h.engine.stepOnce()).toBe('halted');
    expect(h.halts).toEqual(['adapter-drift']);
    expect(h.engine.status().haltReason).toBe('adapter-drift');
  });

  test('a failed canary routes to TAB RECOVERY, consuming no rung and touching no records', async () => {
    const calls: string[] = [];
    const h = makeHarness({
      sentinel: ['action-blocked'],
      tabDiag: {
        probeInput: async () => {
          calls.push('probe');
          return true;
        },
        checkHealth: async () => {
          calls.push('canary');
          return { healthy: false };
        },
        recoverTab: async () => {
          calls.push('recover');
        },
      },
    });
    h.churn.due = [rec({ accountPk: 'a' })];

    expect(await h.engine.stepOnce()).toBe('recovering');
    expect(calls).toEqual(['probe', 'canary', 'recover']);
    expect(h.engine.status().recovery).toBeNull(); // no hold armed, no rung consumed
    expect(h.sleep.calls).toEqual([]); // no ladder wait either
    expect(h.churn.executed).toEqual([]); // records untouched
  });

  test('a healthy diagnosis (probe + canary pass) presumes a rate wall and holds', async () => {
    const calls: string[] = [];
    const h = makeHarness({
      sentinel: ['action-blocked'],
      tabDiag: {
        probeInput: async () => {
          calls.push('probe');
          return true;
        },
        checkHealth: async () => {
          calls.push('canary');
          return { healthy: true };
        },
        recoverTab: async () => {
          calls.push('recover');
        },
      },
    });

    expect(await h.engine.stepOnce()).toBe('recovering');
    expect(calls).toEqual(['probe', 'canary']); // diagnosed, no tab recovery
    expect(h.engine.status().recovery?.phase).toBe('probing'); // hold served
  });
});

describe('Engine — requeue-healer (closed incident windows)', () => {
  const abandoned = (
    accountPk: string,
    over: Partial<FollowRecord> = {},
  ): FollowRecord => rec({ accountPk, targetPk: 't1', state: 'abandoned', retryCount: 4, ...over });

  test('a probe success closes the window and requeues ONLY its in-window burn, once', async () => {
    const h = makeHarness({ sentinel: ['action-blocked'] });
    // Burned just before the ladder woke up (the entry streak's victims): in-window.
    h.store.upsertFollowRecord(abandoned('burned', { abandonedAt: T0 - 60_000 }));
    // Abandoned long before any systemic trouble: outside even the grace.
    h.store.upsertFollowRecord(
      abandoned('ancient', { abandonedAt: T0 - RECOVERY.HEAL_GRACE_MS - 60_000 }),
    );
    // In-window but aimed at a retired target: unworkable, stays abandoned.
    h.store.addTarget({ accountPk: 't9', source: 'discovered', status: 'exhausted', chainIndex: 9 });
    h.store.upsertFollowRecord(abandoned('retired', { targetPk: 't9', abandonedAt: T0 - 60_000 }));
    expect(h.store.targetFunnel('t1').states).toMatchObject({ abandoned: 2, queued: 0 });

    expect(await h.engine.stepOnce()).toBe('recovering'); // rung 1 (enteredAt = T0) → probing
    h.churn.due = [rec({ accountPk: 'a' })];
    expect(await h.engine.stepOnce()).toBe('acted'); // the probe lands ok → ladder reset → heal

    expect(h.store.getFollowRecord('burned')).toMatchObject({ state: 'queued', retryCount: 0 });
    expect(h.store.getFollowRecord('burned')!.healedAt).toBeDefined();
    expect(h.store.getFollowRecord('ancient')!.state).toBe('abandoned');
    expect(h.store.getFollowRecord('retired')!.state).toBe('abandoned');
    // §4 funnel honesty: the red segment shrank because the GRAPH moved.
    expect(h.store.targetFunnel('t1').states).toMatchObject({ abandoned: 1, queued: 1 });
    // The persisted incident carries the window and the heal outcome.
    const incident = JSON.parse(h.store.getRecoveryLastIncident()!);
    expect(incident.enteredAt).toBe(T0);
    expect(incident.healed.count).toBe(1);

    // At most one window per reset: a later success with the ladder inactive
    // closes nothing — records abandoned afterwards are NOT swept up.
    h.store.upsertFollowRecord(abandoned('later', { abandonedAt: T0 - 60_000 }));
    h.churn.due = [rec({ accountPk: 'b' })];
    expect(await h.engine.stepOnce()).toBe('acted');
    expect(h.store.getFollowRecord('later')!.state).toBe('abandoned');
  });

  test('the heal batch is capped at HEAL_MAX_RECORDS — a pathological window cannot mass-mutate', async () => {
    const h = makeHarness({ sentinel: ['action-blocked'] });
    for (let i = 0; i < RECOVERY.HEAL_MAX_RECORDS + 1; i += 1) {
      h.store.upsertFollowRecord(
        abandoned(`p${String(i).padStart(3, '0')}`, { abandonedAt: T0 - 1_000 }),
      );
    }

    expect(await h.engine.stepOnce()).toBe('recovering');
    h.churn.due = [rec({ accountPk: 'a' })];
    expect(await h.engine.stepOnce()).toBe('acted');

    expect(h.store.followRecordsByState('queued')).toHaveLength(RECOVERY.HEAL_MAX_RECORDS);
    expect(h.store.followRecordsByState('abandoned')).toHaveLength(1); // capped out, untouched
  });

  test('a manual Start from recovery-exhausted closes the window and heals (user ack)', async () => {
    const h = makeHarness({
      sentinel: ['action-blocked', 'action-blocked', 'action-blocked', 'action-blocked'],
    });
    // Abandoned DURING the episode (between entry and the terminal halt).
    h.store.upsertFollowRecord(abandoned('burned', { abandonedAt: T0 + 1_000 }));

    expect(await h.engine.stepOnce()).toBe('recovering'); // rung 1
    expect(await h.engine.stepOnce()).toBe('recovering'); // rung 2
    expect(await h.engine.stepOnce()).toBe('recovering'); // rung 3
    expect(await h.engine.stepOnce()).toBe('halted'); // recovery-exhausted
    expect(h.store.getFollowRecord('burned')!.state).toBe('abandoned'); // halt alone heals nothing

    // The user's Start IS the window close for a terminal episode.
    h.sleep.hang = true;
    const started = h.engine.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.store.getFollowRecord('burned')).toMatchObject({ state: 'queued', retryCount: 0 });
    const incident = JSON.parse(h.store.getRecoveryLastIncident()!);
    expect(incident.attempts).toBe(RECOVERY.MAX_HOLDS);
    expect(incident.healed.count).toBe(1);
    h.engine.stop();
    await started;
  });
});

describe('Engine — the unconfirmed-actions breaker (spec §11.1 F7)', () => {
  /** A lifecycle unfollow Instagram answers with nothing: dispatched, unverified. */
  const unverified = (h: Harness): void => {
    h.churn.outcome = 'blocked';
    (h.churn as { lastActionOutcome?: () => ChurnActionOutcome }).lastActionOutcome = () =>
      ({ status: 'blocked', cause: 'unverified', unverifiedClick: true });
  };

  test('two unverified unfollows park (no rate-wall signal) and hold unfollows; the third enters the ladder', async () => {
    const pacing = new FakePacing(T0 + HOUR);
    const h = makeHarness({ pacing });
    unverified(h);
    h.churn.due = [rec({ accountPk: 'u', state: 'unfollow_queued' })];

    expect(await h.engine.stepOnce()).toBe('idle');
    expect(await h.engine.stepOnce()).toBe('idle');
    expect(pacing.breaker.held(h.clock.now())).toEqual({ kind: 'unfollow', streak: 2 });
    expect(h.engine.status().recovery).toBeNull();
    // The next session's one attempt: unverified again, so the kind enters the ladder.
    h.clock.set(T0 + HOUR);
    await h.engine.stepOnce();
    expect(h.engine.status().recovery).not.toBeNull();
  });

  test('a confirmed unfollow resets the streak', async () => {
    const pacing = new FakePacing(T0 + HOUR);
    const h = makeHarness({ pacing });
    unverified(h);
    h.churn.due = [rec({ accountPk: 'u', state: 'unfollow_queued' })];
    await h.engine.stepOnce();
    h.churn.outcome = 'ok';
    (h.churn as { lastActionOutcome?: () => ChurnActionOutcome }).lastActionOutcome = () => ({ status: 'ok' });
    await h.engine.stepOnce();
    expect(pacing.noteOutcome('unfollow', true, h.clock.now())).toBe(1);
  });
});

describe('Engine — lastActionAt survives a relaunch (spec §15.3)', () => {
  test("before this run acts, the status shows the store's last settled write", async () => {
    const h = makeHarness();
    expect(h.engine.status().lastActionAt).toBeNull();
    const intent = h.store.beginEffectIntent({ accountPk: 'a', username: 'a', action: 'follow', channel: 'growth', at: T0 - HOUR });
    h.store.markEffectDispatched(intent.id, T0 - HOUR);
    h.store.settleEffectIntent(intent.id, { at: T0 - HOUR, result: 'ok', ledger: 'growth' });
    expect(h.engine.status().lastActionAt).toBe(T0 - HOUR);
    h.churn.due = [rec({ accountPk: 'b' })];
    await h.engine.stepOnce();
    expect(h.engine.status().lastActionAt).toBe(T0);
  });
});

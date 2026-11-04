import {
  blockedStreakThreshold,
  gapCapMs,
  holdMediansMs,
  holdSigma,
  PROVENANCE,
  pollEveryFor,
  reentryFailThreshold,
  stagnantPageThreshold,
  timeoutFor,
} from '@/kernel/derive';
import { POLICY } from '@/kernel/policy';
import {
  ADAPTER,
  CONNECTIVITY,
  ENGINE,
  HARNESS,
  NOISE,
  POLL,
  PRUNE,
  RECOVERY,
  RIM,
  SCHEDULER,
  SESSION,
  TAB,
} from '@/timing/config';

describe('timing/config — registry invariants', () => {
  test('values match the historical per-file constants', () => {
    expect(ENGINE.IDLE_MS).toBe(30_000);
    expect(PRUNE.PARK_MS).toBe(30_000);
    expect(PRUNE.PARK_TIMEOUT_MS).toBe(90_000);
    expect(CONNECTIVITY.PROBE_INTERVAL_MS).toBe(20_000);
    expect(CONNECTIVITY.REQUEST_TIMEOUT_MS).toBe(5_000);
    expect(SCHEDULER.USERNAME_RESOLVE_RETRY_MS).toBe(1_500);
    expect(ADAPTER.POLL_INTERVAL_MS).toBe(250);
    expect(ADAPTER.POLL_TIMEOUT_MS).toBe(8_000);
    expect(RIM.SCROLL_WAIT_MS).toBe(2_000);
    expect(POLL.KEEPALIVE_MS).toBe(10_000);
    expect(HARNESS.LOGIN_POLL_MS).toBe(2_000);
    // Tab-facing await deadlines (adapter-awaits-unbounded fix).
    expect(TAB.GOTO_TIMEOUT_MS).toBe(30_000);
    expect(TAB.EVALUATE_TIMEOUT_MS).toBe(15_000);
    expect(TAB.GET_BODY_TIMEOUT_MS).toBe(10_000);
    expect(TAB.FETCH_ABORT_MS).toBe(20_000);
    expect(TAB.TEARDOWN_ENGINE_WAIT_MS).toBe(15_000);
    expect(RECOVERY.STEP_WATCHDOG_MS).toBe(8 * 60_000);
    expect(RECOVERY.STEP_WATCHDOG_CHECK_MS).toBe(60_000);
  });

  test('every min/max pair is ordered', () => {
    expect(HARNESS.OP_DELAY_MIN_MS).toBeLessThanOrEqual(HARNESS.OP_DELAY_MAX_MS);
    expect(HARNESS.ENRICH_PACE_MIN_MS).toBeLessThanOrEqual(HARNESS.ENRICH_PACE_MAX_MS);
    expect(RIM.NOTIFICATIONS_SCROLL_WAIT_MIN_MS).toBeLessThanOrEqual(
      RIM.NOTIFICATIONS_SCROLL_WAIT_MAX_MS,
    );
    expect(RIM.NOTIFICATIONS_CLOSE_DELAY_MIN_MS).toBeLessThanOrEqual(
      RIM.NOTIFICATIONS_CLOSE_DELAY_MAX_MS,
    );
    expect(RIM.ACQUIRE_SCROLL_MIN_MS).toBeLessThanOrEqual(RIM.ACQUIRE_SCROLL_MAX_MS);
    expect(NOISE.BACKOFF_MIN_FACTOR).toBeLessThanOrEqual(NOISE.BACKOFF_MAX_FACTOR);
    expect(NOISE.BEAT_MIN_FACTOR).toBeLessThanOrEqual(NOISE.BEAT_MAX_FACTOR);
    expect(NOISE.LIST_WALK_REST_EVERY_MIN).toBeLessThanOrEqual(NOISE.LIST_WALK_REST_EVERY_MAX);
  });

  test('noise-layer invariants: park-preserving floors', () => {
    expect(NOISE.BACKOFF_MIN_FACTOR).toBeGreaterThan(0); // a park always stays a park
    expect(NOISE.BEAT_MIN_FACTOR).toBeGreaterThan(0);
    expect(NOISE.LIST_WALK_REST_EVERY_MIN).toBeGreaterThanOrEqual(1);
  });
});

/**
 * Since ADR 0605 this registry is a SHIM: the values come from
 * `src/kernel/derive.ts`. These identities are the documentation — they say
 * WHICH derivation each constant is, in a form that goes red if the wiring is
 * ever quietly re-pointed at a literal.
 */
describe('timing/config — the registry is derived, not declared', () => {
  test('D3: the recovery ladder, its rung count and every jitter width', () => {
    expect(RECOVERY.HOLD_MEDIANS_MS).toEqual(holdMediansMs());
    expect(RECOVERY.MAX_HOLDS).toBe(RECOVERY.HOLD_MEDIANS_MS.length);
    expect(RECOVERY.HOLD_SIGMA).toBe(holdSigma());
    // The clamp band sizes the retry-backoff spread: its edge sits at the 99th percentile.
    expect(NOISE.BACKOFF_SIGMA).toBeCloseTo(Math.log(NOISE.BACKOFF_MAX_FACTOR) / POLICY.DRAW_TAIL_Z, 1);
  });

  test('D4: five adapter/tab deadlines and three poll intervals, one formula each', () => {
    expect(ADAPTER.MUTATION_RESPONSE_TIMEOUT_MS).toBe(timeoutFor('mutation'));
    expect(ADAPTER.POLL_TIMEOUT_MS).toBe(timeoutFor('control'));
    expect(TAB.GOTO_TIMEOUT_MS).toBe(timeoutFor('nav'));
    expect(TAB.EVALUATE_TIMEOUT_MS).toBe(timeoutFor('evaluate'));
    expect(TAB.FETCH_ABORT_MS).toBe(timeoutFor('fetchEnvelope'));
    expect(CONNECTIVITY.REQUEST_TIMEOUT_MS).toBe(timeoutFor('probe'));
    expect(ADAPTER.POLL_INTERVAL_MS).toBe(pollEveryFor('hydration'));
    expect(ADAPTER.NAV_SETTLE_MS).toBe(pollEveryFor('nav'));
    expect(RIM.NOTIFICATIONS_POLL_MS).toBe(pollEveryFor('control'));
    expect(RIM.ACCEPT_VERIFY_POLL_MS).toBe(pollEveryFor('acceptRow'));
  });

  test('D5: the streak constants are Bayesian posteriors, not tastes', () => {
    expect(RECOVERY.REENTRY_FAILS).toBe(reentryFailThreshold());
    expect(RECOVERY.BLOCKED_STREAK_ENTRY).toBe(blockedStreakThreshold());
    expect(RECOVERY.WALLED_CYCLES_ENTRY).toBe(blockedStreakThreshold());
    expect(RIM.LIST_WALK_STAGNANT_STOP).toBe(stagnantPageThreshold());
  });

  test('one gap cap sizes the step watchdog', () => {
    expect(SESSION.GAP_CAP_MS).toBe(gapCapMs());
    expect(RECOVERY.STEP_WATCHDOG_MS).toBe(SESSION.GAP_CAP_MS);
  });

  test('the HARNESS group is the one that is NOT derived, and says so', () => {
    for (const [key, tier] of Object.entries(PROVENANCE)) {
      expect(`${key}:${tier === 'harness'}`).toBe(`${key}:${key.startsWith('HARNESS.')}`);
    }
  });
});

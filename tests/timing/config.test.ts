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
    expect(ENGINE.REFILL_PACING_MIN_MS).toBe(2_000);
    expect(ENGINE.REFILL_PACING_MAX_MS).toBe(5_000);
    expect(PRUNE.DELAY_FACTOR).toBeCloseTo(1 / 3);
    expect(PRUNE.PARK_MS).toBe(30_000);
    // 6h (was 15 min): the run's live-graph guard skips post-scan follow-backs
    // per candidate, so freshness no longer needs to be the safety mechanism.
    expect(PRUNE.SCAN_FRESH_MS).toBe(4 * 24 * 3600_000);
    expect(PRUNE.PARK_TIMEOUT_MS).toBe(90_000);
    expect(CONNECTIVITY.PROBE_INTERVAL_MS).toBe(20_000);
    expect(CONNECTIVITY.REQUEST_TIMEOUT_MS).toBe(5_000);
    expect(SCHEDULER.AUTO_PRUNE_CHECK_MS).toBe(30 * 60_000);
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
    expect(ENGINE.REFILL_PACING_MIN_MS).toBeLessThanOrEqual(ENGINE.REFILL_PACING_MAX_MS);
    expect(HARNESS.OP_DELAY_MIN_MS).toBeLessThanOrEqual(HARNESS.OP_DELAY_MAX_MS);
    expect(HARNESS.ENRICH_PACE_MIN_MS).toBeLessThanOrEqual(HARNESS.ENRICH_PACE_MAX_MS);
    expect(RIM.NOTIFICATIONS_SCROLL_WAIT_MIN_MS).toBeLessThanOrEqual(
      RIM.NOTIFICATIONS_SCROLL_WAIT_MAX_MS,
    );
    expect(RIM.NOTIFICATIONS_CLOSE_DELAY_MIN_MS).toBeLessThanOrEqual(
      RIM.NOTIFICATIONS_CLOSE_DELAY_MAX_MS,
    );
    expect(RIM.ACQUIRE_SCROLL_MIN_MS).toBeLessThanOrEqual(RIM.ACQUIRE_SCROLL_MAX_MS);
    expect(NOISE.CADENCE_MIN_FACTOR).toBeLessThanOrEqual(NOISE.CADENCE_MAX_FACTOR);
    expect(NOISE.BACKOFF_MIN_FACTOR).toBeLessThanOrEqual(NOISE.BACKOFF_MAX_FACTOR);
    expect(NOISE.BEAT_MIN_FACTOR).toBeLessThanOrEqual(NOISE.BEAT_MAX_FACTOR);
    expect(NOISE.LIST_WALK_REST_EVERY_MIN).toBeLessThanOrEqual(NOISE.LIST_WALK_REST_EVERY_MAX);
  });

  test('noise-layer invariants: positive jitter ceilings, park-preserving floors', () => {
    expect(NOISE.DAILY_BOUNDARY_JITTER_MAX_MS).toBeGreaterThan(0);
    expect(NOISE.PRUNE_LAUNCH_JITTER_MAX_MS).toBeGreaterThan(0);
    expect(NOISE.BACKOFF_MIN_FACTOR).toBeGreaterThan(0); // a park always stays a park
    expect(NOISE.BEAT_MIN_FACTOR).toBeGreaterThan(0);
    expect(NOISE.CADENCE_MIN_FACTOR).toBeGreaterThan(0);
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
    // One policy number (DESYNC_WIDTH_MS) sets the daily-boundary jitter and,
    // through the clamp band, the three log-normal spreads.
    expect(NOISE.DAILY_BOUNDARY_JITTER_MAX_MS).toBe(POLICY.DESYNC_WIDTH_MS);
    expect(NOISE.PRUNE_LAUNCH_JITTER_MAX_MS).toBe(POLICY.DESYNC_WIDTH_MS / 2);
    expect(NOISE.CADENCE_SIGMA).toBe(NOISE.BACKOFF_SIGMA);
    expect(ENGINE.VELOCITY_PARK_SIGMA).toBe(NOISE.BACKOFF_SIGMA);
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

  test('one gap cap sizes the velocity park AND the step watchdog', () => {
    expect(SESSION.GAP_CAP_MS).toBe(gapCapMs());
    expect(ENGINE.VELOCITY_PARK_MEDIAN_MS).toBe(SESSION.GAP_CAP_MS);
    expect(RECOVERY.STEP_WATCHDOG_MS).toBe(SESSION.GAP_CAP_MS);
  });

  test('the HARNESS group is the one that is NOT derived, and says so', () => {
    for (const [key, tier] of Object.entries(PROVENANCE)) {
      expect(`${key}:${tier === 'harness'}`).toBe(`${key}:${key.startsWith('HARNESS.')}`);
    }
  });
});

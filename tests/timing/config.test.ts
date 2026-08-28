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

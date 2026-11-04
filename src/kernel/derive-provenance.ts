/**
 * The accounting: which tier every leaf key of the timing registry came from.
 *
 * Kept beside the derivations (not inside them) because it is a LEDGER, not a
 * computation — and because a test asserts it covers `src/timing/config.ts`
 * exactly, so a new constant cannot be added without saying where it came from.
 *
 * Layering: `src/kernel/**` imports NOTHING from the rest of `src/`.
 *
 * See docs/adr/0605-constants-derive-from-fundamentals.md for the tier
 * definitions and docs/adr/0606-derivation-findings.md for the override list;
 * the keys the day plan retired are in `registry-changes.ts` (ADR 0607).
 */


/** How a constant got its value. */
export type Tier = 'derived' | 'policy' | 'override' | 'harness';

/**
 * Tier per `GROUP.KEY` of the registry above. Kept beside the derivations so a
 * new key cannot be added without saying where it came from — the test asserts
 * this map covers every exported key exactly.
 */
export const PROVENANCE: Readonly<Record<string, Tier>> = {
  'ENGINE.IDLE_MS': 'policy',
  'ENGINE.ENRICH_BACKOFF_MS': 'policy',
  'PRUNE.PARK_MS': 'policy',
  'PRUNE.PARK_TIMEOUT_MS': 'policy',
  'CONNECTIVITY.PROBE_INTERVAL_MS': 'policy',
  'CONNECTIVITY.REQUEST_TIMEOUT_MS': 'derived',
  'SCHEDULER.USERNAME_RESOLVE_RETRY_MS': 'derived',
  'SCHEDULER.USERNAME_RESOLVE_ATTEMPTS': 'policy',
  'SCHEDULER.MANUAL_OP_DRAIN_TIMEOUT_MS': 'derived',
  'ADAPTER.POLL_INTERVAL_MS': 'derived',
  'ADAPTER.POLL_TIMEOUT_MS': 'derived',
  'ADAPTER.MUTATION_RESPONSE_TIMEOUT_MS': 'derived',
  'ADAPTER.IDENTITY_ATTEMPTS': 'policy',
  'ADAPTER.IDENTITY_RETRY_MS': 'override',
  'ADAPTER.NAV_SETTLE_ROUNDS': 'policy',
  'ADAPTER.NAV_SETTLE_MS': 'derived',
  'ADAPTER.PROFILE_LAND_ATTEMPTS': 'policy',
  'ADAPTER.PROFILE_LAND_RETRY_MS': 'derived',
  'TAB.GOTO_TIMEOUT_MS': 'derived',
  'TAB.EVALUATE_TIMEOUT_MS': 'derived',
  'TAB.GET_BODY_TIMEOUT_MS': 'derived',
  'TAB.FETCH_ABORT_MS': 'derived',
  'TAB.TEARDOWN_ENGINE_WAIT_MS': 'policy',
  'RECOVERY.STEP_WATCHDOG_MS': 'derived',
  'RECOVERY.STEP_WATCHDOG_CHECK_MS': 'derived',
  'RECOVERY.HOLD_MEDIANS_MS': 'override',
  'RECOVERY.HOLD_SIGMA': 'derived',
  'RECOVERY.HOLD_MIN_FACTOR': 'derived',
  'RECOVERY.HOLD_MAX_FACTOR': 'derived',
  'RECOVERY.MAX_HOLDS': 'derived',
  'RECOVERY.REENTRY_FAILS': 'derived',
  'RECOVERY.BLOCKED_STREAK_ENTRY': 'derived',
  'RECOVERY.WALLED_CYCLES_ENTRY': 'derived',
  'RECOVERY.CANARY_WINDOW_MS': 'derived',
  'RECOVERY.PRUNE_COOLDOWN_AFTER_RATE_HALT_MS': 'derived',
  'RECOVERY.TAB_EVENT_DEBOUNCE_MS': 'policy',
  'RECOVERY.RESUME_SETTLE_MIN_MS': 'override',
  'RECOVERY.RESUME_SETTLE_MAX_MS': 'override',
  'RECOVERY.EXHAUSTED_REVERIFY_WINDOW_MS': 'derived',
  'RECOVERY.HEAL_MAX_RECORDS': 'policy',
  'RECOVERY.HEAL_GRACE_MS': 'policy',
  'RIM.SCROLL_WAIT_MS': 'policy',
  'RIM.FETCH_ALL_MAX_ROUNDS': 'policy',
  'RIM.FETCH_ALL_NO_NEW_STOP': 'policy',
  'RIM.ACQUIRE_NO_NEW_STOP': 'policy',
  'RIM.ACQUIRE_SCROLL_MIN_MS': 'override',
  'RIM.ACQUIRE_SCROLL_MAX_MS': 'override',
  'RIM.LIST_WALK_MAX_PAGES': 'policy',
  'RIM.LIST_WALK_PAGE_MIN_MS': 'override',
  'RIM.LIST_WALK_PAGE_MAX_MS': 'override',
  'RIM.LIST_WALK_REST_MIN_MS': 'override',
  'RIM.LIST_WALK_REST_MAX_MS': 'override',
  'RIM.LIST_WALK_STAGNANT_STOP': 'derived',
  'RIM.NOTIFICATIONS_WAIT_MS': 'derived',
  'RIM.NOTIFICATIONS_CLOSE_DELAY_MIN_MS': 'override',
  'RIM.NOTIFICATIONS_CLOSE_DELAY_MAX_MS': 'override',
  'RIM.REQUEST_ACCEPT_CAP': 'policy',
  'RIM.NOTIFICATIONS_SCROLL_ROUNDS': 'policy',
  'RIM.NOTIFICATIONS_SCROLL_WAIT_MIN_MS': 'override',
  'RIM.NOTIFICATIONS_SCROLL_WAIT_MAX_MS': 'override',
  'RIM.NOTIFICATIONS_POLL_MS': 'derived',
  'RIM.ACCEPT_VERIFY_MS': 'derived',
  'RIM.ACCEPT_VERIFY_POLL_MS': 'derived',
  'RIM.ACCEPT_PACE_MIN_MS': 'override',
  'RIM.ACCEPT_PACE_MAX_MS': 'override',
  'NOISE.BACKOFF_SIGMA': 'derived',
  'NOISE.BACKOFF_MIN_FACTOR': 'policy',
  'NOISE.BACKOFF_MAX_FACTOR': 'policy',
  'NOISE.BEAT_MIN_FACTOR': 'policy',
  'NOISE.BEAT_MAX_FACTOR': 'policy',
  'NOISE.LIST_WALK_REST_EVERY_MIN': 'policy',
  'NOISE.LIST_WALK_REST_EVERY_MAX': 'policy',
  'POLL.KEEPALIVE_MS': 'policy',
  'POLL.GRAPH_PUSH_THROTTLE_MS': 'derived',
  'HARNESS.LOGIN_POLL_MS': 'harness',
  'HARNESS.DIALOG_SWEEP_MS': 'harness',
  'HARNESS.INSPECT_POLL_MS': 'harness',
  'HARNESS.CAPTURE_NAV_SETTLE_MS': 'harness',
  'HARNESS.CAPTURE_DIALOG_SETTLE_MS': 'harness',
  'HARNESS.CAPTURE_SHORT_SETTLE_MS': 'harness',
  'HARNESS.OP_DELAY_MIN_MS': 'harness',
  'HARNESS.OP_DELAY_MAX_MS': 'harness',
  'HARNESS.ENRICH_PACE_MIN_MS': 'harness',
  'HARNESS.ENRICH_PACE_MAX_MS': 'harness',
  'HARNESS.FOLLOW_UNFOLLOW_GAP_MS': 'harness',
  'CIRCADIAN.BUMPS': 'derived',
  'CIRCADIAN.OVERNIGHT_FLOOR': 'derived',
  'CIRCADIAN.DAY_OF_WEEK_WEIGHTS': 'derived',
  'CIRCADIAN.WEEKEND_SHIFT_HOURS': 'derived',
  'CIRCADIAN.PHASE_JITTER_MAX_HOURS': 'policy',
  'SESSION.GAP_SIGMA': 'derived',
  'SESSION.GAP_CAP_MS': 'derived',
  'SESSION.SESSION_BOUNDARY_MS': 'derived',
  'SESSION.HAWKES_ALPHA': 'derived',
  'SESSION.HAWKES_TAU_MS': 'derived',
  'PATTERN.REST_DAY_MAX_FRACTION': 'policy',
  'PATTERN.CYCLE_PLAN_MIN_FRACTION': 'policy',
  'PATTERN.CYCLE_PLAN_MAX_FRACTION': 'policy',
  'PATTERN.CYCLE_PLAN_MIN_CAP': 'policy',
  'PATTERN.MAX_UNFOLLOW_FRACTION_PER_SESSION': 'policy',
  'UPDATER.CHECK_INTERVAL_MS': 'policy',
};

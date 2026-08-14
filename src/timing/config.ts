/**
 * The timing constant registry — every fixed operational timing value in one
 * place, grouped by subsystem, each with a one-line rationale. USER-configurable
 * timing stays in `settings/settings.ts` (one home per kind of value); renderer
 * PRESENTATIONAL timing stays in `renderer/lib/motion.ts`.
 *
 * Node-free by design: the renderer imports `POLL` from here too.
 */

export const ENGINE = {
  /** How long an iteration idles when nothing is due yet (§3.1, final branch). */
  IDLE_MS: 30_000,
  /** f10: bounds of the short jittered pause ending every branch that issued IG traffic. */
  REFILL_PACING_MIN_MS: 2_000,
  REFILL_PACING_MAX_MS: 5_000,
} as const;

export const PRUNE = {
  /** Prune unfollows run at a THIRD of growth's humanized pace (deliberate bulk cleanup). */
  DELAY_FACTOR: 1 / 3,
  /** Brief park after a blocked action / closed budget before continuing. */
  PARK_MS: 30_000,
  /** How long a completed scan's candidate set stays runnable for a 2-step run. */
  SCAN_FRESH_MS: 15 * 60_000,
  /** How long the prune hand-off waits for the growth loop to park before aborting. */
  PARK_TIMEOUT_MS: 90_000,
} as const;

export const CONNECTIVITY = {
  /** Probe cadence — cheap 204 endpoint, frequent enough to park the engine promptly. */
  PROBE_INTERVAL_MS: 20_000,
  /** Per-probe deadline; `net.request` has no built-in timeout. */
  REQUEST_TIMEOUT_MS: 5_000,
} as const;

export const SCHEDULER = {
  /** How often the opt-in scheduled-prune watcher re-checks `pruneDue`. */
  AUTO_PRUNE_CHECK_MS: 30 * 60_000,
  /** R5: wait between own-username resolution attempts. */
  USERNAME_RESOLVE_RETRY_MS: 1_500,
  /** R5: how many username resolution attempts before degrading. */
  USERNAME_RESOLVE_ATTEMPTS: 4,
} as const;

export const ADAPTER = {
  /** Poll interval while waiting for a dialog / confirm control. */
  POLL_INTERVAL_MS: 250,
  /** Total wait before declaring a control absent. */
  POLL_TIMEOUT_MS: 8_000,
  /** identity.ts: attempts × retry wait for own-username resolution. */
  IDENTITY_ATTEMPTS: 4,
  IDENTITY_RETRY_MS: 1_200,
  /** identity.ts: nav-settle poll — rounds × per-round wait ≈ 4.5 s ceiling. */
  NAV_SETTLE_ROUNDS: 15,
  NAV_SETTLE_MS: 300,
} as const;

export const RIM = {
  /** Fixed pause after each scroll so the paginated response can land (growth path). */
  SCROLL_WAIT_MS: 2_000,
  /** Pause between profile-info fetches so an enrichment pass can't hammer. */
  ENRICH_PACE_MS: 1_000,
  /** Whole-list scrape bounds (prune census): generous but always finite. */
  FETCH_ALL_MAX_ROUNDS: 60,
  FETCH_ALL_NO_NEW_STOP: 3,
  /** Follow-back sweep scrape bounds (request-bounded page walk). */
  SWEEP_MAX_ROUNDS: 10,
  SWEEP_NO_NEW_STOP: 2,
  /** Follower-acquisition scrape bounds (one refill slice). */
  ACQUIRE_MAX_ROUNDS: 5,
  ACQUIRE_NO_NEW_STOP: 2,
} as const;

export const POLL = {
  /** Renderer keep-alive: pull only when the push stream has gone this quiet (§4). */
  KEEPALIVE_MS: 10_000,
} as const;

export const HARNESS = {
  /** Dev harnesses (livetest / capture / inspect): login-state poll cadence. */
  LOGIN_POLL_MS: 2_000,
  /** capture: dialog sweep interval. */
  DIALOG_SWEEP_MS: 2_000,
  /** inspect: DOM poll cadence. */
  INSPECT_POLL_MS: 300,
  /** capture: fixed navigation settles (long / dialog / short). */
  CAPTURE_NAV_SETTLE_MS: 4_000,
  CAPTURE_DIALOG_SETTLE_MS: 2_500,
  CAPTURE_SHORT_SETTLE_MS: 1_500,
  /** livetest defaults (env-overridable in steps.ts): humanized op delay band. */
  OP_DELAY_MIN_MS: 4_000,
  OP_DELAY_MAX_MS: 9_000,
  /** livetest defaults: enrichment pacing band. */
  ENRICH_PACE_MIN_MS: 3_000,
  ENRICH_PACE_MAX_MS: 5_000,
  /** livetest default: follow→unfollow gap before the multiplicative jitter. */
  FOLLOW_UNFOLLOW_GAP_MS: 45_000,
} as const;

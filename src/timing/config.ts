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
  /**
   * Park after an enrichment-starved refill cycle (a plan that queued nothing
   * while un-enriched candidates remain — a rate wall / sentinel window, not a
   * dry target). Long, so repeated walled cycles cannot hammer the profile
   * endpoint; the target is retried, never burned.
   */
  ENRICH_BACKOFF_MS: 10 * 60_000,
  /** Velocity-backstop park (organic mode): log-normal pause when the ledger-backed
   *  rolling-hour cap trips — long enough to drain the window, jittered so repeated
   *  parks never tick at a fixed period. */
  VELOCITY_PARK_MEDIAN_MS: 8 * 60_000,
  VELOCITY_PARK_SIGMA: 0.3,
  VELOCITY_PARK_MIN_MS: 5 * 60_000,
  VELOCITY_PARK_MAX_MS: 15 * 60_000,
} as const;

export const PRUNE = {
  /** Prune unfollows run at a THIRD of growth's inter-action pace (deliberate bulk cleanup). */
  DELAY_FACTOR: 1 / 3,
  /** Brief park after a blocked action before continuing. */
  PARK_MS: 30_000,
  /**
   * How long a completed scan's candidate set stays runnable for a 2-step run.
   * Generous — 4 days (was 15 min, then 6 h; both expired while users reviewed
   * the list or let the weave drain it, graying Run and blanking candidates):
   * the run's LIVE-GRAPH guard skips any candidate whose follows-us edge
   * appeared after the scan, so staleness in the dangerous direction is caught
   * per candidate, not by expiry.
   */
  SCAN_FRESH_MS: 4 * 24 * 3600_000,
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
  /**
   * Backoff between username-recovery attempts once a graph is built DEGRADED:
   * each attempt costs real tab navigations + `current_user` fetches, so it
   * must never run on every routine IPC read.
   */
  USERNAME_REBUILD_BACKOFF_MS: 5 * 60_000,
  /** teardownGraph: bounded wait for in-flight manual ops (scrapes, single
   *  follow/unfollow clicks) to drain before the store closes under them. */
  MANUAL_OP_DRAIN_TIMEOUT_MS: 15_000,
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
  /**
   * identity.ts `landOnOwnProfile`: how long startup polls for the nav profile
   * link before giving up (~30 s covers a slow session-restore hydration; a
   * logged-out tab just quietly stays on the login page).
   */
  PROFILE_LAND_ATTEMPTS: 20,
  PROFILE_LAND_RETRY_MS: 1_500,
} as const;

export const TAB = {
  /** goto: deadline on `webContents.loadURL` — a wedged renderer must never park the caller forever. */
  GOTO_TIMEOUT_MS: 30_000,
  /** evaluate: deadline on `executeJavaScript` — in-page scripts settle sub-second when the page is alive. */
  EVALUATE_TIMEOUT_MS: 15_000,
  /** getBody: deadline on CDP `Network.getResponseBody` — a resource-cache read, normally instant. */
  GET_BODY_TIMEOUT_MS: 10_000,
  /** In-page envelope fetch abort budget. Inlined as a literal in the versions
   *  file (page scripts can't import) — keep `envelopeFetchScript` in sync. */
  FETCH_ABORT_MS: 20_000,
  /** Teardown/restart: bounded wait for the engine loop's exit — quit must never hang behind a wedged loop. */
  TEARDOWN_ENGINE_WAIT_MS: 15_000,
} as const;

export const RECOVERY = {
  /** engine:step-watchdog — a 'running' engine that has emitted no status AND holds
   *  no pending `engine:` wait for this long is wedged, not parked. */
  STEP_WATCHDOG_MS: 8 * 60_000,
  /** How often the step watchdog evaluates its fire predicate (cheap in-memory checks). */
  STEP_WATCHDOG_CHECK_MS: 60_000,
} as const;

export const RIM = {
  /** Fixed pause after each scroll so the paginated response can land (growth path). */
  SCROLL_WAIT_MS: 2_000,
  /**
   * Jittered pause between profile-info fetches. An enrichment pass is the
   * app's largest read burst (up to a batch of fetches back-to-back); pacing
   * each one 2.5–4.5 s keeps a full pass around a minute instead of a
   * 20-requests-in-20-seconds spike.
   */
  ENRICH_PACE_MIN_MS: 2_500,
  ENRICH_PACE_MAX_MS: 4_500,
  /** Whole-list scrape bounds (prune census): generous but always finite —
   *  pages carry ~12 accounts, so thousands of followers need hundreds of
   *  rounds; `hasMore`/stagnation are the real terminators. */
  FETCH_ALL_MAX_ROUNDS: 400,
  FETCH_ALL_NO_NEW_STOP: 5,
  /** Follower-acquisition scrape bounds (one refill slice). */
  ACQUIRE_MAX_ROUNDS: 5,
  ACQUIRE_NO_NEW_STOP: 2,
  /**
   * Direct list-page walk (prune census): runaway page bound (~200 × 50-user
   * pages = 10k accounts) and default per-page pacing when the caller supplies
   * none. `hasMore === false` is the real terminator.
   */
  LIST_WALK_MAX_PAGES: 200,
  LIST_WALK_PAGE_MIN_MS: 1_000,
  LIST_WALK_PAGE_MAX_MS: 3_000,
  /** Every Nth page the walk takes a long jittered rest (anti-throttle breather). */
  LIST_WALK_REST_EVERY: 7,
  LIST_WALK_REST_MIN_MS: 5_000,
  LIST_WALK_REST_MAX_MS: 15_000,
  /** Consecutive zero-new-pk pages tolerated (duplicate windows) before stopping. */
  LIST_WALK_STAGNANT_STOP: 3,
  /**
   * How long the follow-back watcher's notifications source waits for the
   * news-inbox response after clicking the bell before declaring the read
   * failed (the drawer fetch normally lands within a second or two).
   */
  NOTIFICATIONS_WAIT_MS: 10_000,
  /** Brief settle before toggling the notifications drawer closed again. */
  NOTIFICATIONS_CLOSE_DELAY_MS: 800,
  /** Max follow requests auto-accepted per notifications check (bounded write burst). */
  REQUEST_ACCEPT_CAP: 20,
  /** Max drawer-scroll rounds per check (each may load an older feed page). */
  NOTIFICATIONS_SCROLL_ROUNDS: 2,
  /** How long to wait after a drawer scroll for an older feed page to land. */
  NOTIFICATIONS_SCROLL_WAIT_MS: 2_000,
  /** Poll interval while waiting for the captured inbox response to parse. */
  NOTIFICATIONS_POLL_MS: 150,
  /** Deadline + poll interval for verifying an accept click consumed its row. */
  ACCEPT_VERIFY_MS: 4_000,
  ACCEPT_VERIFY_POLL_MS: 200,
  /** Jittered pause between Confirm clicks while accepting follow requests. */
  ACCEPT_PACE_MIN_MS: 1_500,
  ACCEPT_PACE_MAX_MS: 3_000,
} as const;

export const POLL = {
  /** Renderer keep-alive: pull only when the push stream has gone this quiet (§4). */
  KEEPALIVE_MS: 10_000,
  /**
   * Trailing throttle for graph-mutation-driven status pushes (docs/
   * PRINCIPLES.md §2): facts stream into the store per row during scans/
   * sweeps, and every burst of writes coalesces into one fresh projection
   * push at most this often — live enough that counts visibly tick, cheap
   * enough that a thousand-row walk doesn't emit a thousand statuses.
   */
  GRAPH_PUSH_THROTTLE_MS: 300,
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
  /** livetest defaults (env-overridable in steps.ts): paced op delay band. */
  OP_DELAY_MIN_MS: 4_000,
  OP_DELAY_MAX_MS: 9_000,
  /** livetest defaults: enrichment pacing band. */
  ENRICH_PACE_MIN_MS: 3_000,
  ENRICH_PACE_MAX_MS: 5_000,
  /** livetest default: follow→unfollow gap before the multiplicative jitter. */
  FOLLOW_UNFOLLOW_GAP_MS: 45_000,
} as const;

// ---------------------------------------------------------------------------------
// Organic macro-timing model (docs/superpowers/plans/2026-08-15-macro-timing-realism.md).
// The circadian field, session structure, and daily-pattern parameters that make the
// emitted action/read timeline look like organic data instead of a flat metronome.
// Every value carries a one-line "why", cited to the research or the IG safety envelope.
// ---------------------------------------------------------------------------------

export const CIRCADIAN = {
  /** Sum-of-Gaussians daily shape: morning-commute, lunch, dominant evening peak. */
  BUMPS: [
    { centerHour: 8.0, amplitude: 0.45, widthHours: 1.6 }, // morning-commute peak (~7:30–9:00)
    { centerHour: 13.0, amplitude: 0.5, widthHours: 2.0 }, // lunch bump (~12:00–13:00)
    { centerHour: 18.0, amplitude: 1.0, widthHours: 3.0 }, // dominant evening peak (~17:00–18:30)
  ],
  /** λ never fully zero — real traces have rare 3am actions; an exact-zero night is a machine edge. */
  OVERNIGHT_FLOOR: 0.015,
  /** Sun..Sat weekly seasonality: mid-week hot, Fri resurgence, weekend dip (diurnal-corpus studies). */
  DAY_OF_WEEK_WEIGHTS: [0.9, 1.0, 1.08, 1.08, 1.0, 1.02, 0.92],
  /** On Sat/Sun the whole curve shifts this many hours later. */
  WEEKEND_SHIFT_HOURS: 1.4,
  /** Per-install horizontal jitter (hours) so no two installs share an identical curve. */
  PHASE_JITTER_MAX_HOURS: 1.5,
} as const;

/**
 * NB: the PER-LEVEL pacing values (sessions/day, gap median/floor, rolling-hour
 * cap, day-volume variance, rest-day probability) are NOT here — they vary by
 * qualitative knob and live in their single home, the level tables of
 * `settings/pattern-map.ts` (RHYTHM / CAUTION / VARIANCE_PCT / REST_DAY_PCT).
 * SESSION/PATTERN hold only the level-independent constants.
 */
export const SESSION = {
  /** Within-session gap log-space spread; larger = heavier tail (WWW-2015 cluster shape). */
  GAP_SIGMA: 0.75,
  /** Cap keeps the within-session log-normal tail sane. */
  GAP_CAP_MS: 8 * 60_000,
  /** A gap larger than this counts as a new session (Catledge & Pitkow 1995 / GA4 default). */
  SESSION_BOUNDARY_MS: 30 * 60_000,
  /** Exponential self-excitation kernel: effective branching ratio n≈α<1 (sub-critical/stable),
   *  decaying over ~1.5 min — creates within-session clustering that winds down (Hawkes). */
  HAWKES_ALPHA: 0.35,
  HAWKES_TAU_MS: 90_000,
} as const;

export const PATTERN = {
  /** A rest day is near-zero, not exactly zero. */
  REST_DAY_MAX_FRACTION: 0.15,
  /**
   * Band for the per-cycle volume plan (timing/cycle-plan.ts): each active-hours
   * cycle draws its day plan uniformly in [MIN, MAX] × the configured cap, so
   * the amount done per day fluctuates just under the cap instead of hitting
   * the exact same number every day. The cap itself stays the hard limit.
   */
  CYCLE_PLAN_MIN_FRACTION: 0.85,
  CYCLE_PLAN_MAX_FRACTION: 0.97,
  /** Below this cap the rounding granularity makes an under-shoot either a
   *  no-op or brutal (a cap of 2 would halve) — tiny caps pass through. */
  CYCLE_PLAN_MIN_CAP: 10,
  /** Keep any single session from being unfollow-dominated (mix within a burst — NOT an
   *  aggregate follow:unfollow ratio; the churn lifecycle legitimately runs ~1:1). */
  MAX_UNFOLLOW_FRACTION_PER_SESSION: 0.5,
} as const;

export const UPDATER = {
  /** Update-feed check cadence; the launch check covers work due while closed. */
  CHECK_INTERVAL_MS: 6 * 3600_000,
} as const;

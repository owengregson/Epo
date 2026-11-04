/**
 * Tier 1 — the choices we make.
 *
 * Two kinds of number live here and nothing else:
 *
 * 1. {@link POLICY} — the handful of dials the owner argues about. Every derived
 *    constant in `derive.ts` is a function of {@link EMPIRICAL} × these.
 * 2. {@link BOUNDS} — genuine bounds that NO measurement produces: "never more
 *    than N", "give up after N rounds", "a rest day is not literally zero". They
 *    are *allowed* to be arbitrary because they are guardrails, not physics —
 *    but each one still gets a line saying what it guards against.
 *
 * Also here: the ORDINAL SCALES. A qualitative knob ("cautious / standard /
 * bold") is a choice about how far apart the rungs sit, not a measurement; the
 * quantity each rung multiplies IS measured, and lives in `fundamentals.ts`.
 *
 * Layering: `src/kernel/**` imports NOTHING from the rest of `src/`.
 *
 * See docs/adr/0605-constants-derive-from-fundamentals.md.
 */

const SEC = 1_000;
const MIN = 60_000;
const HOUR = 3_600_000;

/**
 * The five numbers the owner argues about, plus the three shape choices the
 * recovery ladder needs. Changing one of these moves a whole family of derived
 * constants at once — which is the point.
 */
export const POLICY = {
  /** Fraction of the TYPICAL observed wall we choose to operate at. THE dial. */
  SAFETY_MARGIN: 0.37,
  /** How wide any de-synchronising jitter must spread installs apart. */
  DESYNC_WIDTH_MS: 40 * MIN,
  /** Fastest instantaneous rate, as a multiple of the sustained hourly cap. */
  BURST_TOLERANCE: 3.7,
  /** A deadline is the operation's p99 times this. */
  TIMEOUT_SLACK: 1.5,
  /** Posterior confidence required before declaring breakage systemic. */
  CONFIDENCE: 0.9,

  /** First ladder rung as a fraction of the p50 soft wall (probe early, cheaply). */
  LADDER_START_FRACTION: 0.33,
  /** Geometric growth between ladder rungs. */
  LADDER_GROWTH: 1.5,
  /**
   * Which soft-wall percentile the ladder must outlast. 'p50' is a PRODUCT choice:
   * a 24-hour wall should surface as a halt, not be silently waited out. 'p90'
   * derives a 7-rung ladder. (Open question 2 in the v4 design.)
   */
  LADDER_COVERS: 'p50',
  /** Share of the header count a census side must list before its ABSENCES are verdicts. */
  CENSUS_ABSENCE_COVERAGE: 0.98,

  /** Central mass a bounded log-normal draw keeps; the clamp trims the rest. */
  DRAW_CENTRAL_Z: 1.96,
  /** z for the 99th percentile — sizes a sigma against its clamp band. */
  DRAW_TAIL_Z: 2.326,

  /** Hard ceiling as a fraction above the daily operating rate. */
  CEILING_HEADROOM: 1.3,
  /** Candidates queued per plan, as a fraction above the daily follow target. */
  PLAN_BUFFER: 1.2,
  /** A within-session gap draw must never on its own END the session. */
  GAP_CAP_FRACTION: 0.27,

  /**
   * Half-width of every UNIFORM pacing band, as a fraction of its base: narrow enough
   * to stay recognisably "a pause of about N", wide enough that it is never a period.
   */
  BAND_HALF_WIDTH: 0.286,

  /**
   * Prior probability that a failure streak is SYSTEMIC rather than ordinary bad
   * luck, given where we are. Feeds the Bayesian breaker thresholds — see
   * `derive.ts` `breakerThreshold`.
   */
  PRIOR_SYSTEMIC: {
    /** Running fine, no prior signal. */
    cold: 0.005,
    /** Probing right after a served recovery hold — we already suspect a wall. */
    afterHold: 0.6,
    /** A blocked/refused outcome carries its own weak evidence. */
    signalled: 0.02,
  },
} as const;

/** Ordinal scales: how far apart the rungs of each qualitative knob sit. */
export const SCALES = {
  /** Multiplies the hourly wall × margin → 14 / 22 / 30 actions per hour. */
  caution: { cautious: 0.64, standard: 1.0, bold: 1.36 },
  /** Multiplies the daily wall × margin → 15 / 30 / 50 / 75 / 100 follows/day. */
  activity: { minimal: 0.27, light: 0.54, moderate: 0.9, active: 1.35, aggressive: 1.8 },
  /** Multiplies the human within-session gap median → 180 / 95 / 55 s. */
  rhythm: { trickle: 1.9, sessions: 1.0, bursts: 0.58 },
  /** Multiplies the human day-volume CV → 12 / 28 / 45 %. */
  consistency: { clockwork: 0.43, natural: 1.0, erratic: 1.61 },
  /** Multiplies the human rest-day rate → 0 / 8 / 18 %. */
  restDay: { clockwork: 0, natural: 1.0, erratic: 2.25 },
  /**
   * Where each rhythm's session count sits inside the human 2..9 range, as
   * [lowEnd, highEnd] fractions → trickle 5–9, sessions 3–6, bursts 2–4.
   */
  sessionsWindow: {
    trickle: [0.43, 1.0],
    sessions: [0.14, 0.57],
    bursts: [0.0, 0.29],
  },
} as const;

/**
 * Genuine bounds. No measurement produces these; each is a guardrail with a
 * stated failure mode. Grouped by the `timing/config.ts` group they land in so
 * the shim reads as one table.
 */
export const BOUNDS = {
  ENGINE: {
    /** Coarsest granularity at which a due deadline may be late — the loop's final gate. */
    IDLE_MS: 30 * SEC,
    /** Park after an enrichment-starved refill cycle, so walled cycles cannot hammer the profile endpoint. */
    ENRICH_BACKOFF_MS: 10 * MIN,
  },
  PRUNE: {
    /** Brief park after a blocked action before continuing. */
    PARK_MS: 30 * SEC,
    /** How long the prune hand-off waits for the growth loop to park before aborting. */
    PARK_TIMEOUT_MS: 90 * SEC,
  },
  CONNECTIVITY: {
    /** Probe cadence — frequent enough to park the engine promptly, cheap enough to ignore. */
    PROBE_INTERVAL_MS: 20 * SEC,
  },
  SCHEDULER: {
    /** Attempts before own-username resolution degrades the graph. */
    USERNAME_RESOLVE_ATTEMPTS: 4,
  },
  ADAPTER: {
    /** identity.ts: attempts before own-username resolution gives up. */
    IDENTITY_ATTEMPTS: 4,
    /** identity.ts: nav-settle polling rounds. */
    NAV_SETTLE_ROUNDS: 15,
    /** identity.ts `landOnOwnProfile`: startup polls for the nav profile link this many times. */
    PROFILE_LAND_ATTEMPTS: 20,
  },
  TAB: {
    /** Teardown/restart: quit must never hang behind a wedged loop. */
    TEARDOWN_ENGINE_WAIT_MS: 15 * SEC,
  },
  RECOVERY: {
    /**
     * Tab-health events (debugger detach, renderer gone, input fallback) coalesce
     * into at most ONE recovery attempt per window: a crashing renderer emits a
     * burst, and each recovery is itself a reload + debugger re-attach.
     */
    TAB_EVENT_DEBOUNCE_MS: 1 * MIN,
    /**
     * The most `abandoned` records one closed incident window may requeue. A
     * genuine window abandons a handful; a window claiming hundreds means the
     * timestamps are wrong, and mass-mutating history on it repeats the damage.
     */
    HEAL_MAX_RECORDS: 200,
    /**
     * The incident window opens this much BEFORE the ladder's `enteredAt`: the
     * records the entry streak abandoned are stamped minutes before the ladder
     * woke up. Wider would claim records abandoned by earlier, unrelated causes.
     */
    HEAL_GRACE_MS: 1 * HOUR,
  },
  RIM: {
    /** Fixed pause after each scroll so the paginated response can land (growth path). */
    SCROLL_WAIT_MS: 2 * SEC,
    /** Whole-list scrape runaway bound; `hasMore`/stagnation are the real terminators. */
    FETCH_ALL_MAX_ROUNDS: 400,
    /** Consecutive no-new-item rounds before a whole-list scrape stops. */
    FETCH_ALL_NO_NEW_STOP: 5,
    /** Consecutive no-new-item rounds before an acquisition slice stops. */
    ACQUIRE_NO_NEW_STOP: 2,
    /** Direct list-page walk runaway bound (~200 × 50-user pages = 10k accounts). */
    LIST_WALK_MAX_PAGES: 200,
    /** Max follow requests auto-accepted per notifications check (bounded write burst). */
    REQUEST_ACCEPT_CAP: 20,
    /** Max drawer-scroll rounds per check (each may load an older feed page). */
    NOTIFICATIONS_SCROLL_ROUNDS: 2,
  },
  NOISE: {
    /** A retry-backoff draw always stays a real park. */
    BACKOFF_MIN_FACTOR: 0.5,
    /** …and its tail stays bounded. */
    BACKOFF_MAX_FACTOR: 2.0,
    /** Local-beat band floor (idle beat, transient backoff) as a factor of the base. */
    BEAT_MIN_FACTOR: 0.7,
    /** Asymmetric ceiling so the mean beat drifts long, never a fixed beat. */
    BEAT_MAX_FACTOR: 1.45,
    /** List-walk long-rest stride band, in pages — a breather every 5–10 pages. */
    LIST_WALK_REST_EVERY_MIN: 5,
    LIST_WALK_REST_EVERY_MAX: 10,
  },
  POLL: {
    /** Renderer keep-alive: pull only when the push stream has gone this quiet. */
    KEEPALIVE_MS: 10 * SEC,
  },
  CIRCADIAN: {
    /**
     * Per-install horizontal jitter (hours): comfortably wider than
     * `DESYNC_WIDTH_MS` (0.67 h) and narrower than the tightest bump
     * (1.6 h), so no two installs share a curve and the shape survives.
     */
    PHASE_JITTER_MAX_HOURS: 1.5,
  },
  PATTERN: {
    /** A rest day is near-zero, not exactly zero — an exact zero is a machine edge. */
    REST_DAY_MAX_FRACTION: 0.15,
    /** Per-cycle volume plan band: the day fluctuates just under the cap, never hits it exactly. */
    CYCLE_PLAN_MIN_FRACTION: 0.85,
    CYCLE_PLAN_MAX_FRACTION: 0.97,
    /** Below this cap the rounding granularity makes an under-shoot a no-op or brutal. */
    CYCLE_PLAN_MIN_CAP: 10,
    /** Keep any single session from being unfollow-dominated (a mix within a burst). */
    MAX_UNFOLLOW_FRACTION_PER_SESSION: 0.5,
  },
  UPDATER: {
    /** Update-feed check cadence; the launch check covers work due while closed. */
    CHECK_INTERVAL_MS: 6 * HOUR,
  },
  SETTINGS_V1: {
    /** The v1 file's sweep-interval factor floor, coerced verbatim by the migration (the factor itself retired). */
    SWEEP_FACTOR_MIN: 0.5,
    /** …and its ceiling. */
    SWEEP_FACTOR_MAX: 2.0,
  },
} as const;

/**
 * Midpoints of the uniform pacing bands. The BAND is derived
 * (`base × (1 ± POLICY.BAND_HALF_WIDTH)`); the base is a choice, so it lives
 * here with its reason. Where today's shipped edges disagree with the derived
 * band, the two edges appear in `overrides.ts`.
 */
export const PACING_BASE_MS = {
  /**
   * One profile read per ~3.5 s. An enrichment pass is the app's largest read
   * burst (a batch of ~20 fetches back to back); this keeps a full pass around a
   * minute instead of a 20-requests-in-20-seconds spike.
   */
  read: 3_500,
  /** Post-scroll settle on the growth dialog-fallback path. */
  acquireScroll: 2_500,
  /** Between direct list-page reads during a prune census. */
  listWalkPage: 2_000,
  /** The long anti-throttle breather between list-page bursts. */
  listWalkRest: 10_000,
  /** Settle before closing the notifications drawer. */
  notificationsClose: 850,
  /** Wait for an older feed page after deepening the drawer. */
  notificationsScroll: 2_100,
  /** Between Confirm clicks while accepting follow requests. */
  acceptPace: 2_250,
  /** Post-wake settle: the network stack and renderer need a few seconds. */
  resumeSettle: 6_500,
} as const;

/**
 * Qualitative tables that express PREFERENCE, not physics: how much cleanup a
 * user wants woven in, how long they are willing to wait for a follow-back, and
 * the named day/week shapes. There is nothing to derive these from — they are
 * the product's vocabulary.
 */
export const PREFERENCES = {
  /** Weave intensity (the daily unfollow CAP stays a separate manual setting). */
  cleanup: {
    off: { weave: false, fraction: 0 },
    trickle: { weave: true, fraction: 0.25 },
    steady: { weave: true, fraction: 0.5 },
    deep: { weave: true, fraction: 0.7 },
  },
  /** How long to wait for a follow-back, and how long to hold one that landed. */
  patience: {
    quick: { waitDays: 2, holdDays: 1 },
    normal: { waitDays: 4, holdDays: 2 },
    patient: { waitDays: 7, holdDays: 4 },
  },
  /**
   * Named day shapes. `balanced` is not here — it derives from
   * `EMPIRICAL.HUMAN_CIRCADIAN`; the other four are deliberate caricatures.
   */
  dayShape: {
    morning: [
      { centerHour: 8, amplitude: 0.9, widthHours: 1.8 },
      { centerHour: 12.5, amplitude: 0.5, widthHours: 2 },
      { centerHour: 18, amplitude: 0.5, widthHours: 3 },
    ],
    evening: [
      { centerHour: 8, amplitude: 0.3, widthHours: 1.6 },
      { centerHour: 13, amplitude: 0.45, widthHours: 2 },
      { centerHour: 19, amplitude: 1.0, widthHours: 3.2 },
    ],
    nightowl: [
      { centerHour: 11, amplitude: 0.4, widthHours: 2 },
      { centerHour: 16, amplitude: 0.5, widthHours: 2.5 },
      { centerHour: 22, amplitude: 1.0, widthHours: 3.2 },
    ],
    business: [
      { centerHour: 10, amplitude: 0.8, widthHours: 2.5 },
      { centerHour: 15, amplitude: 0.9, widthHours: 3.0 },
      { centerHour: 19, amplitude: 0.3, widthHours: 2.0 },
    ],
  },
  /** A night owl's λ never drops as low overnight as an ordinary user's. */
  NIGHTOWL_OVERNIGHT_FLOOR: 0.06,
  /**
   * Named week shapes, Sun..Sat. `realistic` is not here — it derives from
   * `EMPIRICAL.HUMAN_CIRCADIAN.dayOfWeek`.
   */
  weeklyShape: {
    uniform: [1, 1, 1, 1, 1, 1, 1],
    weekdays: [0.6, 1.1, 1.1, 1.1, 1.1, 1.1, 0.6],
    weekends: [1.3, 0.85, 0.85, 0.85, 0.85, 0.9, 1.3],
  },
} as const;

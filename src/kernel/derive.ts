/**
 * Tier 2 — every operational constant, as a function of tier 0 and tier 1.
 *
 * Nothing here holds a magic number. Every value is `EMPIRICAL × POLICY`, a
 * `BOUNDS`/`PREFERENCES` passthrough, or an entry in `OVERRIDES` with a stated
 * reason. The exported group shapes are byte-compatible with the registry
 * `src/timing/config.ts` shipped before this refactor, and
 * `tests/kernel/legacy-config.snapshot.ts` is the golden oracle that proves it.
 *
 * Read the derivations in this order — later ones depend on earlier ones:
 *   D1 operating rate → D2 gaps → D3 recovery ladder & jitter → D4 timeouts &
 *   polls → D5 breaker thresholds → the group tables.
 *
 * Layering: `src/kernel/**` imports NOTHING from the rest of `src/`. The unit
 * multipliers are declared locally, on purpose (the kernel's `units.ts` lands in
 * the same wave and is adopted in the next one).
 *
 * See docs/adr/0605-constants-derive-from-fundamentals.md.
 */

import { EMPIRICAL } from './fundamentals';
import { overridden } from './overrides';
import { BOUNDS, PACING_BASE_MS, POLICY, PREFERENCES, SCALES } from './policy';

// --- units (local by design; see the layering note above) ---------------------

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;

// --- small numeric helpers ----------------------------------------------------

/** Kill IEEE noise so `0.1 + 0.2` never leaks into a constant. */
function exact(n: number): number {
  return Number.parseFloat(n.toPrecision(12));
}

/** Round `n` to the nearest multiple of `step`. */
function roundTo(n: number, step: number): number {
  return exact(Math.round(n / step) * step);
}

/** Round `n` UP to the nearest multiple of `step` — the safe direction for a floor. */
function ceilTo(n: number, step: number): number {
  return exact(Math.ceil(n / step) * step);
}

/** Constrain `n` to `[lo, hi]`. */
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** `asinh`, spelled out because the derivation cites it. */
function asinh(x: number): number {
  return Math.log(x + Math.sqrt(x * x + 1));
}

/**
 * A uniform pacing band around `baseMs`: `base × (1 ± POLICY.BAND_HALF_WIDTH)`,
 * snapped to a 50 ms grid (finer than any of these pauses can be observed).
 */
function band(baseMs: number): { min: number; max: number } {
  return {
    min: roundTo(baseMs * (1 - POLICY.BAND_HALF_WIDTH), 50),
    max: roundTo(baseMs * (1 + POLICY.BAND_HALF_WIDTH), 50),
  };
}

// --- the ordinal knob vocabularies (structurally identical to PatternSettings) -

export type ActivityLevel = keyof typeof SCALES.activity;
export type Consistency = keyof typeof SCALES.consistency;
export type Rhythm = keyof typeof SCALES.rhythm;
export type Caution = keyof typeof SCALES.caution;
export type Cleanup = keyof typeof PREFERENCES.cleanup;
export type Patience = keyof typeof PREFERENCES.patience;
export type DayShape = keyof typeof PREFERENCES.dayShape | 'balanced';
export type WeeklyShape = keyof typeof PREFERENCES.weeklyShape | 'realistic';

/** One Gaussian bump on the 24-hour circle (structural twin of `CircadianBump`). */
export interface Bump {
  centerHour: number;
  amplitude: number;
  widthHours: number;
}

/** The eight ordinal knobs, structurally identical to `settings/pattern-map`'s. */
export interface OrdinalPattern {
  activityLevel: ActivityLevel;
  consistency: Consistency;
  rhythm: Rhythm;
  dayShape: DayShape;
  weeklyShape: WeeklyShape;
  caution: Caution;
  cleanup: Cleanup;
  patience: Patience;
}

// =============================================================================
// D1 — the operating rate
// =============================================================================

/**
 * The empirical quantities D1 and D2 consume, lifted into a record so a test can
 * perturb them (the envelope law) and so a future wave can feed measured values
 * in without touching a call site.
 */
export interface RateInputs {
  hourlyWallTypical: number;
  hourlyWallLow: number;
  dailyWallTypical: number;
  dailyWallLow: number;
  gapMedianMs: number;
  sessionBoundaryMs: number;
}

/** The shipped beliefs, as a `RateInputs`. */
export function defaultRateInputs(): RateInputs {
  return {
    hourlyWallTypical: EMPIRICAL.FOLLOW_WALL_PER_HOUR.typical,
    hourlyWallLow: EMPIRICAL.FOLLOW_WALL_PER_HOUR.low,
    dailyWallTypical: EMPIRICAL.FOLLOW_WALL_PER_DAY.typical,
    dailyWallLow: EMPIRICAL.FOLLOW_WALL_PER_DAY.low,
    gapMedianMs: EMPIRICAL.HUMAN_GAP.medianMs,
    sessionBoundaryMs: EMPIRICAL.HUMAN_SESSION_BOUNDARY_MS.value,
  };
}

/** Everything D1/D2 produce for one (caution, activity, rhythm) point. */
export interface RateEnvelope {
  hourlyCap: number;
  dailyPlan: number;
  dailyHardCeiling: number;
  dailyPlanSize: number;
  gapMedianSeconds: number;
  /** The UNCLAMPED derived floor — before `OVERRIDES` and before the median clamp. */
  gapFloorSeconds: number;
  gapCapMs: number;
  effectiveMargin: number;
}

/** D1 + D2 as one pure function of the empirical inputs. */
export function rateEnvelope(
  inputs: RateInputs,
  caution: Caution,
  activity: ActivityLevel,
  rhythm: Rhythm,
): RateEnvelope {
  const cap = Math.round(inputs.hourlyWallTypical * POLICY.SAFETY_MARGIN * SCALES.caution[caution]);
  const plan = Math.round(
    inputs.dailyWallTypical * POLICY.SAFETY_MARGIN * SCALES.activity[activity],
  );
  return {
    hourlyCap: cap,
    dailyPlan: plan,
    dailyHardCeiling: Math.round(plan * POLICY.CEILING_HEADROOM),
    dailyPlanSize: Math.round(plan * POLICY.PLAN_BUFFER),
    gapMedianSeconds: roundTo((inputs.gapMedianMs / MS_PER_SECOND) * SCALES.rhythm[rhythm], 5),
    gapFloorSeconds: ceilTo(MS_PER_HOUR / (cap * POLICY.BURST_TOLERANCE) / MS_PER_SECOND, 1),
    gapCapMs: roundTo(inputs.sessionBoundaryMs * POLICY.GAP_CAP_FRACTION, MS_PER_MINUTE),
    effectiveMargin: exact(plan / inputs.dailyWallLow),
  };
}

/**
 * Sustained actions per hour: the TYPICAL observed hourly wall, taken at the
 * chosen safety margin, scaled by the caution knob.
 * `60 × 0.37 × {0.64, 1.00, 1.36}` → 14 / 22 / 30.
 */
export function hourlyCap(caution: Caution): number {
  return rateEnvelope(defaultRateInputs(), caution, 'moderate', 'sessions').hourlyCap;
}

/**
 * Planned follows per day: the TYPICAL observed daily wall at the same margin,
 * scaled by the activity knob. `150 × 0.37 × {0.27 … 1.80}` → 15/30/50/75/100.
 */
export function dailyPlan(activity: ActivityLevel): number {
  return rateEnvelope(defaultRateInputs(), 'standard', activity, 'sessions').dailyPlan;
}

/**
 * What fraction of the LOW end of the observed daily wall a level actually
 * operates at. The number the ordinal table hides: `aggressive` is 1.00 — 100%
 * of the low end. Belongs on the Rate & Safety card, not in a `k`.
 */
export function effectiveMargin(activity: ActivityLevel): number {
  return rateEnvelope(defaultRateInputs(), 'standard', activity, 'sessions').effectiveMargin;
}

/** Hard daily ceiling — the plan plus its sanctioned headroom. */
export function dailyHardCeiling(activity: ActivityLevel): number {
  return rateEnvelope(defaultRateInputs(), 'standard', activity, 'sessions').dailyHardCeiling;
}

/** Candidates queued per plan — a buffer above the daily follow target. */
export function dailyPlanSize(activity: ActivityLevel): number {
  return rateEnvelope(defaultRateInputs(), 'standard', activity, 'sessions').dailyPlanSize;
}

/** Sessions per day: where each rhythm's window sits inside the human 2..9 range. */
export function sessionsPerDay(rhythm: Rhythm): { min: number; max: number } {
  const { min: lo, max: hi } = EMPIRICAL.HUMAN_SESSIONS_PER_DAY;
  const [a, b] = SCALES.sessionsWindow[rhythm];
  return { min: Math.round(lo + (hi - lo) * a), max: Math.round(lo + (hi - lo) * b) };
}

/** Day-to-day volume CV as a percentage, scaled by the consistency knob. */
export function dailyVolumeVariancePct(consistency: Consistency): number {
  return Math.round(EMPIRICAL.HUMAN_DAY_VOLUME_CV.value * 100 * SCALES.consistency[consistency]);
}

/** Probability of a near-zero day, as a percentage, scaled by the same knob. */
export function restDayChancePct(consistency: Consistency): number {
  return Math.round(EMPIRICAL.HUMAN_REST_DAY_RATE.value * 100 * SCALES.restDay[consistency]);
}

// =============================================================================
// D2 — the gap distribution
// =============================================================================

/** Within-session gap median in seconds: the human median, scaled by rhythm. */
export function gapMedianSeconds(rhythm: Rhythm): number {
  return rateEnvelope(defaultRateInputs(), 'standard', 'moderate', rhythm).gapMedianSeconds;
}

/**
 * Within-session gap FLOOR in seconds: the fastest instantaneous pace the burst
 * tolerance sanctions at this caution's hourly cap.
 * `3600 s / (cap × 3.7)`, rounded UP — rounding a floor down would permit a
 * faster burst than the policy allows. → 70 / 45 / 33 s (cautious/bold pinned).
 */
export function gapFloorSeconds(caution: Caution): number {
  const derived = rateEnvelope(defaultRateInputs(), caution, 'moderate', 'sessions').gapFloorSeconds;
  return overridden(`CAUTION.${caution}.floorSeconds`, derived);
}

/** Ceiling on a within-session gap draw: a single gap must never END the session. */
export function gapCapMs(): number {
  return rateEnvelope(defaultRateInputs(), 'standard', 'moderate', 'sessions').gapCapMs;
}

// =============================================================================
// D3 — the recovery ladder, and every jitter width from one policy number
// =============================================================================

/**
 * Rung-`n` hold median (1-based) for a given p50 soft wall, snapped to a
 * 5-minute grid: `W_p50 × c × g^(n-1)`. Parameterised so the envelope law can
 * perturb the wall.
 */
export function holdMedianFrom(p50Hours: number, n: number): number {
  return roundTo(
    p50Hours * MS_PER_HOUR * POLICY.LADDER_START_FRACTION * POLICY.LADDER_GROWTH ** (n - 1),
    5 * MS_PER_MINUTE,
  );
}

/** The rung-`n` hold for the shipped p50 wall. */
function rawHoldMs(n: number): number {
  return holdMedianFrom(EMPIRICAL.SOFT_WALL_DURATION_H.p50, n);
}

/**
 * How many rungs the coverage requirement needs: the smallest `N` whose holds
 * sum to at least the soft wall the policy says the ladder must outlast.
 * `LADDER_COVERS: 'p50'` → 3 rungs (Σ 4.5 h ≥ 3 h). `'p90'` → 7.
 */
export function ladderRungs(): number {
  const target =
    (POLICY.LADDER_COVERS === 'p50'
      ? EMPIRICAL.SOFT_WALL_DURATION_H.p50
      : EMPIRICAL.SOFT_WALL_DURATION_H.p90) * MS_PER_HOUR;
  let total = 0;
  for (let n = 1; n <= 32; n += 1) {
    total += rawHoldMs(n);
    if (total >= target) return n;
  }
  return 32;
}

/** Ladder hold medians, one per rung, snapped to a 5-minute grid. */
export function holdMediansMs(): number[] {
  const out: number[] = [];
  for (let n = 1; n <= ladderRungs(); n += 1) {
    out.push(overridden(`RECOVERY.HOLD_MEDIANS_MS.${n - 1}`, rawHoldMs(n)));
  }
  return out;
}

/**
 * Log-space spread of a hold draw. Requirement: the 10–90 spread of the FIRST
 * rung must be at least `DESYNC_WIDTH_MS`, so two installs that hit the same
 * wall at the same moment do not retry together.
 * `median × 2·sinh(1.2816σ) ≥ DESYNC_WIDTH_MS`.
 */
export function holdSigma(): number {
  const median = holdMediansMs()[0];
  const needed = asinh(POLICY.DESYNC_WIDTH_MS / median / 2) / 1.2816;
  return roundTo(needed, 0.05);
}

/**
 * Log-space spread of a CLAMPED backoff draw (the retry-backoff park). The clamp band is the binding
 * constraint, not de-synchronisation: σ puts the band edge at the 99th percentile — `ln(maxFactor) / z99`.
 */
export function clampedSigma(maxFactor: number): number {
  return roundTo(Math.log(maxFactor) / POLICY.DRAW_TAIL_Z, 0.05);
}

/** Clamp FACTORS that keep the central 95% of a log-normal draw with this σ. */
export function drawClamp(sigma: number, step: number): { min: number; max: number } {
  return {
    min: roundTo(Math.exp(-POLICY.DRAW_CENTRAL_Z * sigma), step),
    max: roundTo(Math.exp(POLICY.DRAW_CENTRAL_Z * sigma), step),
  };
}

// =============================================================================
// D4 — timeouts and poll intervals from measured latency
// =============================================================================

export type LatencyOp = keyof typeof EMPIRICAL.LATENCY;

/** A deadline from a p99, to the second: `p99 × TIMEOUT_SLACK`. */
export function timeoutFrom(p99Ms: number): number {
  return roundTo(p99Ms * POLICY.TIMEOUT_SLACK, MS_PER_SECOND);
}

/** A deadline is the operation's p99 times the policy slack, to the second. */
export function timeoutFor(op: LatencyOp): number {
  return timeoutFrom(EMPIRICAL.LATENCY[op].p99);
}

/**
 * A poll interval is a quarter of the operation's p50 — fast enough that the
 * median case is caught within one extra tick — bounded to `[100 ms, 1 s]` and
 * snapped to 50 ms.
 */
export function pollEveryFor(op: LatencyOp): number {
  return pollEveryFrom(EMPIRICAL.LATENCY[op].p50);
}

/** A poll interval from a p50: a quarter of it, bounded to `[100 ms, 1 s]`. */
export function pollEveryFrom(p50Ms: number): number {
  return roundTo(clamp(p50Ms / 4, 100, 1_000), 50);
}

/**
 * Spacing inside a bounded RETRY ladder: the operation's overall budget spread
 * evenly across its attempts.
 */
export function retryWait(budgetMs: number, attempts: number): number {
  return roundTo(budgetMs / attempts, 100);
}

// =============================================================================
// D5 — breaker thresholds as a posterior, not a taste
// =============================================================================

/**
 * How many consecutive failures declare breakage SYSTEMIC at `POLICY.CONFIDENCE`.
 *
 * Posterior odds after `k` independent failures, given the prior odds `π/(1−π)`
 * and the ordinary per-attempt failure rate `q`:
 *   `π/(1−π) × (1/q)^k ≥ CONFIDENCE/(1−CONFIDENCE)`
 *
 * → cold 7, probing-after-a-hold 2, blocked outcomes 3, a definitive drift
 * signal 2 — the numbers the app already shipped, now with an argument.
 */
export function breakerThreshold(prior: number, ordinaryRate: number): number {
  const priorOdds = prior / (1 - prior);
  const needed = POLICY.CONFIDENCE / (1 - POLICY.CONFIDENCE);
  return Math.max(1, Math.ceil(Math.log(needed / priorOdds) / Math.log(1 / ordinaryRate)));
}

/** The cold breaker threshold: a standing start, no prior signal. */
export function coldFailingThreshold(): number {
  return breakerThreshold(POLICY.PRIOR_SYSTEMIC.cold, EMPIRICAL.ORDINARY_FAIL_RATE.value);
}

/** Failures tolerated while PROBING after a served hold (we already suspect a wall). */
export function reentryFailThreshold(): number {
  return breakerThreshold(POLICY.PRIOR_SYSTEMIC.afterHold, EMPIRICAL.ORDINARY_FAIL_RATE.value);
}

/** Consecutive BLOCKED outcomes that mean a wall rather than luck. */
export function blockedStreakThreshold(): number {
  return breakerThreshold(POLICY.PRIOR_SYSTEMIC.signalled, EMPIRICAL.ORDINARY_BLOCK_RATE.value);
}

/** Consecutive definitive shape signals before drift is confirmed. */
export function driftConfirmThreshold(): number {
  return breakerThreshold(
    POLICY.PRIOR_SYSTEMIC.signalled,
    EMPIRICAL.ORDINARY_DRIFT_SIGNAL_RATE.value,
  );
}

/** Consecutive zero-new-pk pages before a paginated walk calls itself stagnant. */
export function stagnantPageThreshold(): number {
  return breakerThreshold(
    POLICY.PRIOR_SYSTEMIC.signalled,
    EMPIRICAL.ORDINARY_DUPLICATE_PAGE_RATE.value,
  );
}

// =============================================================================
// The circadian field, and feasibility
// =============================================================================

/** Bumps for a named day shape; `balanced` IS the empirical human curve. */
export function dayShapeBumps(shape: DayShape): Bump[] {
  const src =
    shape === 'balanced' ? EMPIRICAL.HUMAN_CIRCADIAN.bumps : PREFERENCES.dayShape[shape];
  return src.map((b) => ({ ...b }));
}

/** Overnight λ floor; a night owl's never drops as low as an ordinary user's. */
export function overnightFloor(shape: DayShape): number {
  return shape === 'nightowl'
    ? PREFERENCES.NIGHTOWL_OVERNIGHT_FLOOR
    : EMPIRICAL.HUMAN_CIRCADIAN.overnightFloor;
}

/** Sun..Sat weights for a named week shape; `realistic` IS the empirical curve. */
export function weeklyWeights(shape: WeeklyShape): number[] {
  return shape === 'realistic'
    ? [...EMPIRICAL.HUMAN_CIRCADIAN.dayOfWeek]
    : [...PREFERENCES.weeklyShape[shape]];
}

/** Normalized λ at local hour `h` — the same field `timing/circadian.ts` samples. */
function intensityAtHour(h: number, bumps: readonly Bump[], floor: number, weight: number): number {
  let raw = floor;
  for (const b of bumps) {
    const d = Math.abs(h - b.centerHour);
    const dist = Math.min(d, 24 - d);
    raw += b.amplitude * Math.exp(-(dist * dist) / (2 * b.widthHours * b.widthHours));
  }
  return Math.min(1, Math.max(0, Math.min(1, raw) * weight));
}

/**
 * SESSION MASS: `∫λ(t)dt` over an average day, in hours. This is how many
 * *effective* working hours a pattern actually has — the quantity that decides
 * whether a daily plan is reachable at a given hourly cap.
 */
export function sessionMassHours(pattern: Pick<OrdinalPattern, 'dayShape' | 'weeklyShape'>): number {
  const bumps = dayShapeBumps(pattern.dayShape);
  const floor = overnightFloor(pattern.dayShape);
  const weights = weeklyWeights(pattern.weeklyShape);
  const STEPS = 24 * 12; // 5-minute resolution
  let total = 0;
  for (let dow = 0; dow < 7; dow += 1) {
    const weight = weights[dow] ?? 1;
    const shift = dow === 0 || dow === 6 ? EMPIRICAL.HUMAN_CIRCADIAN.weekendShiftHours : 0;
    let day = 0;
    for (let i = 0; i < STEPS; i += 1) {
      const h = (((i * 24) / STEPS - shift) % 24 + 24) % 24;
      day += intensityAtHour(h, bumps, floor, weight);
    }
    total += (day / STEPS) * 24;
  }
  return exact(total / 7);
}

/** A pattern whose daily plan is reachable inside its own session mass. */
export interface CoherentPlan {
  readonly kind: 'coherent';
  readonly dailyPlan: number;
  readonly hourlyCap: number;
  readonly sessionMassHours: number;
  /** The most the pattern could deliver: `hourlyCap × sessionMassHours`. */
  readonly reachablePerDay: number;
  /** Fraction of the LOW observed daily wall this plan operates at. */
  readonly effectiveMargin: number;
}

/** A pattern that cannot deliver its own plan, and the fundamental that binds. */
export interface ConflictPlan extends Omit<CoherentPlan, 'kind'> {
  readonly kind: 'conflict';
  /** Which knob to move: the cap is too low, or the plan too high. */
  readonly binding: 'hourlyCap' | 'sessionMass';
  readonly shortfall: number;
}

export type OperatingPlan = CoherentPlan | ConflictPlan;

/**
 * The feasibility check nothing did before: can this pattern actually deliver
 * its daily plan? `dailyPlan ≤ hourlyCap × sessionMassHours`.
 *
 * `nightowl + aggressive + cautious` fails it — the app silently under-delivers
 * and it reads as a bug. Now it returns a `Conflict` naming what binds.
 */
export function deriveOperatingPlan(
  pattern: OrdinalPattern,
  inputs: RateInputs = defaultRateInputs(),
): OperatingPlan {
  const env = rateEnvelope(inputs, pattern.caution, pattern.activityLevel, pattern.rhythm);
  const plan = env.dailyPlan;
  const cap = env.hourlyCap;
  const mass = sessionMassHours(pattern);
  const reachable = exact(cap * mass);
  const common = {
    dailyPlan: plan,
    hourlyCap: cap,
    sessionMassHours: mass,
    reachablePerDay: reachable,
    effectiveMargin: env.effectiveMargin,
  };
  if (plan <= reachable) return { kind: 'coherent', ...common };
  // Which is cheaper to move? If lifting caution alone would fix it, the cap binds.
  const bestCap = rateEnvelope(inputs, 'bold', pattern.activityLevel, pattern.rhythm).hourlyCap;
  return {
    kind: 'conflict',
    ...common,
    binding: plan <= bestCap * mass ? 'hourlyCap' : 'sessionMass',
    shortfall: exact(plan - reachable),
  };
}

// =============================================================================
// The registry: the same group shapes `src/timing/config.ts` has always exported
// =============================================================================

const ACQUIRE_SCROLL = band(PACING_BASE_MS.acquireScroll);
const LIST_WALK_PAGE = band(PACING_BASE_MS.listWalkPage);
const LIST_WALK_REST = band(PACING_BASE_MS.listWalkRest);
const NOTIF_CLOSE = band(PACING_BASE_MS.notificationsClose);
const NOTIF_SCROLL = band(PACING_BASE_MS.notificationsScroll);
const ACCEPT_PACE = band(PACING_BASE_MS.acceptPace);
const RESUME_SETTLE = band(PACING_BASE_MS.resumeSettle);

const GAP_CAP_MS = gapCapMs();
const HOLD_MEDIANS = holdMediansMs();
const HOLD_SIGMA = holdSigma();
const HOLD_CLAMP = drawClamp(HOLD_SIGMA, 0.1);
const GOTO_TIMEOUT_MS = timeoutFor('nav');
const EVALUATE_TIMEOUT_MS = timeoutFor('evaluate');
const PROFILE_LAND_RETRY_MS = retryWait(GOTO_TIMEOUT_MS, BOUNDS.ADAPTER.PROFILE_LAND_ATTEMPTS);

export const ENGINE = {
  /** How long an iteration idles when nothing is due yet (the loop's final gate). */
  IDLE_MS: BOUNDS.ENGINE.IDLE_MS,
  /**
   * Park after an enrichment-starved refill cycle (a plan that queued nothing
   * while un-enriched candidates remain — a rate wall / sentinel window, not a
   * dry target). Long, so repeated walled cycles cannot hammer the profile
   * endpoint; the target is retried, never burned.
   */
  ENRICH_BACKOFF_MS: BOUNDS.ENGINE.ENRICH_BACKOFF_MS,
} as const;

export const PRUNE = {
  /** Brief park after a blocked action before continuing. */
  PARK_MS: BOUNDS.PRUNE.PARK_MS,
  /** How long the prune hand-off waits for the growth loop to park before aborting. */
  PARK_TIMEOUT_MS: BOUNDS.PRUNE.PARK_TIMEOUT_MS,
} as const;

export const CONNECTIVITY = {
  /** Probe cadence — cheap 204 endpoint, frequent enough to park the engine promptly. */
  PROBE_INTERVAL_MS: BOUNDS.CONNECTIVITY.PROBE_INTERVAL_MS,
  /** Per-probe deadline; `net.request` has no built-in timeout. */
  REQUEST_TIMEOUT_MS: timeoutFor('probe'),
} as const;

export const SCHEDULER = {
  /** Wait between own-username resolution attempts (same ladder as `landOnOwnProfile`). */
  USERNAME_RESOLVE_RETRY_MS: PROFILE_LAND_RETRY_MS,
  /** How many username resolution attempts before degrading. */
  USERNAME_RESOLVE_ATTEMPTS: BOUNDS.SCHEDULER.USERNAME_RESOLVE_ATTEMPTS,
  /**
   * teardownGraph: bounded wait for in-flight manual ops to drain before the
   * store closes under them. The longest such op is one `evaluate`.
   */
  MANUAL_OP_DRAIN_TIMEOUT_MS: EVALUATE_TIMEOUT_MS,
} as const;

export const ADAPTER = {
  /** Poll interval while waiting for a dialog / confirm control. */
  POLL_INTERVAL_MS: pollEveryFor('hydration'),
  /** Total wait before declaring a control absent. */
  POLL_TIMEOUT_MS: timeoutFor('control'),
  /**
   * actor: how long after an action click to wait for the follow/unfollow
   * MUTATION response (the authoritative verdict) before falling back to the
   * DOM verification.
   */
  MUTATION_RESPONSE_TIMEOUT_MS: timeoutFor('mutation'),
  /** identity.ts: attempts × retry wait for own-username resolution. */
  IDENTITY_ATTEMPTS: BOUNDS.ADAPTER.IDENTITY_ATTEMPTS,
  IDENTITY_RETRY_MS: overridden('ADAPTER.IDENTITY_RETRY_MS', PROFILE_LAND_RETRY_MS),
  /** identity.ts: nav-settle poll — rounds × per-round wait ≈ 4.5 s ceiling. */
  NAV_SETTLE_ROUNDS: BOUNDS.ADAPTER.NAV_SETTLE_ROUNDS,
  NAV_SETTLE_MS: pollEveryFor('nav'),
  /**
   * identity.ts `landOnOwnProfile`: how long startup polls for the nav profile
   * link before giving up — the navigation budget spread over its attempts.
   */
  PROFILE_LAND_ATTEMPTS: BOUNDS.ADAPTER.PROFILE_LAND_ATTEMPTS,
  PROFILE_LAND_RETRY_MS,
} as const;

export const TAB = {
  /** goto: deadline on `webContents.loadURL` — a wedged renderer must never park the caller forever. */
  GOTO_TIMEOUT_MS,
  /** evaluate: deadline on `executeJavaScript`. */
  EVALUATE_TIMEOUT_MS,
  /** getBody: deadline on CDP `Network.getResponseBody` — a resource-cache read. */
  GET_BODY_TIMEOUT_MS: timeoutFor('resourceRead'),
  /** In-page envelope fetch abort budget. Inlined as a literal in the versions
   *  file (page scripts can't import) — keep `envelopeFetchScript` in sync. */
  FETCH_ABORT_MS: timeoutFor('fetchEnvelope'),
  /** Teardown/restart: bounded wait for the engine loop's exit. */
  TEARDOWN_ENGINE_WAIT_MS: BOUNDS.TAB.TEARDOWN_ENGINE_WAIT_MS,
} as const;

export const RECOVERY = {
  /**
   * engine:step-watchdog — a 'running' engine that has emitted no status AND
   * holds no pending `engine:` wait for this long is wedged, not parked. Sized
   * to the gap cap: the longest silence the pacer may legitimately produce.
   */
  STEP_WATCHDOG_MS: GAP_CAP_MS,
  /** How often the step watchdog evaluates its fire predicate (cheap in-memory checks). */
  STEP_WATCHDOG_CHECK_MS: roundTo(GAP_CAP_MS / 8, MS_PER_MINUTE),
  /** Ladder hold medians (rungs 1..N): `W_p50 × 0.33 × 1.5^(n-1)`. */
  HOLD_MEDIANS_MS: HOLD_MEDIANS,
  /** Log-space spread of each hold draw — sized so rung 1's 10–90 spread covers `DESYNC_WIDTH_MS`. */
  HOLD_SIGMA,
  /** Hold-draw floor as a factor of the rung's median (the central-95% clamp). */
  HOLD_MIN_FACTOR: HOLD_CLAMP.min,
  /** Hold-draw ceiling as a factor of the rung's median. */
  HOLD_MAX_FACTOR: HOLD_CLAMP.max,
  /** Failed holds tolerated before the terminal `recovery-exhausted` halt. */
  MAX_HOLDS: HOLD_MEDIANS.length,
  /** Consecutive failed outcomes that re-enter recovery AFTER a hold. */
  REENTRY_FAILS: reentryFailThreshold(),
  /** Consecutive blocked outcomes that enter recovery — three blocks is a wall, not luck. */
  BLOCKED_STREAK_ENTRY: blockedStreakThreshold(),
  /** Consecutive walled enrichment cycles that enter recovery instead of looping the flat park. */
  WALLED_CYCLES_ENTRY: blockedStreakThreshold(),
  /** rAF-canary observation window for the tab-health check — thirty frames. */
  CANARY_WINDOW_MS: roundTo(EMPIRICAL.DISPLAY.frameMs * 30, 100),
  /**
   * Scheduled prune stays off the tab this long after a rate-limit-classified
   * halt — a census walk into the same wall would deepen the block. Sized to
   * the p50 soft wall it exists to sit out (see ADR 0606: this was 2 h).
   */
  PRUNE_COOLDOWN_AFTER_RATE_HALT_MS: overridden(
    'RECOVERY.PRUNE_COOLDOWN_AFTER_RATE_HALT_MS',
    EMPIRICAL.SOFT_WALL_DURATION_H.p50 * MS_PER_HOUR,
  ),
  /** Tab health events coalesce into at most ONE recovery attempt per this window. */
  TAB_EVENT_DEBOUNCE_MS: BOUNDS.RECOVERY.TAB_EVENT_DEBOUNCE_MS,
  /** Post-wake settle band (uniform draw) after a system resume. */
  RESUME_SETTLE_MIN_MS: overridden('RECOVERY.RESUME_SETTLE_MIN_MS', RESUME_SETTLE.min),
  RESUME_SETTLE_MAX_MS: overridden('RECOVERY.RESUME_SETTLE_MAX_MS', RESUME_SETTLE.max),
  /**
   * Chain self-heal window: a `chain-exhausted` stamp younger than this is
   * re-verified once, because an exhaustion latched during a rate wall is
   * absence of evidence. Two p90 soft walls — comfortably outlasting the worst
   * observed window AND a full run of the ladder's holds.
   */
  EXHAUSTED_REVERIFY_WINDOW_MS: EMPIRICAL.SOFT_WALL_DURATION_H.p90 * 2 * MS_PER_HOUR,
  /** Requeue-healer batch cap: far above any honest incident window, far below "the whole table". */
  HEAL_MAX_RECORDS: BOUNDS.RECOVERY.HEAL_MAX_RECORDS,
  /** Requeue-healer pre-entry grace: the entry streak's victims are stamped just before the ladder woke. */
  HEAL_GRACE_MS: BOUNDS.RECOVERY.HEAL_GRACE_MS,
} as const;

export const RIM = {
  /** Fixed pause after each scroll so the paginated response can land (growth path). */
  SCROLL_WAIT_MS: BOUNDS.RIM.SCROLL_WAIT_MS,
  /** Whole-list scrape bounds (prune census): generous but always finite. */
  FETCH_ALL_MAX_ROUNDS: BOUNDS.RIM.FETCH_ALL_MAX_ROUNDS,
  FETCH_ALL_NO_NEW_STOP: BOUNDS.RIM.FETCH_ALL_NO_NEW_STOP,
  /** Consecutive no-new-item rounds before an acquisition slice stops (one refill slice). */
  ACQUIRE_NO_NEW_STOP: BOUNDS.RIM.ACQUIRE_NO_NEW_STOP,
  /** Growth-acquisition DIALOG-FALLBACK scroll pacing band (uniform draw). */
  ACQUIRE_SCROLL_MIN_MS: overridden('RIM.ACQUIRE_SCROLL_MIN_MS', ACQUIRE_SCROLL.min),
  ACQUIRE_SCROLL_MAX_MS: overridden('RIM.ACQUIRE_SCROLL_MAX_MS', ACQUIRE_SCROLL.max),
  /**
   * Direct list-page walk (prune census): runaway page bound (~200 × 50-user
   * pages = 10k accounts) and default per-page pacing when the caller supplies
   * none. `hasMore === false` is the real terminator.
   */
  LIST_WALK_MAX_PAGES: BOUNDS.RIM.LIST_WALK_MAX_PAGES,
  LIST_WALK_PAGE_MIN_MS: overridden('RIM.LIST_WALK_PAGE_MIN_MS', LIST_WALK_PAGE.min),
  LIST_WALK_PAGE_MAX_MS: overridden('RIM.LIST_WALK_PAGE_MAX_MS', LIST_WALK_PAGE.max),
  /** Long jittered rest duration between page bursts (anti-throttle breather). */
  LIST_WALK_REST_MIN_MS: overridden('RIM.LIST_WALK_REST_MIN_MS', LIST_WALK_REST.min),
  LIST_WALK_REST_MAX_MS: overridden('RIM.LIST_WALK_REST_MAX_MS', LIST_WALK_REST.max),
  /** Consecutive zero-new-pk pages tolerated (duplicate windows) before stopping. */
  LIST_WALK_STAGNANT_STOP: stagnantPageThreshold(),
  /**
   * How long the follow-back watcher's notifications source waits for the
   * news-inbox response after clicking the bell before declaring the read failed.
   */
  NOTIFICATIONS_WAIT_MS: timeoutFor('notifications'),
  /** Brief settle band (uniform draw) before closing the notifications drawer. */
  NOTIFICATIONS_CLOSE_DELAY_MIN_MS: overridden(
    'RIM.NOTIFICATIONS_CLOSE_DELAY_MIN_MS',
    NOTIF_CLOSE.min,
  ),
  NOTIFICATIONS_CLOSE_DELAY_MAX_MS: overridden(
    'RIM.NOTIFICATIONS_CLOSE_DELAY_MAX_MS',
    NOTIF_CLOSE.max,
  ),
  /** Max follow requests auto-accepted per notifications check (bounded write burst). */
  REQUEST_ACCEPT_CAP: BOUNDS.RIM.REQUEST_ACCEPT_CAP,
  /** Max drawer-scroll rounds per check (each may load an older feed page). */
  NOTIFICATIONS_SCROLL_ROUNDS: BOUNDS.RIM.NOTIFICATIONS_SCROLL_ROUNDS,
  /** Post-scroll wait band (uniform draw) for an older feed page to land. */
  NOTIFICATIONS_SCROLL_WAIT_MIN_MS: overridden(
    'RIM.NOTIFICATIONS_SCROLL_WAIT_MIN_MS',
    NOTIF_SCROLL.min,
  ),
  NOTIFICATIONS_SCROLL_WAIT_MAX_MS: overridden(
    'RIM.NOTIFICATIONS_SCROLL_WAIT_MAX_MS',
    NOTIF_SCROLL.max,
  ),
  /** Poll interval while waiting for the captured inbox response to parse. */
  NOTIFICATIONS_POLL_MS: pollEveryFor('control'),
  /** Deadline + poll interval for verifying an accept click consumed its row. */
  ACCEPT_VERIFY_MS: timeoutFor('acceptRow'),
  ACCEPT_VERIFY_POLL_MS: pollEveryFor('acceptRow'),
  /** Jittered pause between Confirm clicks while accepting follow requests. */
  ACCEPT_PACE_MIN_MS: overridden('RIM.ACCEPT_PACE_MIN_MS', ACCEPT_PACE.min),
  ACCEPT_PACE_MAX_MS: overridden('RIM.ACCEPT_PACE_MAX_MS', ACCEPT_PACE.max),
} as const;

/**
 * Timing-noise layer (timing/noise.ts): the retry-backoff spread sized against its clamp band, the
 * local-beat band and the list-walk rest stride (the beat band and the stride are tempo priors).
 */
export const NOISE = {
  /** Log-space spread of a retry-backoff park draw (enrich backoff, blocked/prune parks). */
  BACKOFF_SIGMA: clampedSigma(BOUNDS.NOISE.BACKOFF_MAX_FACTOR),
  /** Backoff draw floor as a factor of its base — a park always stays a real park. */
  BACKOFF_MIN_FACTOR: BOUNDS.NOISE.BACKOFF_MIN_FACTOR,
  /** Backoff draw ceiling as a factor of its base — the tail stays bounded. */
  BACKOFF_MAX_FACTOR: BOUNDS.NOISE.BACKOFF_MAX_FACTOR,
  /** Local-beat band floor (idle beat, transient backoff) as a factor of the base. */
  BEAT_MIN_FACTOR: BOUNDS.NOISE.BEAT_MIN_FACTOR,
  /** Local-beat band ceiling — asymmetric so the mean drifts long, never a fixed beat. */
  BEAT_MAX_FACTOR: BOUNDS.NOISE.BEAT_MAX_FACTOR,
  /** List-walk long-rest stride band (pages), redrawn after each rest. */
  LIST_WALK_REST_EVERY_MIN: BOUNDS.NOISE.LIST_WALK_REST_EVERY_MIN,
  LIST_WALK_REST_EVERY_MAX: BOUNDS.NOISE.LIST_WALK_REST_EVERY_MAX,
} as const;

export const POLL = {
  /** Renderer keep-alive: pull only when the push stream has gone this quiet. */
  KEEPALIVE_MS: BOUNDS.POLL.KEEPALIVE_MS,
  /**
   * Trailing throttle for graph-mutation-driven status pushes (docs/
   * PRINCIPLES.md §2): three perceptual "instants" — live enough that counts
   * visibly tick, cheap enough that a thousand-row walk doesn't emit a
   * thousand statuses.
   */
  GRAPH_PUSH_THROTTLE_MS: EMPIRICAL.DISPLAY.perceptionMs * 3,
} as const;

// ---------------------------------------------------------------------------------
// Organic macro-timing model (see docs/adr/0202-pacing-models.md).
// ---------------------------------------------------------------------------------

export const CIRCADIAN = {
  /** Sum-of-Gaussians daily shape: morning-commute, lunch, dominant evening peak. */
  BUMPS: dayShapeBumps('balanced'),
  /** λ never fully zero — real traces have rare 3am actions. */
  OVERNIGHT_FLOOR: EMPIRICAL.HUMAN_CIRCADIAN.overnightFloor,
  /** Sun..Sat weekly seasonality: mid-week hot, Fri resurgence, weekend dip. */
  DAY_OF_WEEK_WEIGHTS: [...EMPIRICAL.HUMAN_CIRCADIAN.dayOfWeek],
  /** On Sat/Sun the whole curve shifts this many hours later. */
  WEEKEND_SHIFT_HOURS: EMPIRICAL.HUMAN_CIRCADIAN.weekendShiftHours,
  /** Per-install horizontal jitter (hours) so no two installs share an identical curve. */
  PHASE_JITTER_MAX_HOURS: BOUNDS.CIRCADIAN.PHASE_JITTER_MAX_HOURS,
} as const;

/**
 * NB: the PER-LEVEL pacing values (sessions/day, gap median/floor, rolling-hour
 * cap, day-volume variance, rest-day probability) are NOT here — they vary by
 * qualitative knob and are derived per level by the functions above, surfaced
 * through `settings/pattern-map.ts`. SESSION/PATTERN hold only the
 * level-independent constants.
 */
export const SESSION = {
  /** Within-session gap log-space spread; larger = heavier tail (WWW-2015 cluster shape). */
  GAP_SIGMA: EMPIRICAL.HUMAN_GAP.sigma,
  /** Cap keeps the within-session log-normal tail sane — and never ends the session. */
  GAP_CAP_MS,
  /** A gap larger than this counts as a new session (Catledge & Pitkow 1995 / GA4 default). */
  SESSION_BOUNDARY_MS: EMPIRICAL.HUMAN_SESSION_BOUNDARY_MS.value,
  /** Exponential self-excitation kernel: sub-critical branching ratio n≈α<1 (Hawkes). */
  HAWKES_ALPHA: EMPIRICAL.HUMAN_BURST.alpha,
  HAWKES_TAU_MS: EMPIRICAL.HUMAN_BURST.tauMs,
} as const;

export const PATTERN = {
  /** A rest day is near-zero, not exactly zero. */
  REST_DAY_MAX_FRACTION: BOUNDS.PATTERN.REST_DAY_MAX_FRACTION,
  /**
   * The automatic-day band (kernel/plan/volume.ts): each plan-day draws its band
   * uniformly in [MIN, MAX] × the operating rate, and V never exceeds it.
   */
  CYCLE_PLAN_MIN_FRACTION: BOUNDS.PATTERN.CYCLE_PLAN_MIN_FRACTION,
  CYCLE_PLAN_MAX_FRACTION: BOUNDS.PATTERN.CYCLE_PLAN_MAX_FRACTION,
  /** Below this cap the rounding granularity makes an under-shoot a no-op or brutal. */
  CYCLE_PLAN_MIN_CAP: BOUNDS.PATTERN.CYCLE_PLAN_MIN_CAP,
  /** Keep any single session from being unfollow-dominated (a mix within a burst). */
  MAX_UNFOLLOW_FRACTION_PER_SESSION: BOUNDS.PATTERN.MAX_UNFOLLOW_FRACTION_PER_SESSION,
} as const;

export const UPDATER = {
  /** Update-feed check cadence; the launch check covers work due while closed. */
  CHECK_INTERVAL_MS: BOUNDS.UPDATER.CHECK_INTERVAL_MS,
} as const;

// =============================================================================
// The pattern-map tables, derived
// =============================================================================

/** Daily FOLLOW plan per activity level. */
export const ACTIVITY: Record<ActivityLevel, number> = {
  minimal: dailyPlan('minimal'),
  light: dailyPlan('light'),
  moderate: dailyPlan('moderate'),
  active: dailyPlan('active'),
  aggressive: dailyPlan('aggressive'),
};

/** Day-to-day volume CV as a percentage — a flat exact-N daily count is a fingerprint. */
export const VARIANCE_PCT: Record<Consistency, number> = {
  clockwork: dailyVolumeVariancePct('clockwork'),
  natural: dailyVolumeVariancePct('natural'),
  erratic: dailyVolumeVariancePct('erratic'),
};

/** Probability of a near-zero light day — humans skip days. */
export const REST_DAY_PCT: Record<Consistency, number> = {
  clockwork: restDayChancePct('clockwork'),
  natural: restDayChancePct('natural'),
  erratic: restDayChancePct('erratic'),
};

/** Sessions per day + within-session gap median, per rhythm. */
export const RHYTHM: Record<Rhythm, { min: number; max: number; gapMedianSeconds: number }> = {
  trickle: { ...sessionsPerDay('trickle'), gapMedianSeconds: gapMedianSeconds('trickle') },
  sessions: { ...sessionsPerDay('sessions'), gapMedianSeconds: gapMedianSeconds('sessions') },
  bursts: { ...sessionsPerDay('bursts'), gapMedianSeconds: gapMedianSeconds('bursts') },
};

/** Rolling-hour velocity backstop and the within-session gap hard floor, per caution. */
export const CAUTION: Record<Caution, { cap: number; floorSeconds: number }> = {
  cautious: { cap: hourlyCap('cautious'), floorSeconds: gapFloorSeconds('cautious') },
  standard: { cap: hourlyCap('standard'), floorSeconds: gapFloorSeconds('standard') },
  bold: { cap: hourlyCap('bold'), floorSeconds: gapFloorSeconds('bold') },
};

/** Weave intensity per cleanup level (a preference, not a measurement). */
export const CLEANUP: Record<Cleanup, { weave: boolean; fraction: number }> = {
  off: { ...PREFERENCES.cleanup.off },
  trickle: { ...PREFERENCES.cleanup.trickle },
  steady: { ...PREFERENCES.cleanup.steady },
  deep: { ...PREFERENCES.cleanup.deep },
};

/** Follow-back wait/hold windows per patience level. */
export const PATIENCE: Record<Patience, { waitDays: number; holdDays: number }> = {
  quick: { ...PREFERENCES.patience.quick },
  normal: { ...PREFERENCES.patience.normal },
  patient: { ...PREFERENCES.patience.patient },
};

/** The numeric pacing knobs derived from an ordinal pattern (display units). */
export interface DerivedPattern {
  dailyOperatingRate: number;
  dailyHardCeiling: number;
  dailyVolumeVariancePct: number;
  restDayChancePct: number;
  sessionsPerDayMin: number;
  sessionsPerDayMax: number;
  gapMedianSeconds: number;
  gapFloorSeconds: number;
  hourlyVelocityCap: number;
  weaveEnabled: boolean;
  maxUnfollowFractionPerSession: number;
  maxWaitForFollowbackDays: number;
  holdAfterFollowbackDays: number;
  dailyPlanSize: number;
}

/** Map the eight qualitative knobs to the numeric pacing config. */
export function derivePattern(p: OrdinalPattern): DerivedPattern {
  const rhythm = RHYTHM[p.rhythm];
  const caution = CAUTION[p.caution];
  const cleanup = CLEANUP[p.cleanup];
  const patience = PATIENCE[p.patience];
  return {
    dailyOperatingRate: ACTIVITY[p.activityLevel],
    dailyHardCeiling: dailyHardCeiling(p.activityLevel),
    dailyVolumeVariancePct: VARIANCE_PCT[p.consistency],
    restDayChancePct: REST_DAY_PCT[p.consistency],
    sessionsPerDayMin: rhythm.min,
    sessionsPerDayMax: rhythm.max,
    gapMedianSeconds: rhythm.gapMedianSeconds,
    gapFloorSeconds: Math.min(caution.floorSeconds, rhythm.gapMedianSeconds),
    hourlyVelocityCap: caution.cap,
    weaveEnabled: cleanup.weave,
    maxUnfollowFractionPerSession: cleanup.fraction,
    maxWaitForFollowbackDays: patience.waitDays,
    holdAfterFollowbackDays: patience.holdDays,
    dailyPlanSize: dailyPlanSize(p.activityLevel),
  };
}

export type { Tier } from './derive-provenance';
export { PROVENANCE } from './derive-provenance';

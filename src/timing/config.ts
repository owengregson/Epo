/**
 * The timing constant registry — every fixed operational timing value in one
 * place, grouped by subsystem.
 *
 * This file is now a SHIM. Since the fundamentals refactor (ADR 0605) the values
 * are not written here: they are DERIVED in `src/kernel/derive.ts` from twelve
 * empirical quantities (`src/kernel/fundamentals.ts`) and a handful of policy
 * dials (`src/kernel/policy.ts`), with the residue that refuses to derive named
 * one-by-one in `src/kernel/overrides.ts`. Each key's rationale moved next to
 * its derivation; `tests/kernel/derive-golden.test.ts` pins the whole registry
 * against a frozen copy of what the app shipped before the change.
 *
 * The PUBLIC API is unchanged — same group names, same key names, same values
 * (the one exception is documented in ADR 0606). Twenty-seven files import from
 * here across every layer, so keep it that way.
 *
 * To change a timing constant: change the fundamental or the policy dial it
 * derives from. If it genuinely does not derive, add an `OVERRIDES` entry with
 * a reason. Do not add a literal here.
 *
 * USER-configurable timing stays in `settings/settings.ts` (one home per kind of
 * value); renderer PRESENTATIONAL timing stays in `renderer/lib/motion.ts`.
 *
 * Node-free by design: the renderer imports `POLL` from here too.
 */

export {
  /** Adapter: control polling, mutation-response arbitration, identity ladders. */
  ADAPTER,
  /** The circadian field: bumps, overnight floor, weekly weights, phase jitter. */
  CIRCADIAN,
  /** Connectivity probe cadence and per-probe deadline. */
  CONNECTIVITY,
  /** Growth loop: idle beat, refill pacing, enrichment backoff, velocity park. */
  ENGINE,
  /** Timing-noise layer (timing/noise.ts): jitter ceilings, sigmas, clamp bands. */
  NOISE,
  /** Daily-pattern bounds: rest-day depth, cycle-plan band, unfollow mix cap. */
  PATTERN,
  /** Renderer keep-alive and the graph-mutation push throttle. */
  POLL,
  /** Prune loop: pace factor, blocked park, scan freshness, hand-off timeout. */
  PRUNE,
  /** Recovery: step watchdog, the hold ladder, breaker streaks, healer bounds. */
  RECOVERY,
  /** Rim: scroll/enrichment pacing, walk bounds, notification drawer timings. */
  RIM,
  /** Scheduled-prune watcher, username resolution/recovery, teardown drain. */
  SCHEDULER,
  /**
   * Level-INDEPENDENT session structure. The per-level pacing values (sessions/
   * day, gap median/floor, rolling-hour cap, day-volume variance, rest-day
   * probability) vary by qualitative knob and live in `settings/pattern-map.ts`.
   */
  SESSION,
  /** Tab: navigation, evaluate, response-body and envelope-fetch deadlines. */
  TAB,
  /** Update-feed check cadence. */
  UPDATER,
} from '../kernel/derive';

/**
 * Dev harnesses only (livetest / capture / inspect). NOT derived and not
 * intended to be: these are the timings of a human watching a debug run, not of
 * the shipped product. The v4 design cuts this group from the production
 * registry entirely once the harnesses move behind `surface-lab`.
 */
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

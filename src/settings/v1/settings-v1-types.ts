/**
 * The frozen v1 `Settings` interface: the shape `epo-settings.json` stores and the
 * old renderer compiles against (re-exported as `Settings` by `src/types.ts`).
 */
import type { PatternSettings, PersonaId } from '../pattern-map';

/**
 * The single user-facing knob set (v3 §4). Every component's config is a pure
 * projection of this object (see the `toXConfig` mappers), so there is exactly ONE
 * place a user tunes behavior and the component defaults can never silently drift.
 *
 * Persisted as JSON in `userData`, separate from the DB (§6). User-facing units are
 * used here (days, minutes, hours); the mappers convert to the millisecond units the
 * components expect.
 */
export interface Settings {
  /** Seed target username the chain starts from. */
  seed: string;

  // --- Scorer: ratio sweet-spot band + peak plateau + hard exclusion bounds. ---
  bandLow: number;
  bandHigh: number;
  peakLow: number;
  peakHigh: number;
  hardLow: number;
  hardHigh: number;

  // --- Scorer: follower-count band + private-account preference. ---
  minFollowers: number;
  maxFollowers: number;
  privateBoost: number;

  // --- Churn lifecycle timers (display units) + retry cap. ---
  maxWaitForFollowbackDays: number;
  holdAfterFollowbackDays: number;
  maxRetries: number;

  // --- Rate governor: daily caps, inter-action delay, active hours. ---
  dailyHardCeiling: number;
  dailyOperatingRate: number;
  minDelayMinutes: number;
  maxDelayMinutes: number;
  jitterPercent: number;
  activeHoursStart: number;
  activeHoursEnd: number;

  // --- Follow-back sweep cadence. ---
  followbackSweepHours: number;
  /** Epoch ms of the last completed follow-back sweep; null when never run. */
  sweepLastRunAt: number | null;
  /**
   * Timing-noise factor stretching the CURRENT sweep interval (isDue compares
   * against `everyMs × factor`); redrawn and persisted at each completed sweep
   * so consecutive intervals differ while a restart mid-interval keeps the one
   * already drawn. 1 = the exact configured cadence.
   */
  sweepIntervalFactor: number;
  /**
   * Auto-accept incoming follow requests during each follow-back check. On a
   * PRIVATE account, follow-backs arrive as requests — without accepting them
   * they never count as reciprocation. Free for public accounts (no requests
   * entry → soft skip).
   */
  autoAcceptFollowRequests: boolean;

  // --- Scanner / chain / pool health. ---
  dailyPlanSize: number;
  lowWaterCandidates: number;
  minFollowBackRate: number;
  minPoolSize: number;

  /** When true, actions are logged-and-noop'd (intent still recorded) — never touches the account. */
  dryRun: boolean;

  // --- Auto-prune: unfollow non-reciprocating accounts (separate from growth). ---
  /** Usernames never auto-pruned (case-insensitive; pk entries also match). */
  pruneWhitelist: string[];
  /** The bio keep-list: words/phrases (case-insensitive substring match on
   *  the profile bio) that keep an account followed — ONLY when it follows
   *  back. A protected mutual is never rotated out by the churn cycle; a
   *  non-follower is pruned regardless of bio. */
  pruneBioFilterWords: string[];
  /** Max prune unfollows per local day (its OWN ledger, independent of growth). */
  pruneDailyLimit: number;
  /** Re-run the prune every N days; 0 = scheduling off (one-shot only). */
  pruneScheduleDays: number;
  /** Epoch ms of the last completed prune run; null when never run. */
  pruneLastRunAt: number | null;
  /** Min seconds between scan list-pages / scroll rounds (jittered up to max). */
  pruneScanMinSeconds: number;
  /** Max seconds between scan list-pages / scroll rounds (rate-limit safety). */
  pruneScanMaxSeconds: number;

  // --- Organic macro-timing model (docs/superpowers/plans/2026-08-15-*). ---
  /**
   * Which pacing model drives the growth loop. `'organic'` (the default)
   * activates the SessionPlanner (circadian sessions, log-normal gaps,
   * daily-volume distribution); `'legacy'` keeps the flat active-hours +
   * operating-rate metronome. Both values persist as-is: an install whose
   * settings file explicitly says `'legacy'` stays legacy; a file with no
   * stored value gets the organic default. A model switch takes effect at the
   * next graph build (the planner is a construction-time engine dep).
   */
  pacingModel: 'legacy' | 'organic';
  /** Day-to-day volume spread (log-normal σ, as a percent). */
  dailyVolumeVariancePct: number;
  /** Chance a given day is a near-zero "rest day" (percent). */
  restDayChancePct: number;
  /** The day's target volume is distributed across this many sessions. */
  sessionsPerDayMin: number;
  sessionsPerDayMax: number;
  /** Within-session inter-action gap: median / hard floor (seconds). */
  gapMedianSeconds: number;
  gapFloorSeconds: number;
  /** Hard rolling-hour action cap (established-account velocity backstop). */
  hourlyVelocityCap: number;
  /** Weave prune unfollows into the growth action stream (vs. a separate bulk run). */
  weaveEnabled: boolean;
  /** Cap the unfollow share of any single session (mix guard, not an aggregate ratio). */
  maxUnfollowFractionPerSession: number;

  // --- Qualitative pattern model (§5.6): the PRIMARY user surface. The numeric knobs
  //     above are DERIVED from `pattern` (via resolvePattern) — users tune behavior,
  //     not distributions. `persona` is a named bundle; 'custom' means hand-tuned knobs. ---
  persona: PersonaId;
  pattern: PatternSettings;

  // --- Shell / onboarding. ---
  /** Epoch ms when the intro tour was finished or dismissed; null = offer it on launch. */
  tourCompletedAt: number | null;
}

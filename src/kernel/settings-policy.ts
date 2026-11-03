/**
 * Tier 1 — the settings envelope's dials and bounds (ADR 0608, spec §6.2, §17.10): the recommendations no
 * intent choice moves, the quiet-hours rule, the Boost lengths and the safe-side guards. One guard line per
 * entry. Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

import { EXPLORATION_POLICY } from './exploration-policy';

export const SETTINGS_POLICY = {
  /** λ below a fifth of the day's peak marks the hours a typical person rarely opens the app: the derived quiet window. */
  QUIET_INTENSITY_FRACTION: 0.2,
  /** Quiet-hours edges sit on the half hour people state schedules in. */
  QUIET_GRID_MINUTES: 30,
  /** Longer quiet hours leave too little active time for any pace. */
  QUIET_MAX_HOURS: 16,
  /** "Most days" spans the 10th to the 90th percentile of the day draw (z of the 90th percentile). */
  TYPICAL_DAY_Z: 1.2816,
  /** "Reach more people" widens the follow-back curve this much in log space; the peak plateau stays put. */
  AUDIENCE_WIDEN_FACTOR: 1.5,
  /** Follower ranges per account size: very large accounts rarely follow back, very small ones are often inactive. */
  AUDIENCE_SIZE: {
    small: { min: 50, max: 2_000 }, everyday: { min: 50, max: 20_000 }, larger: { min: 50, max: 100_000 },
  },
  /** The score edge "prefer private accounts" gives a private candidate: an edge, never a gate. */
  PRIVATE_EDGE: 0.15,
  /** The follow-back ratio curve: accounts following about as many as follow them sit on the plateau. */
  RATIO_CURVE: { hardLow: 0.5, bandLow: 0.9, peakLow: 1.0, peakHigh: 1.2, bandHigh: 1.5, hardHigh: 3.0 },
  /** Recommendations no intent choice moves; the follow-back floor is the exploration prior, linked. */
  RECOMMENDED: {
    minPoolSize: 300, lowWaterCandidates: 5, mutualWeight: 1.5, mutualCap: 20, bandEdgeScore: 0.6,
    minFollowBackRate: EXPLORATION_POLICY.priorRate,
  },
  /** Boost lengths: never past one plan-day; a Boost waits while earlier Boosts' unfollows take longer than the backlog bound to clear. */
  BOOST: { DEFAULT_HOURS: 12, MIN_HOURS: 1, MAX_HOURS: 24, CHOICES: [2, 4, 8, 12, 24], MAX_BACKLOG_DAYS: 3 },
  /** Re-checks of an unreadable protected record double this many times: at most one visit per eight plan-days. */
  KEEP_RECHECK_DOUBLINGS: 3,
  /** A tempo or gap override stretches a wait at most this much (never shorter): the longest in-step silence stays under the step watchdog. */
  TEMPO_OVERRIDE_MAX_FACTOR: 3,
  /** Seven days off is "Stop", not a plan: every week keeps at least one working day. */
  MAX_DAYS_OFF: 6,
  /** The interim recommendations until the plan port registers (spec C16): today's prune limit, schedule and sweep spacing. */
  INTERIM: { pruneDailyLimit: 50, pruneScheduleDays: 7, followbackSweepHours: 1 },
  /** Risk rungs per vocabulary step: only the largest daily volume reaches the top rung, the hourly caps never do. */
  RISK_RUNG: {
    activity: { minimal: 0, light: 0, moderate: 1, active: 2, aggressive: 3 },
    caution: { cautious: 0, standard: 1, bold: 2 },
  },
  /** The settings document format this build reads and writes; the v1 file stays as it was for older builds. */
  DOC_VERSION: 2,
  /** Typed Advanced values snap to these steps: a finer grid than anyone can tell apart is noise. */
  PARAM_STEP: { whole: 1, share: 0.01, hours: 0.05, factor: 0.1 },
} as const;

const NO_MAX = Number.POSITIVE_INFINITY;

/**
 * The safe side of every Advanced row (the §6.5 catalog's "G" column): nonsense values a typed number could
 * carry. The risky side is the envelope's (`derive-envelope.ts`); a row's bounds are the intersection.
 */
export const SETTINGS_GUARDS = {
  /** A day target below one action is no plan at all. */
  dailyVolume: { min: 1, max: NO_MAX },
  /** The hard stop never sits below one action. */
  dailyCeiling: { min: 1, max: NO_MAX },
  /** An hourly cap below one action would stall every session. */
  hourlyCap: { min: 1, max: NO_MAX },
  /** People prepared per day: below one the queue could never fill. */
  candidateBuffer: { min: 1, max: NO_MAX },
  /** A follow-back wait past two months keeps records Epo will never decide. */
  waitDays: { min: 1, max: 60 },
  /** A follow-back hold past two months is a keep, which the mutuals choice already offers. */
  holdDays: { min: 0, max: 60 },
  /** A session share is a fraction of the session. */
  cleanupShare: { min: 0, max: 1 },
  /** A daily pruning cap is a count; the ceiling bounds it from above. */
  cleanupPerDay: { min: 0, max: NO_MAX },
  /** A census more than monthly leaves the follow-back facts too old to act on. */
  censusEveryDays: { min: 1, max: 30 },
  /** More than ten attempts keeps retrying a broken account long after the evidence is in. */
  attempts: { min: 0, max: 10 },
  /** Checking for new followers less than daily leaves the follow-back decisions a day stale. */
  checksEveryHours: { min: 0, max: 24 },
  /** The smallest follower count a candidate may have. */
  followerMin: { min: 0, max: 10_000_000 },
  /** The largest follower count a candidate may have. */
  followerMax: { min: 1, max: 100_000_000 },
  /** A ratio-curve point is a following/followers ratio. */
  ratioPoint: { min: 0, max: 100 },
  /** A private-account edge larger than this would outrank the ratio curve itself. */
  privateBoost: { min: 0, max: 0.5 },
  /** The mutual-follower weight stays a tie-breaker. */
  mutualWeight: { min: 0, max: 5 },
  /** Mutual followers counted at most. */
  mutualCap: { min: 0, max: 100 },
  /** The score at the band edge is a score. */
  bandEdgeScore: { min: 0, max: 1 },
  /** A follow-back rate is a fraction. */
  moveOnRate: { min: 0, max: 1 },
  /** A pool threshold past a few thousand would abandon every working source. */
  moveOnPool: { min: 0, max: 5_000 },
  /** Refilling above the per-source queue bound has no effect. */
  refillBelow: { min: 0, max: EXPLORATION_POLICY.queuedPerSource },
} as const;

export type SettingsGuardKey = keyof typeof SETTINGS_GUARDS;

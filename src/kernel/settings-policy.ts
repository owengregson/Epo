/**
 * Tier 1 — the settings envelope's dials and bounds (ADR 0608). This is the
 * Phase F skeleton: the entries other streams need before the settings core
 * lands (which then owns and completes this table). One guard line per entry.
 *
 * Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

export const SETTINGS_POLICY = {
  /** Boost lengths: never past one plan-day; a Boost waits while earlier Boosts' unfollows take longer than the backlog bound to clear. */
  BOOST: { DEFAULT_HOURS: 12, MIN_HOURS: 1, MAX_HOURS: 24, CHOICES: [2, 4, 8, 12, 24], MAX_BACKLOG_DAYS: 3 },
  /** Re-checks of an unreadable protected record double this many times: at most one visit per eight plan-days. */
  KEEP_RECHECK_DOUBLINGS: 3,
  /** A tempo override stretches a wait at most this much (never shorter): the longest in-step silence stays under the step watchdog. */
  TEMPO_OVERRIDE_MAX_FACTOR: 3,
  /** Seven days off is "Stop", not a plan: every week keeps at least one working day. */
  MAX_DAYS_OFF: 6,
} as const;

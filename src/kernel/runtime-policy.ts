/**
 * Tier 1 — the plan runtime's loop bounds and the dashboard's read bounds that are not registry keys
 * (the golden pins the registry, ADR 0605), each with one guard line (spec §5.16, §17.9).
 * Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

import { EMPIRICAL } from './fundamentals';

export const RUNTIME_POLICY = {
  /** Two perception frames: an idle beat toward an event already due never spins a zero-delay loop. */
  IDLE_FLOOR_MS: 2 * EMPIRICAL.DISPLAY.perceptionMs,
  /** Rows one queue tab returns; the rest are flagged truncated, never dropped silently. */
  QUEUE_ROW_CAP: 100,
  /** Days of landed follows a target's runway pace averages (a week, so weekday shape evens out). */
  RUNWAY_RATE_WINDOW_DAYS: 7,
} as const;

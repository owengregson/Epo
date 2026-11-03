/**
 * Tier 2 — the reopen reconciliation's derivations (D10, ADR 0213). Phase F
 * lands the first one; the reopen stream adds the rest (head-walk pages, park
 * schedules, the order verdict). Plain-number inputs, kernel siblings only.
 */

import { EMPIRICAL } from './fundamentals';

/**
 * Revisit and freshness windows, in plan-days: one full weekly cycle of the
 * plan — the period of the weekly activity shape (identity with today's 7 days).
 */
export const WEEKLY_CYCLE = EMPIRICAL.HUMAN_CIRCADIAN.dayOfWeek.length;

/**
 * Tier 2 — the reopen derivations (D10, ADR 0213, spec §9.5): the weekly cycle, the head walk's page
 * bound and allowance, the measured page size, the order self-check. Kernel siblings only; no new numbers.
 */

import { driftConfirmThreshold } from './derive';
import { EMPIRICAL } from './fundamentals';
import { POLICY } from './policy';
import { BOUNDS_REENTRY } from './reentry-policy';

/**
 * Revisit and freshness windows, in plan-days: one full weekly cycle of the
 * plan — the period of the weekly activity shape (identity with today's 7 days).
 */
export const WEEKLY_CYCLE = EMPIRICAL.HUMAN_CIRCADIAN.dayOfWeek.length;

/** Consecutive pre-frontier rows that find the frontier: the drift-confirmation count (2). */
export function frontierRun(): number {
  return driftConfirmThreshold();
}

/** The share of list-position pairs that must agree with event times: the census coverage bar (0.98). */
export function orderAgreementRequired(): number {
  return POLICY.CENSUS_ABSENCE_COVERAGE;
}

/** The fewest pairs at which one disagreement still clears the bar: ⌈1 / (1 − agreement)⌉ (50). */
export function minOrderPairs(): number {
  return Math.ceil(1 / (1 - orderAgreementRequired()));
}

/** What a head walk needs to reach the frontier; `rowsPerPage` is null before the first walk. */
export interface HeadNeed {
  readonly identifiedSinceFrontier: number;
  readonly unexplainedGains: number;
  readonly rowsPerPage: number | null;
  readonly pagesAvailable: number;
}

/** The pages `rows` gains fill at the measured size (never below the fault floor), plus the pages a run can straddle. */
function pagesFor(rows: number, rowsPerPage: number | null): number {
  const perPage = Math.max(rowsPerPage ?? BOUNDS_REENTRY.MIN_ROWS_PER_PAGE, BOUNDS_REENTRY.MIN_ROWS_PER_PAGE);
  return Math.ceil(Math.max(0, rows) / perPage) + frontierRun();
}

/** `min(available, ⌈(G + R⁺) / max(rpp, MIN)⌉ + run, FRONTIER_PAGES_MAX)`: past it the walk records a gap. */
export function headWalkPages(n: HeadNeed): number {
  const pages = pagesFor(n.identifiedSinceFrontier + n.unexplainedGains, n.rowsPerPage);
  return Math.max(0, Math.min(n.pagesAvailable, pages, BOUNDS_REENTRY.FRONTIER_PAGES_MAX));
}

/** A walk's allowance before its need is known (the catch-up's pages, a session's check pages). */
export function headPageAllowance(d: { readonly gainsHint: number; readonly rowsPerPage: number | null }): number {
  return Math.min(pagesFor(d.gainsHint, d.rowsPerPage), BOUNDS_REENTRY.FRONTIER_PAGES_MAX);
}

/** Rows per full page from a walk; a mean below the fault floor is a parse or server fault and keeps the prior. */
export function measuredRowsPerPage(
  walk: { readonly rows: number; readonly fullPages: number },
  prior: number | null,
): number | null {
  if (walk.fullPages <= 0) return prior;
  const perPage = walk.rows / walk.fullPages;
  return perPage >= BOUNDS_REENTRY.MIN_ROWS_PER_PAGE ? perPage : prior;
}

/** Whether the followers list reads newest-first: too few pairs keep the prior; then the agreement bar decides. */
export function orderVerdict(
  pairs: number,
  ordered: number,
  prior: 'newest-first' | 'unverified',
): 'newest-first' | 'unverified' {
  if (pairs < minOrderPairs()) return prior;
  return ordered / pairs >= orderAgreementRequired() ? 'newest-first' : 'unverified';
}

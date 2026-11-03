/**
 * Tier 2 — D6, the read allowance.
 *
 * How many deliberate reads a rolling day may spend, derived from the LIVE
 * operating limits: the numbers the pattern knobs derive (D1), or the numbers
 * the owner set by hand. Reads are a consequence of actions. Every mutation
 * re-reads its profile at the click (ADR 0212), every follow comes due exactly
 * once for a relationship check, and the exploration that fills the plan reads
 * its candidates. Sizing reads from the same limits keeps the two coherent and
 * moves them together.
 *
 * Live 2026-11-02 the allowance was a hardcoded 80 visits a day against a
 * 98-a-day ceiling: the plan could never be delivered, and reconciliation
 * alone could starve growth.
 *
 * Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

import { CENSUS_POLICY } from './census-policy';
import { EXPLORATION_POLICY } from './exploration-policy';
import { EMPIRICAL } from './fundamentals';
import { BOUNDS } from './policy';
import { BOUNDS_REENTRY } from './reentry-policy';

const HOURS_PER_DAY = 24;
const MS_PER_DAY = HOURS_PER_DAY * 3_600_000;

/** The live limits the allowance is a function of (all from `Settings`). */
export interface ReadDemand {
  /** Mutations a day, every writer together (`dailyHardCeiling`). */
  dailyHardCeiling: number;
  /** Candidates queued per daily plan (`dailyPlanSize`). */
  dailyPlanSize: number;
  /** Follow-back sweep cadence in hours (`followbackSweepHours`). */
  followbackSweepHours: number;
  /** Most sessions a day (`sessionsPerDayMax`). */
  sessionsPerDayMax: number;
}

/** One rolling window's ceilings. `exploration*` are sub-limits inside the totals. */
export interface ReadAllowance {
  windowMs: number;
  profiles: number;
  explorationProfiles: number;
  listPages: number;
  explorationPages: number;
  notifications: number;
}

/** The parts of the profile allowance, so a law can check each against its demand. */
export interface ProfileReadShares {
  /** One fresh profile at the click, for every mutation the ceiling admits. */
  verify: number;
  /** Each follow comes due once; an unverified click is re-observed once more. */
  reconcile: number;
  /** Refill slices that fill the plan, each reading its source and its candidates. */
  exploration: number;
}

/** Slices that fill the plan: each queues at most `queuedPerSource`. */
export function explorationSlices(d: Pick<ReadDemand, 'dailyPlanSize'>): number {
  return Math.ceil(d.dailyPlanSize / EXPLORATION_POLICY.queuedPerSource);
}

export function profileReadShares(d: ReadDemand): ProfileReadShares {
  const x = EXPLORATION_POLICY;
  return {
    verify: d.dailyHardCeiling,
    reconcile: Math.ceil(d.dailyHardCeiling * (1 + EMPIRICAL.ORDINARY_FAIL_RATE.value)),
    exploration: explorationSlices(d) * (x.profilesPerSlice + x.sourceOpenReads),
  };
}

/**
 * D6. Profiles: verify + reconcile + exploration, with exploration as a
 * sub-limit, so exploring can never spend the reserve that verifies and
 * reconciles. List pages: one full census walk (`LIST_WALK_MAX_PAGES`) plus
 * the slices' pages. Notifications: one per sweep, plus one per session
 * (a return or a continuation reads the feed when it starts).
 */
export function deriveReadAllowance(d: ReadDemand): ReadAllowance {
  const shares = profileReadShares(d);
  const explorationPages = explorationSlices(d) * (EXPLORATION_POLICY.pagesPerSlice + EXPLORATION_POLICY.sourceOpenReads);
  return {
    windowMs: MS_PER_DAY,
    profiles: shares.verify + shares.reconcile + shares.exploration,
    explorationProfiles: shares.exploration,
    listPages: BOUNDS.RIM.LIST_WALK_MAX_PAGES + explorationPages,
    explorationPages,
    notifications: Math.ceil(HOURS_PER_DAY / d.followbackSweepHours) + d.sessionsPerDayMax,
  };
}

// ── The plan-day allowance (ADR 0607, spec §5.8 layer 1) ──────────────────────────────
// The plan core lands it beside the rolling-day allowance above; the read budget switches to it
// when the plan-day window, the trailing backstop and the `use` tags are wired.

/** The plan-day allowance's inputs: the live limits plus the plan's check, census and frontier terms. */
export interface PlanReadDemand {
  readonly dailyHardCeiling: number;
  readonly dailyPlanSize: number;
  readonly sessionsPerDayMax: number;
  /** Mid-session checks a plan-day can need (replaces the sweep cadence). */
  readonly checksPerDayMax: number;
  /** One complete census: the header-relative followers walk plus the following list. */
  readonly censusPagesMax: number;
  /** Head walks: the launch catch-up plus one per session start. */
  readonly frontierPages: number;
}

/** Totals enforced per plan-day AND over any trailing 24 h (spec §3 deviation 3). */
export interface PlanReadAllowance {
  readonly profiles: number;
  /** Click-time verification always fits: non-verify profile debits stay ≤ profiles − this. */
  readonly verifyReserve: number;
  readonly explorationProfiles: number;
  readonly listPages: number;
  readonly explorationPages: number;
  readonly notifications: number;
}

/** Census followers pages for a header of `followers` at `rowsPerPage` (+ the first page and the end probe). */
export function censusFollowerPages(followers: number, rowsPerPage: number): number {
  const rows = Math.max(rowsPerPage, BOUNDS_REENTRY.MIN_ROWS_PER_PAGE);
  return Math.ceil((Math.max(0, followers) * (1 + EMPIRICAL.ORDINARY_DUPLICATE_PAGE_RATE.value)) / rows) + 2;
}

/** A complete census walk's followers pages: header-relative, bounded; an unknown header keeps today's 200. */
export function censusPagesMax(header: { readonly followers: number | null }, rowsPerPage: number | null, fallbackRows: number): number {
  if (header.followers === null) return BOUNDS.RIM.LIST_WALK_MAX_PAGES;
  return Math.min(censusFollowerPages(header.followers, rowsPerPage ?? fallbackRows), CENSUS_POLICY.maxWalkPages);
}

/** The head-walk term: the launch catch-up plus one head walk per session start. */
export function frontierPages(sessionsPerDayMax: number): number {
  return (1 + Math.max(0, sessionsPerDayMax)) * BOUNDS_REENTRY.FRONTIER_PAGES_MAX;
}

/** D6 per plan-day: profiles as today plus the verify reserve; pages = exploration + census + frontier. */
export function derivePlanReadAllowance(d: PlanReadDemand): PlanReadAllowance {
  const legacy = deriveReadAllowance({ ...d, followbackSweepHours: HOURS_PER_DAY });
  return {
    profiles: legacy.profiles,
    verifyReserve: d.dailyHardCeiling,
    explorationProfiles: legacy.explorationProfiles,
    listPages: legacy.explorationPages + d.censusPagesMax + d.frontierPages,
    explorationPages: legacy.explorationPages,
    notifications: d.sessionsPerDayMax + d.checksPerDayMax,
  };
}

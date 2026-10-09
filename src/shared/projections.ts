/**
 * Read-only list projections served over IPC (PRINCIPLES §2: the UI mirrors
 * the graph, live). These are the pure value halves — no engine or store type
 * appears here, so the renderer and the main process share them without either
 * reaching the other. The projections that extend a store row or an engine
 * status (`ChainTargetView`, `EpoStatus`, …) live in `src/ipc/types.ts`.
 */

/** Per-target yield, computed on demand from follow_records + edges (§3.5). */
export interface TargetYield {
  total: number;
  followedBack: number;
  followBackRate: number;
  poolSize: number;
  mutualOverlap: number;
}

/**
 * Sample-size gate for conversion VERDICTS (docs/PRINCIPLES.md §1 — verdicts
 * wait): the follow-back percentage and the median time-to-follow-back read as
 * measurements only once this many follow outcomes have RESOLVED (reciprocated,
 * or ran out the follow-back wait). Below it the UI shows the raw n-of-m tally
 * and says the verdict is still forming.
 */
export const CONVERSION_VERDICT_MIN = 20;

/**
 * Runway display clamp: past this many days the projection is noise, so the UI
 * reports "> N days" instead of false precision.
 */
export const RUNWAY_CAP_DAYS = 90;

/** One follow_record row joined to its account, for a queue lifecycle tab. */
export interface QueueRow {
  pk: string;
  username: string | null;
  ratio: number | null;
  isPrivate: boolean | null;
  /** Mutual-follower count (shared audience), when known. */
  mutuals?: number | null;
  /** The Scorer's composite rank (higher = better); drives the queued order. */
  score?: number | null;
  followedAt?: number;
  holdUntil?: number;
  unfollowDueAt?: number;
}

/** A capped page of queue rows plus whether rows beyond the cap were dropped. */
export interface QueueListResult {
  rows: QueueRow[];
  truncated: boolean;
}

/** One day's cumulative net own-follower growth (Epo-visible, from sweeps). */
export interface NetGrowthPoint {
  dayStartMs: number;
  cumulativeNet: number;
}

/**
 * The `growth:series` read: the per-day series PLUS the moment follower
 * measurement began (`followersBaselineAt`). The baseline is what lets the
 * renderer be honest about coverage — the "All" window spans from it, and the
 * momentum delta only reads once measurement covers the compared windows
 * (before that the badge would imply measurement where none exists).
 */
export interface GrowthSeriesRead {
  points: NetGrowthPoint[];
  /** Epoch ms measurement began, or null before any sweep/census ran. */
  baselineAt: number | null;
}

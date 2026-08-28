/**
 * Pure window/momentum derivations for the Net Follower Growth card. All
 * honesty gates live here, unit-tested: the "All" window spans measurement
 * (never fabricated pre-baseline days), and the momentum delta only reads once
 * the compared windows actually contain measured data — before that a "+0"
 * badge would imply measurement where none exists.
 */

import { MS_PER_DAY } from '@/timing/units';
import type { NetGrowthPoint } from '@/types';

/** The GrowthCard's selectable history windows. */
export type GrowthWindowKey = '14d' | '30d' | '90d' | 'all';

/** Selector options in display order (labels are the Segmented captions). */
export const GROWTH_WINDOWS: ReadonlyArray<{ value: GrowthWindowKey; label: string }> = [
  { value: '14d', label: '14d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
  { value: 'all', label: 'All' },
];

export const DEFAULT_GROWTH_WINDOW: GrowthWindowKey = '14d';

/** Fallback span when "All" is selected before measurement has begun. */
export const GROWTH_WINDOW_FALLBACK_DAYS = 14;

/** Local-midnight epoch ms of the day containing `atMs` (DST-safe). */
export function startOfLocalDay(atMs: number): number {
  const d = new Date(atMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * How many days of series to request for a window. Fixed windows map to their
 * literal spans; `all` spans from the measurement baseline's local day through
 * today inclusive — never further back, so the chart cannot show fabricated
 * flat days from before measurement existed. Before any baseline, `all` falls
 * back to {@link GROWTH_WINDOW_FALLBACK_DAYS}.
 */
export function windowDays(key: GrowthWindowKey, baselineAt: number | null, nowMs: number): number {
  switch (key) {
    case '14d':
      return 14;
    case '30d':
      return 30;
    case '90d':
      return 90;
    case 'all': {
      if (baselineAt === null) return GROWTH_WINDOW_FALLBACK_DAYS;
      const span =
        Math.round((startOfLocalDay(nowMs) - startOfLocalDay(baselineAt)) / MS_PER_DAY) + 1;
      return Math.max(1, span);
    }
  }
}

/** True when the series contains any measured movement (a nonzero net day). */
export function hasMeasuredSignal(points: NetGrowthPoint[]): boolean {
  return points.some((p) => p.cumulativeNet !== 0);
}

export interface Momentum {
  /** False → show the quiet "collecting data" state, never a fabricated "+0". */
  ready: boolean;
  /** Net gained in the recent half minus net gained in the prior half. */
  delta: number;
  /** Days per compared half (the "vs prior Nd" caption). */
  halfDays: number;
}

/**
 * The momentum delta (recent half of the window vs the prior half), gated on
 * honesty: it reads only when
 *
 *  - the window is at least 4 days (each half spans ≥ 2 measured days),
 *  - measurement began (a followers baseline exists) at or before the window's
 *    first day — so the PRIOR half is genuinely covered, not silent zeros from
 *    before any sweep ran, and
 *  - the series carries at least one nonzero net day (real recorded events).
 *
 * The store emits one point per day including empty days, so a length guard
 * alone would always pass — exactly the dishonesty this gate exists to stop.
 *
 * Both halves span exactly h = ⌊(n−1)/2⌋ day-intervals, measured back from the
 * latest point — a lopsided split (7-day prior vs 6-day recent on a 14-point
 * window) would belie the symmetric "vs prior Nd" caption. When the window
 * holds an odd number of intervals, the OLDEST interval is left out.
 */
export function computeMomentum(points: NetGrowthPoint[], baselineAt: number | null): Momentum {
  const n = points.length;
  const halfDays = Math.max(0, Math.floor((n - 1) / 2));
  const covered =
    baselineAt !== null && n > 0 && startOfLocalDay(baselineAt) <= points[0].dayStartMs;
  const ready = n >= 4 && covered && hasMeasuredSignal(points);
  if (!ready) return { ready: false, delta: 0, halfDays };
  const h = halfDays;
  const recent = points[n - 1].cumulativeNet - points[n - 1 - h].cumulativeNet;
  const prior = points[n - 1 - h].cumulativeNet - points[n - 1 - 2 * h].cumulativeNet;
  return { ready: true, delta: recent - prior, halfDays };
}

/**
 * How far ahead the projection overlay extends for a realized window of
 * `windowLen` days: half the window, clamped to [7, 30] so a 14-day view
 * projects a readable week and "All" never dwarfs the realized line.
 */
export function overlayHorizonDays(windowLen: number): number {
  if (windowLen <= 0) return 7;
  return Math.min(30, Math.max(7, Math.round(windowLen / 2)));
}

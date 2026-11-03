/**
 * The sweep's step decisions (spec §9.2–9.3), pure and one step at a time: the followers head's inputs
 * exist only after the header and the drawer wrote their facts. `stale` is the one threshold.
 */

import { type HeadNeed, headWalkPages } from '../kernel/derive-reentry';
import type { ReopenState, SweepMode } from '../store/repos/reopen-state';

export type { SweepMode };
export type SweepStepId = 'profile' | 'notifications' | 'followers-head' | 'following' | 'consistency';
export type SkipWhy = 'fresh' | 'not-needed' | 'boost' | 'mode' | 'no-budget' | 'no-header';

export interface StepInputs {
  readonly now: number;
  readonly mode: SweepMode;
  /** Boost is on: the sweep keeps the header and the drawer, defers the head walk and the following check. */
  readonly light: boolean;
  readonly launchAt: number;
  readonly checkSpacingMs: number;
  readonly clockToleranceMs: number;
  readonly state: ReopenState | null;
  readonly lastHeaderAt: number | null;
  readonly headerThisSweep: boolean;
  /** What a head walk needs; null before the drawer ran (no residual known). */
  readonly need: HeadNeed | null;
  /** The pass's read allowances: profiles and notifications for the step, the head and following pages. */
  readonly budget: { readonly profiles: number; readonly notifications: number; readonly pages: number;
    readonly followingPages: number };
  /** The following count's change since the last following check that Epo's own writes do not explain. */
  readonly followingResidual: number;
  /** This sweep's drawer pass left a gap (the only reason a check-mode sweep walks the head). */
  readonly feedGapThisSweep: boolean;
  /** The current plan-day's start and key: the following check and the requests verification run once per plan-day. */
  readonly planDayStartsAt: number;
  readonly planDayKey: string;
  /** A census read the following list in this plan-day already. */
  readonly censusReadFollowingToday: boolean;
  /** The requests panel's inputs: auto-accept, the accepts the plan allows now, open request edges. */
  readonly autoAccept: boolean;
  readonly acceptsAllowed: number;
  readonly activeRequestEdges: number;
}

export type StepDecision =
  | { readonly id: SweepStepId; readonly run: true; readonly maxPages?: number;
      readonly panel?: { readonly mode: 'accept'; readonly allowed: number } | { readonly mode: 'verify' } | null }
  | { readonly id: SweepStepId; readonly run: false; readonly why: SkipWhy };

/** A frontier is stale when unset, later than the clock allows, or older than the check spacing in force. */
export function stale(t: number | null, now: number, spacingMs: number, toleranceMs: number): boolean {
  return t === null || t > now + toleranceMs || now - t >= spacingMs;
}

const skip = (id: SweepStepId, why: SkipWhy): StepDecision => ({ id, run: false, why });

/** The requests panel's errand for a session or check pass (never at launch). */
function panelFor(i: StepInputs): { mode: 'accept'; allowed: number } | { mode: 'verify' } | null {
  if (i.mode === 'launch') return null;
  if (i.autoAccept) return i.acceptsAllowed > 0 ? { mode: 'accept', allowed: i.acceptsAllowed } : null;
  const verified = i.state?.requests?.verifiedDayKey === i.planDayKey;
  return i.activeRequestEdges > 0 && !verified ? { mode: 'verify' } : null;
}

/** Whether the head walk is needed: unexplained gains seen by this sweep's header, a feed gap, or no frontier. */
function headNeeded(i: StepInputs): boolean {
  if (i.mode === 'check') return i.feedGapThisSweep;
  const gains = i.headerThisSweep && (i.need?.unexplainedGains ?? 0) > 0;
  return gains || i.feedGapThisSweep || (i.state?.feed?.gap ?? null) !== null || (i.state?.head ?? null) === null;
}

/** Decide one step from the facts the earlier steps wrote. */
export function decideStep(id: SweepStepId, i: StepInputs): StepDecision {
  const isStale = (t: number | null): boolean => stale(t, i.now, i.checkSpacingMs, i.clockToleranceMs);
  switch (id) {
    case 'profile':
      // Launch consumes the landing's header, else lands and visits once; a session visits only when stale.
      if (i.mode === 'check') return skip(id, 'mode');
      if (i.mode === 'launch') return { id, run: true };
      if (!isStale(i.lastHeaderAt)) return skip(id, 'fresh');
      return i.budget.profiles > 0 ? { id, run: true } : skip(id, 'no-budget');
    case 'notifications':
      if (!isStale(i.state?.feed?.readAt ?? null)) return skip(id, 'fresh');
      return i.budget.notifications > 0 ? { id, run: true, panel: panelFor(i) } : skip(id, 'no-budget');
    case 'followers-head': {
      if (i.light) return skip(id, 'boost');
      if (!headNeeded(i)) return skip(id, 'not-needed');
      const need = i.need ?? { identifiedSinceFrontier: 0, unexplainedGains: 0, rowsPerPage: i.state?.head?.rowsPerPage ?? null,
        pagesAvailable: i.budget.pages };
      const maxPages = headWalkPages({ ...need, pagesAvailable: Math.min(need.pagesAvailable, i.budget.pages) });
      return maxPages > 0 ? { id, run: true, maxPages } : skip(id, 'no-budget');
    }
    case 'following': {
      if (i.mode !== 'session') return skip(id, 'mode');
      if (i.light) return skip(id, 'boost');
      const checkedToday = (i.state?.following?.checkedAt ?? Number.NEGATIVE_INFINITY) >= i.planDayStartsAt;
      if (checkedToday || i.censusReadFollowingToday) return skip(id, 'fresh');
      if (i.followingResidual === 0) return skip(id, 'not-needed');
      return i.budget.followingPages > 0 ? { id, run: true } : skip(id, 'no-budget');
    }
    case 'consistency':
      return { id, run: true };
  }
}

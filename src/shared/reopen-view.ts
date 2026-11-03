/**
 * Reopen reconciliation as the renderer sees it (spec §9.13, Appendix E): the
 * catch-up view, the own counts, today's tallies, the journal and the open
 * requests, each a `StatusFields` member. Pure, renderer-safe types.
 */

export type CatchUpStepId = 'profile' | 'notifications' | 'followers-head';
export type CatchUpSkip = 'signed-out' | 'account-changed' | 'offline' | 'wall' | 'holding' | 'blocked' | 'no-budget';

export type StepState =
  | { readonly state: 'pending' }
  | { readonly state: 'running' }
  | { readonly state: 'done'; readonly found: number }
  | { readonly state: 'skipped'; readonly why: 'fresh' | 'not-needed' | 'boost' | 'mode' | 'no-budget' | 'no-header' }
  | { readonly state: 'failed'; readonly why: 'unreadable' | 'walled' | 'drift' | 'tab' | 'read-budget' | 'aborted' };

export interface AwaySummary {
  readonly sweepId: number;
  readonly from: number;
  readonly to: number;
  readonly isReturn: boolean;
  readonly followers: { readonly before: number | null; readonly after: number | null };
  readonly following: { readonly before: number | null; readonly after: number | null; readonly outsideEpo: number | null };
  readonly newFollowers: number;
  readonly followBacks: number;
  readonly lostIdentified: number;
  readonly unattributed: number;
  readonly requestsWaiting: { readonly count: number; readonly atLeast: boolean } | null;
  readonly gaps: { readonly feed: boolean; readonly head: boolean };
  readonly backfilled: number | null;
  readonly journalPending: number;
}

export interface CatchUpView {
  readonly state: 'idle' | 'running' | 'done' | 'skipped';
  readonly mode: 'launch' | 'session' | 'check' | null;
  readonly skipped: CatchUpSkip | null;
  readonly isReturn: boolean;
  readonly since: number | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly steps: readonly { readonly id: CatchUpStepId; readonly step: StepState }[];
  readonly summary: AwaySummary | null;
}

export interface OwnCountsView {
  readonly followers: {
    readonly count: number; readonly at: number;
    readonly seenSince: { readonly gained: number; readonly lost: number };
  } | null;
  readonly following: { readonly count: number; readonly at: number } | null;
}

export interface TodayCounts {
  readonly startsAt: number;
  readonly endsAt: number;
  readonly net: number;
  readonly gained: number;
  readonly lost: number;
  readonly unattributed: number;
  readonly followBacks: number;
  readonly outside: number;
}

export interface JournalView { readonly pending: number; readonly parked: number; readonly nextAttemptAt: number | null }

export interface RequestsView { readonly count: number; readonly complete: boolean; readonly observedAt: number | null }

export interface GrowthPointV2 {
  readonly dayStartMs: number;
  readonly cumulativeNet: number;
  readonly arrived?: { readonly gained: number; readonly lost: number; readonly fromMs: number };
}

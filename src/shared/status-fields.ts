/**
 * The status fields beyond the engine's own (spec §15.3, §14 C22): `EpoStatus` is
 * `EngineStatus & StatusFields`. Main composes them from the current graph's
 * status contributors plus the graph-independent `basis`; each wiring module
 * returns its own contributors. Renderer-safe types only.
 */
import type { BoostView } from './boost';
import type { BootView } from './boot';
import type { PlanProjection } from './plan-projection';
import type { CatchUpView, JournalView, OwnCountsView, RequestsView, TodayCounts } from './reopen-view';

export interface StatusFields {
  /** Required: no count renders from a `not-built` status (law L-ZERO). */
  readonly basis: 'built' | 'not-built';
  readonly boot?: BootView | null;
  readonly account?: { readonly username: string | null; readonly confirmed: boolean } | null;
  readonly plan?: PlanProjection | null;
  readonly boost?: BoostView | null;
  readonly catchUp?: CatchUpView | null;
  readonly own?: OwnCountsView | null;
  readonly today?: TodayCounts | null;
  readonly journal?: JournalView | null;
  readonly requests?: RequestsView | null;
  readonly unfollowsPaused?: 'protection-needs-review' | 'protection-unavailable' | null;
  /** The unconfirmed-actions breaker's state. */
  readonly actionsUnconfirmed?: { readonly kind: 'follow' | 'unfollow'; readonly streak: number } | null;
  readonly resumeTarget?: { readonly pk: string; readonly username: string | null } | null;
}

/** Every optional member, set to `null` ("not known yet") on a not-built status. */
export const NOT_BUILT_FIELDS = {
  basis: 'not-built',
  boot: null,
  account: null,
  plan: null,
  boost: null,
  catchUp: null,
  own: null,
  today: null,
  journal: null,
  requests: null,
  unfollowsPaused: null,
  actionsUnconfirmed: null,
  resumeTarget: null,
} as const satisfies Required<StatusFields>;

/**
 * Explore Boost as the renderer sees it (spec §8.5): the view that rides
 * `EpoStatus.boost`, the preview, and the typed command result. Pure types.
 */

export interface BoostView {
  /** `paused`: the window is open but run intent is stopped. */
  readonly state: 'off' | 'on' | 'waiting' | 'paused';
  readonly startedAt: number | null;
  readonly endsAt: number | null;
  readonly effectiveFrom: number | null;
  readonly followsDuring: number | null;
  readonly lastEnded: { readonly at: number; readonly reason: 'user' | 'expired' | 'clock' } | null;
}

export interface BoostPreview {
  readonly hours: number;
  readonly endsAt: number;
  readonly effectiveFrom: number;
  /** The act-now effect: Boost opens a session now. */
  readonly startsSessionNow: boolean;
  /** Remaining unfollows moved to follows plus the lift placed, inside today's ceilings. */
  readonly extraFollowsToday: number;
  readonly unfollowsWaiting: number;
  readonly why:
    | 'ready' | 'nothing-to-shift' | 'light-day' | 'quiet-hours' | 'day-off' | 'limit-reached-today'
    | 'backlog' | 'engine-stopped';
}

export type BoostCommandResult =
  | { readonly kind: 'started' | 'ended'; readonly boost: BoostView }
  | {
      readonly kind: 'refused';
      readonly boost: BoostView;
      readonly reason:
        | 'signed-out' | 'runtime-blocked' | 'no-seed' | 'already-on' | 'not-on' | 'bad-duration'
        | 'nothing-to-shift' | 'backlog' | 'internal';
    };

/**
 * The one follow-back classifier (spec §9.10): the UI's target yield and the engine's source quality
 * both fold it, so they classify every record identically (law L7). Pure; renderer-safe.
 */

export type FollowbackOutcome = 'success' | 'failure' | 'censored' | 'pending' | 'excluded';

export interface OutcomeRow {
  readonly state: string;
  readonly followedAt: number | null;
  readonly followedBackAt: number | null;
  readonly followbackAfter: number | null;
  readonly followbackObservedAt: number | null;
  readonly reconciledAt: number | null;
  readonly unfollowReason: 'no-followback' | 'hold-expired' | null;
}

/**
 * Within `windowMs` of the follow: a follow-back interval `[lo, hi]` decides success (`hi` inside),
 * failure (`lo` past it) or censored (straddling); without one, a read after the horizon fails it.
 */
export function followbackOutcome(r: OutcomeRow, windowMs: number, now: number): FollowbackOutcome {
  if (r.followedAt === null || (r.followedBackAt !== null && r.followedBackAt < r.followedAt)) return 'excluded';
  const horizon = r.followedAt + windowMs;
  const hi = r.followedBackAt ?? r.followbackObservedAt;
  if (hi !== null) {
    const lo = r.followbackAfter ?? r.followedBackAt ?? r.followedAt;
    if (hi <= horizon) return 'success';
    return lo > horizon ? 'failure' : 'censored';
  }
  if ((r.reconciledAt !== null && r.reconciledAt >= horizon)
    || (r.state === 'unfollowed' && r.unfollowReason === 'no-followback')) return 'failure';
  return now < horizon ? 'pending' : 'censored';
}

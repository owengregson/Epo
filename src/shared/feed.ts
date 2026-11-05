/**
 * The live feed (spec §12.9, Appendix C.1): what the sidebar narrates, grouped and
 * newest first, shaped in main from store reads and pushed on mutation.
 * Renderer-safe and pure: the types and the row-time helper.
 */

export interface Person { readonly pk: string; readonly username: string | null }

export type UnfollowWhy = 'no-follow-back' | 'after-follow-back' | 'clean-up' | 'you' | 'other';

/** `id` stays stable across re-grouping (the FLIP key). */
type At = { readonly id: string; readonly at: number };

export type FeedItem = At & (
  | { readonly kind: 'followed'; readonly people: readonly Person[]; readonly via: 'plan' | 'boost' | 'you'; readonly practice: boolean }
  | { readonly kind: 'unfollowed'; readonly people: readonly Person[]; readonly why: UnfollowWhy; readonly practice: boolean }
  | { readonly kind: 'followed-back'; readonly person: Person; readonly afterMs: number | null; readonly dated: boolean }
  | { readonly kind: 'new-followers'; readonly people: readonly Person[]; readonly dated: boolean }
  | { readonly kind: 'lost-followers'; readonly count: number }
  | { readonly kind: 'request-accepted'; readonly people: readonly Person[] }
  | {
      readonly kind: 'not-done'; readonly action: 'follow' | 'unfollow' | 'accept'; readonly person: Person;
      readonly why: 'refused' | 'unavailable' | 'unconfirmed' | 'error';
    }
  | { readonly kind: 'kept'; readonly person: Person; readonly reason: string }
  | {
      readonly kind: 'boost'; readonly edge: 'started' | 'ended'; readonly endsAt: number | null;
      readonly why: 'user' | 'expired' | 'clock' | null;
    }
  | { readonly kind: 'slowed-down'; readonly until: number | null }
  | { readonly kind: 'resumed'; readonly after: 'restart' }
  | { readonly kind: 'caught-up'; readonly summary: AwaySummaryLite }
);

/** The fields of the reopen catch-up's away summary the feed renders. */
export interface AwaySummaryLite {
  readonly awayFrom: number;
  readonly checkedAt: number;
  readonly newFollowers: number;
  readonly followBacks: number;
  readonly left: number;
}

/** One plan-day the feed window spans: the day groups' boundary and its key. */
export interface FeedDay {
  readonly key: string;
  readonly startsAt: number;
}

export interface FeedView {
  /** Newest first, grouped, bounded by the live policy's feed limit. */
  readonly items: readonly FeedItem[];
  /** The "Since you left" divider. */
  readonly awayFrom: number | null;
  readonly windowStart: number;
  readonly shapedAt: number;
  /** The plan-days the window spans, today first ("Today", "Yesterday", then weekday or date); absent before a build. */
  readonly days?: readonly FeedDay[];
}

const CLOCK_TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const DATE_TIME = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const localDate = (t: number): string => new Date(t).toDateString();

/** How long ago `at` was, for a row's time: "just now" · "2m" · "1h 5m" · "yesterday 3:10 PM" · "Nov 2, 3:10 PM". */
export function formatAgo(at: number, now: number): string {
  const ago = Math.max(0, now - at);
  const minutes = Math.floor(ago / 60_000);
  if (minutes < 1) return 'just now';
  const hours = Math.floor(ago / 3_600_000);
  if (hours < 1) return `${minutes}m`;
  if (localDate(at) === localDate(now)) {
    const rest = Math.floor((ago - hours * 3_600_000) / 60_000);
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return localDate(at) === yesterday.toDateString() ? `yesterday ${CLOCK_TIME.format(at)}` : DATE_TIME.format(at);
}

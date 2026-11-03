/**
 * Feed copy (spec Appendix C.15.6, "Prune" wording): each typed feed item as a row — a sentence short enough
 * for one line, and the deck's words after " · " or " — " on a 12 px detail line, so a reason is never cut.
 * People render as handle buttons; an unknown username reads "someone".
 */
import { clock, count, plural } from '@/renderer/sidebar/format';
import type { FeedItem, Person } from '@/shared/feed';

/** A piece of a sentence: plain text, or a person shown as a handle. */
export type Part = string | { readonly person: Person };

type RowTone = 'live' | 'good' | 'idle' | 'hold' | 'calm';

export interface RowFace {
  readonly glyph: string;
  readonly tone: RowTone;
  readonly line: readonly Part[];
  readonly detail: readonly Part[] | null;
  /** The people a grouped row lists when it is expanded. */
  readonly people: readonly Person[] | null;
}

const p = (person: Person): Part => ({ person });

/** "@a, @b +4": the first two handles and how many more. */
function list(people: readonly Person[], tail = ''): Part[] {
  const shown = people.slice(0, 2);
  const parts: Part[] = [];
  shown.forEach((x, i) => {
    if (i > 0) parts.push(', ');
    parts.push(p(x));
  });
  const more = people.length - shown.length;
  if (more > 0) parts.push(` +${count(more)}`);
  if (tail !== '') parts.push(tail);
  return parts;
}

const UNFOLLOW_WHY = {
  'no-follow-back': 'Didn’t follow back', 'after-follow-back': 'After following back', 'clean-up': 'Pruned',
} as const;

const KEPT_WHY: Readonly<Record<string, string>> = {
  account: 'On your protection list', verified: 'A verified account', 'bio-word': 'Their bio matches your keywords',
  source: 'An account Epo explores through', 'unreadable-bio': 'Bio not read yet — Epo checks again later',
  'unreadable-verified': 'Verified badge not read yet — Epo checks again later',
};

const VERB = { follow: 'follow', unfollow: 'unfollow', accept: 'accept' } as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** "2 days" / "5 hours": how long a follow-back took. */
function took(ms: number): string {
  return ms >= DAY_MS ? plural(Math.round(ms / DAY_MS), 'day', 'days') : plural(Math.max(1, Math.round(ms / HOUR_MS)), 'hour', 'hours');
}

function followed(i: Extract<FeedItem, { kind: 'followed' }>): RowFace {
  const boost = i.via === 'boost';
  const one = i.people.length === 1 ? i.people[0] : undefined;
  const lead = i.practice ? 'Practice: would follow' : i.via === 'you' ? 'You followed' : 'Followed';
  if (one !== undefined) return { glyph: 'plus', tone: 'live', line: [`${lead} `, p(one)], detail: boost ? ['Boost'] : null, people: null };
  return { glyph: 'plus', tone: 'live', line: [`${lead} ${plural(i.people.length, 'person', 'people')}`],
    detail: list(i.people, boost ? ' · Boost' : ''), people: i.people };
}

function unfollowed(i: Extract<FeedItem, { kind: 'unfollowed' }>): RowFace {
  const why = i.why === 'you' || i.why === 'other' ? null : UNFOLLOW_WHY[i.why];
  const lead = i.practice ? 'Practice: would unfollow' : i.why === 'you' ? 'You unfollowed' : 'Unfollowed';
  const one = i.people.length === 1 ? i.people[0] : undefined;
  if (one !== undefined) return { glyph: 'user-minus', tone: 'idle', line: [`${lead} `, p(one)], detail: why === null ? null : [why], people: null };
  return { glyph: 'user-minus', tone: 'idle', line: [`${lead} ${plural(i.people.length, 'person', 'people')}`],
    detail: list(i.people, why === null ? '' : ` · ${why}`), people: i.people };
}

function notDone(i: Extract<FeedItem, { kind: 'not-done' }>): RowFace {
  const verb = VERB[i.action];
  const who: Part[] = i.action === 'accept' ? [p(i.person), '’s request'] : [p(i.person)];
  const face = (line: Part[], detail: string): RowFace => ({ glyph: 'circle-exclamation', tone: 'hold', line, detail: [detail], people: null });
  switch (i.why) {
    case 'unconfirmed': return face([`Couldn’t ${verb} `, ...who], 'Instagram didn’t confirm it');
    case 'unavailable': return face([p(i.person), '’s profile isn’t available'], 'Skipped');
    case 'refused': return face([`Instagram didn’t let Epo ${verb} `, ...who], 'Trying later');
    case 'error': return face([`Couldn’t ${verb} `, ...who], 'Diagnostics has details');
  }
}

function caughtUp(i: Extract<FeedItem, { kind: 'caught-up' }>): RowFace {
  const s = i.summary;
  const bits = [
    s.newFollowers > 0 ? plural(s.newFollowers, 'new follower', 'new followers') : null,
    s.followBacks > 0 ? plural(s.followBacks, 'follow-back', 'follow-backs') : null,
    s.left > 0 ? `${count(s.left)} left` : null,
  ].filter((b): b is string => b !== null);
  return { glyph: 'circle-up', tone: 'calm', line: ['While you were away'], detail: [bits.length === 0 ? 'Nothing new' : bits.join(' · ')], people: null };
}

/** One feed item as its row. */
export function rowFace(i: FeedItem): RowFace {
  switch (i.kind) {
    case 'followed': return followed(i);
    case 'unfollowed': return unfollowed(i);
    case 'followed-back':
      return { glyph: 'arrows-rotate', tone: 'good', line: [p(i.person), ' followed you back'],
        detail: i.dated && i.afterMs !== null ? [`${took(i.afterMs)} after you followed`] : null, people: null };
    case 'new-followers': {
      const one = i.people.length === 1 ? i.people[0] : undefined;
      if (one !== undefined && i.dated) return { glyph: 'arrow-trend-up', tone: 'good', line: [p(one), ' started following you'], detail: null, people: null };
      const n = plural(i.people.length, 'new follower', 'new followers');
      return { glyph: 'arrow-trend-up', tone: 'good', line: [i.dated ? n : `Found ${n}`], detail: list(i.people), people: i.people };
    }
    case 'lost-followers':
      return { glyph: 'users-slash', tone: 'idle', line: [`${plural(i.count, 'person', 'people')} stopped following you`], detail: null, people: null };
    case 'request-accepted': {
      const one = i.people.length === 1 ? i.people[0] : undefined;
      if (one !== undefined) return { glyph: 'check', tone: 'good', line: ['Accepted ', p(one), '’s follow request'], detail: null, people: null };
      return { glyph: 'check', tone: 'good', line: [`Accepted ${plural(i.people.length, 'follow request', 'follow requests')}`],
        detail: list(i.people), people: i.people };
    }
    case 'not-done': return notDone(i);
    case 'kept':
      return { glyph: 'shield-halved', tone: 'calm', line: ['Kept ', p(i.person), ' · protected'],
        detail: KEPT_WHY[i.reason] === undefined ? null : [KEPT_WHY[i.reason] as string], people: null };
    case 'boost': {
      if (i.edge === 'started') {
        return { glyph: 'bolt', tone: 'live', line: ['Boost started'],
          detail: i.endsAt === null ? null : [`Focusing on new people until ${clock(i.endsAt)}`], people: null };
      }
      const line = i.why === 'expired' ? 'Boost finished' : 'Boost ended';
      return { glyph: 'bolt', tone: 'calm', line: [line], detail: i.why === 'clock' ? ['Your computer’s clock changed'] : null, people: null };
    }
    case 'slowed-down':
      return { glyph: 'hourglass-half', tone: 'hold', line: ['Instagram asked Epo to slow down'],
        detail: i.until === null ? null : [`Trying again at ${clock(i.until)}`], people: null };
    case 'resumed':
      return { glyph: 'circle-play', tone: 'calm', line: ['Epo picked up where it left off'], detail: ['After closing unexpectedly'], people: null };
    case 'caught-up': return caughtUp(i);
  }
}

export const FEED_EMPTY = 'Nothing yet today. Activity shows up here as Epo works.';
export const SOMEONE = 'someone';
/** The "Since you left" divider. */
export const sinceYouLeft = (label: string): string => `Since you left · ${label}`;

/**
 * Board fixtures: plausible mid-day values with real digit widths. Every name is
 * invented. Copy follows the spec's decks with "Prune" for the cleanup feature.
 */
import type { Tone } from '@/renderer/gallery/direction/proposed-tokens';

export const ACCOUNT = '@mara.creates';
export const VERSION = 'Epo 3.4.1';

/** One plan session on the strip; `from`/`to` are hours on the strip's axis. */
export interface Session {
  from: number;
  to: number;
  state: 'done' | 'now' | 'next' | 'later' | 'skipped' | 'before-open';
  /** Share of the session's planned actions already done. */
  done: number;
}

/** Today's plan for a working afternoon (strip spans 8 AM–10 PM). */
export const PLAN_DAY: Session[] = [
  { from: 9.07, to: 9.68, state: 'done', done: 1 },
  { from: 11.33, to: 12.08, state: 'done', done: 1 },
  { from: 13.87, to: 15.17, state: 'now', done: 0.55 },
  { from: 17.67, to: 18.5, state: 'next', done: 0 },
  { from: 20.25, to: 21, state: 'later', done: 0 },
];

/** The same day seen from a 1:30 PM launch: the morning ran without Epo. */
export const PLAN_LATE_OPEN: Session[] = [
  { from: 9.07, to: 9.68, state: 'skipped', done: 0 },
  { from: 11.33, to: 12.08, state: 'before-open', done: 0 },
  { from: 14.67, to: 15.5, state: 'next', done: 0 },
  { from: 17.67, to: 18.5, state: 'later', done: 0 },
  { from: 20.25, to: 21, state: 'later', done: 0 },
];

/** Hour label as the app's `Intl.DateTimeFormat` would print it (12-hour here). */
export function hourLabel(h: number): string {
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh} ${h < 12 || h === 24 ? 'AM' : 'PM'}`;
}

/** Seven plan-days of net followers, today last. */
export const SPARK = [4, 9, -2, 6, 11, 7, 12] as const;

type FeedGlyph = 'plus' | 'user-minus' | 'arrows-rotate' | 'check' | 'arrow-trend-up' | 'bolt' | 'shield-halved'
  | 'circle-up' | 'circle-exclamation' | 'hourglass-half';

interface FeedRow {
  id: string;
  glyph: FeedGlyph;
  tone: Tone;
  /** The sentence, short enough for one row; strings starting with "@" render as handle buttons. */
  parts: string[];
  /** The 12 px second line: the deck's words after its " · " or " — ", so a reason is never cut. */
  detail?: string[];
  time: string;
  fresh?: boolean;
}

export type FeedEntry = FeedRow | { divider: string } | { group: string };

/** Newest first. The divider is a strict time boundary: everything above it happened after you left. */
export const FEED_WORKING: FeedEntry[] = [
  { group: 'Today' },
  { id: 'f1', glyph: 'plus', tone: 'live', parts: ['Followed ', '@jane.doe'], time: 'just now', fresh: true },
  { id: 'f2', glyph: 'arrows-rotate', tone: 'good', parts: ['@bob.rivera', ' followed you back'], detail: ['2 days after you followed'], time: '4m' },
  { id: 'f3', glyph: 'plus', tone: 'live', parts: ['Followed 3 people'], detail: ['@kai.m', ', ', '@lena.k', ' +1'], time: '18m' },
  { id: 'f4', glyph: 'user-minus', tone: 'idle', parts: ['Unfollowed ', '@carl.b'], detail: ['Didn’t follow back'], time: '26m' },
  { id: 'f5', glyph: 'check', tone: 'good', parts: ['Accepted ', '@erin.w', '’s follow request'], time: '41m' },
  { id: 'f6', glyph: 'arrow-trend-up', tone: 'good', parts: ['3 new followers'], detail: ['@dana.o', ', ', '@mo.li', ' +1'], time: '1h 5m' },
  { id: 'f7', glyph: 'circle-up', tone: 'calm', parts: ['While you were away'], detail: ['14 new followers · 6 follow-backs · 2 left'], time: '9h' },
  { divider: 'Since you left · Mon 11:20 PM' },
  { group: 'Yesterday' },
  { id: 'f8', glyph: 'shield-halved', tone: 'calm', parts: ['Kept ', '@theo.park', ' · protected'], time: '8:12 PM' },
  { id: 'f9', glyph: 'plus', tone: 'live', parts: ['Followed 6 people'], detail: ['@ines.v', ', ', '@sam.ortiz', ' +4'], time: '7:40 PM' },
];

export const FEED_CATCHING_UP: FeedEntry[] = [
  { divider: 'Since you left · Mon 11:20 PM' },
  { group: 'Yesterday' },
  { id: 'c1', glyph: 'plus', tone: 'live', parts: ['Followed 6 people'], detail: ['@ines.v', ', ', '@sam.ortiz', ' +4'], time: '7:40 PM' },
  { id: 'c2', glyph: 'arrows-rotate', tone: 'good', parts: ['@nora.h', ' followed you back'], time: '6:55 PM' },
  { id: 'c3', glyph: 'user-minus', tone: 'idle', parts: ['Unfollowed 2 people'], detail: ['Didn’t follow back'], time: '6:20 PM' },
  { id: 'c4', glyph: 'hourglass-half', tone: 'hold', parts: ['Instagram asked Epo to slow down'], detail: ['Trying again at 5:10 PM'], time: '4:58 PM' },
];

export const FEED_BOOST: FeedEntry[] = [
  { group: 'Today' },
  { id: 'b1', glyph: 'plus', tone: 'live', parts: ['Followed 4 people'], detail: ['@lena.k', ', ', '@mo.li', ' +2 · Boost'], time: 'just now', fresh: true },
  { id: 'b2', glyph: 'arrows-rotate', tone: 'good', parts: ['@bob.rivera', ' followed you back'], time: '40m' },
  { id: 'b3', glyph: 'plus', tone: 'live', parts: ['Followed 3 people'], detail: ['@kai.m', ', ', '@jane.doe', ' +1 · Boost'], time: '1h 2m' },
  { id: 'b4', glyph: 'bolt', tone: 'live', parts: ['Boost started'], detail: ['Focusing on new people until 9:40 PM'], time: '4h 48m' },
  { id: 'b5', glyph: 'circle-up', tone: 'calm', parts: ['While you were away'], detail: ['9 new followers · 4 follow-backs · 1 left'], time: '9h' },
  { divider: 'Since you left · Mon 11:20 PM' },
  { group: 'Yesterday' },
  { id: 'b6', glyph: 'plus', tone: 'live', parts: ['Followed 6 people'], detail: ['@ines.v', ', ', '@sam.ortiz', ' +4'], time: '7:40 PM' },
];

export const FEED_ATTENTION: FeedEntry[] = [
  { group: 'Today' },
  { id: 'a1', glyph: 'circle-exclamation', tone: 'hold', parts: ['Couldn’t follow ', '@kai.m'], detail: ['Instagram didn’t confirm it'], time: '6m' },
  { id: 'a2', glyph: 'plus', tone: 'live', parts: ['Followed ', '@jane.doe'], time: '12m' },
  { id: 'a3', glyph: 'arrows-rotate', tone: 'good', parts: ['@bob.rivera', ' followed you back'], time: '31m' },
  { id: 'a4', glyph: 'user-minus', tone: 'idle', parts: ['Unfollowed ', '@carl.b'], detail: ['Didn’t follow back'], time: '44m' },
];

/** Followers measured once a day for the People chart (calendar days). */
export const GROWTH: number[] = [
  1102, 1106, 1109, 1108, 1115, 1121, 1124, 1131, 1129, 1136, 1144, 1150, 1149, 1158, 1166, 1171, 1170, 1181,
  1189, 1196, 1202, 1201, 1213, 1222, 1230, 1241, 1247, 1258, 1272, 1284,
];

export interface Lane {
  key: string;
  label: string;
  count: number;
}

export const LANES: Lane[] = [
  { key: 'next', label: 'Up next', count: 38 },
  { key: 'waiting', label: 'Waiting', count: 112 },
  { key: 'back', label: 'Following back', count: 64 },
  { key: 'leaving', label: 'Leaving soon', count: 9 },
  { key: 'kept', label: 'Kept', count: 12 },
];

export interface LaneRow {
  handle: string;
  meta: string;
  progress: number;
  due: string;
  /** A record changed outside Epo, shown as unverified until the following check ran. */
  marker?: 'outside';
}

export const WAITING_ROWS: LaneRow[] = [
  { handle: '@jane.doe', meta: 'Followed just now · via @studio.lumen', progress: 0.02, due: 'Decides in 4 days' },
  { handle: '@kai.m', meta: 'Followed 18 minutes ago · via @studio.lumen', progress: 0.04, due: 'Decides in 4 days' },
  { handle: '@lena.k', meta: 'Followed yesterday · via @studio.lumen', progress: 0.3, due: 'Decides in 3 days' },
  { handle: '@sam.ortiz', meta: 'Followed 2 days ago · via @north.coffee', progress: 0.52, due: 'Decides in 2 days', marker: 'outside' },
  { handle: '@ines.v', meta: 'Followed 3 days ago · via @north.coffee', progress: 0.78, due: 'Decides tomorrow' },
];

export interface ChainStep {
  handle: string;
  state: 'explored' | 'now' | 'set-aside';
  line: string;
}

export const CHAIN: ChainStep[] = [
  { handle: '@north.coffee', state: 'explored', line: 'Explored · 640 followed · 28% followed back' },
  { handle: '@riverside.prints', state: 'set-aside', line: 'Set aside when you restarted' },
  { handle: '@studio.lumen', state: 'now', line: 'Exploring now · 42 followed here' },
];

export const FUNNEL = [
  { label: 'People found', value: '8,150' },
  { label: 'Good fit', value: '2,340' },
  { label: 'Followed', value: '214' },
  { label: 'Followed back', value: '51' },
] as const;

/**
 * The limits Advanced prints, one source for every place that shows them: the
 * hourly limit at Standard caution and the hard stop the user lowered (65 → 60).
 */
export const LIMITS = { hourly: 22, hardStop: 60, hardStopRecommended: 65 } as const;

/** "Today's plan in detail" (Advanced → Timing): one plan-day and its sessions. */
export const PLAN_DETAIL_DAY = [
  ['Plan-day', '2:45 AM – 2:45 AM tomorrow'],
  ['Resets at', '2:45 AM'],
  ['Epo’s own maximum', '48 actions'],
  ['Hard stop', `${LIMITS.hardStop} actions`],
  // Unfollows: the unfollow wall's share at Standard (22); easing back in: one caution rung down (14).
  ['At most an hour', `${LIMITS.hourly} (22 unfollows, 14 while easing back in)`],
  ['Approvals per check', 'up to 5'],
] as const;

/** 30 follows + 10 unfollows + 4 approvals = 44, the Balanced day; each session holds its pauses. */
export const PLAN_DETAIL_SESSIONS = [
  { i: 1, time: '9:04–9:41 AM', f: 6, u: 2, a: 1, pace: 'normal', avg: '5 m 4 s', min: '2 m 10 s', state: 'done' },
  { i: 2, time: '11:20 AM–12:05 PM', f: 6, u: 2, a: 1, pace: 'relaxed', avg: '6 m 12 s', min: '2 m 38 s', state: 'done' },
  { i: 3, time: '1:52–3:10 PM', f: 11, u: 3, a: 1, pace: 'quick', avg: '4 m 21 s', min: '1 m 52 s', state: 'now' },
  { i: 4, time: '5:40–6:30 PM', f: 5, u: 2, a: 1, pace: 'normal', avg: '5 m 0 s', min: '2 m 8 s', state: 'next' },
  { i: 5, time: '8:15–9:00 PM', f: 2, u: 1, a: 0, pace: 'relaxed', avg: '6 m 40 s', min: '2 m 50 s', state: 'later' },
] as const;

/** Today so far: sessions 1–2 done and about half of session 3. */
export const TODAY_SUMMARY = '18 of 30 follows · 6 of 10 unfollows';

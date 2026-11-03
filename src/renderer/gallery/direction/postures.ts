/**
 * The seven sidebar postures the boards show, each a frozen projection of what
 * the live column would render (copy from spec Appendix C, "Prune" wording).
 */
import {
  FEED_ATTENTION,
  FEED_BOOST,
  FEED_CATCHING_UP,
  FEED_WORKING,
  type FeedEntry,
  PLAN_DAY,
  PLAN_LATE_OPEN,
  type Session,
  TODAY_SUMMARY,
} from '@/renderer/gallery/direction/fixtures';
import type { Tone } from '@/renderer/gallery/direction/proposed-tokens';

export type RingMode = 'arc' | 'deplete' | 'static';
export type BoostState = 'ready' | 'on' | 'paused' | 'unavailable';

export interface TodaySpec {
  boost: BoostState;
  sessions: Session[];
  /** Hour of the now marker on the strip. */
  now: number;
  /** The Boost window on the strip, when one is open. */
  band?: { from: number; to: number };
  summary: string;
  next: string;
}

export interface ResultsSpec {
  net: string;
  up: boolean;
  followers: string;
  age: string;
  backs: string;
}

export interface PostureSpec {
  id: string;
  label: string;
  /** What the reviewer should look at in this frame. */
  note: string;
  tone: Tone;
  headline: string;
  pills: ReadonlyArray<'boost' | 'practice'>;
  /** The now line; parts starting with "@" are handles. */
  nowLine: string[];
  next: string | null;
  why: boolean;
  /** The reserved progress hairline (a known total), as a fraction. */
  progress: number | null;
  ring: { mode: RingMode; fraction: number; glyph: string };
  primary: { label: string; icon: string } | null;
  secondary: string | null;
  reason: string | null;
  today: TodaySpec | 'get-started';
  results: ResultsSpec | null;
  feed: FeedEntry[];
  /** A popover drawn open in this frame, to show its design. */
  popover?: 'boost-preview' | 'why-catching-up';
}

const RESULTS: ResultsSpec = {
  net: '+12',
  up: true,
  followers: '1,284 followers',
  age: 'checked 1:52 PM',
  backs: '5 follow-backs today · 38 waiting',
};

const DAY: TodaySpec = { boost: 'ready', sessions: PLAN_DAY, now: 14.5, summary: TODAY_SUMMARY, next: 'This session until about 3:10 PM' };

const RESTED = PLAN_DAY.map((s, i) => (i === 2 ? { ...s, state: 'done' as const, done: 1 } : s));

export const POSTURES: PostureSpec[] = [
  {
    id: 'working',
    label: 'Working',
    note: 'The ring spins while a step runs; the now line names the person; one primary button.',
    tone: 'live',
    headline: 'Working',
    pills: [],
    nowLine: ['Following ', '@jane.doe'],
    next: 'Next step in 1:12',
    why: true,
    progress: null,
    ring: { mode: 'arc', fraction: 0.18, glyph: 'wave-square' },
    primary: { label: 'Pause', icon: 'pause' },
    secondary: 'Stop',
    reason: null,
    today: DAY,
    results: RESULTS,
    feed: FEED_WORKING,
  },
  {
    id: 'resting',
    label: 'Resting',
    note: 'Between sessions the ring runs down to the next one. Hovering Boost shows what it would do first.',
    tone: 'calm',
    headline: 'Resting',
    pills: [],
    nowLine: ['Between sessions.'],
    next: 'Next session at 5:40 PM',
    why: true,
    progress: null,
    ring: { mode: 'deplete', fraction: 0.62, glyph: 'hourglass-half' },
    primary: { label: 'Pause', icon: 'pause' },
    secondary: 'Stop',
    reason: null,
    today: { ...DAY, sessions: RESTED, now: 16.2, summary: '23 of 30 follows · 7 of 10 unfollows', next: 'Next session at 5:40 PM' },
    results: { ...RESULTS, net: '+14', backs: '6 follow-backs today · 37 waiting' },
    feed: FEED_WORKING,
    popover: 'boost-preview',
  },
  {
    id: 'catching-up',
    label: 'Catching up',
    note: 'At launch Epo reads only what changed. Each finished step ticks off; numbers say they are updating.',
    tone: 'live',
    headline: 'Catching up',
    pills: [],
    nowLine: ['Checking your notifications'],
    next: 'You can press Start anytime.',
    why: true,
    progress: 0.5,
    ring: { mode: 'arc', fraction: 0.18, glyph: 'arrows-rotate' },
    primary: { label: 'Start', icon: 'play' },
    secondary: null,
    reason: null,
    today: { boost: 'ready', sessions: PLAN_LATE_OPEN, now: 13.5, summary: '0 of 25 follows · 0 of 8 unfollows', next: 'Next session at 2:40 PM' },
    results: { net: '+3', up: true, followers: '1,276 followers', age: 'checking now…', backs: '2 follow-backs today · updating…' },
    feed: FEED_CATCHING_UP,
    popover: 'why-catching-up',
  },
  {
    id: 'needs-attention',
    label: 'Needs attention',
    note: 'One plain sentence, the fix as the primary, Start beside it. A single nudge, no looping alarm.',
    tone: 'alert',
    headline: 'Needs attention',
    pills: [],
    nowLine: ['Instagram signed you out. Sign in on the Live tab, then press Start.'],
    next: null,
    why: false,
    progress: null,
    ring: { mode: 'static', fraction: 1, glyph: 'circle-exclamation' },
    primary: { label: 'Open Live', icon: 'arrow-up-right-from-square' },
    secondary: 'Start',
    reason: 'Scheduled work waits until you press Start.',
    today: { ...DAY, boost: 'unavailable', now: 14.5, next: 'Next session at 5:40 PM' },
    results: RESULTS,
    feed: FEED_ATTENTION,
  },
  {
    id: 'boost-on',
    label: 'Boost on',
    note: 'Boost is a band over Today with one tap to end; the pill in Now only says it is on. Between steps the ring runs down.',
    tone: 'live',
    headline: 'Working',
    pills: ['boost'],
    nowLine: ['Finding and following new people'],
    next: 'Next step in 0:48',
    why: true,
    progress: null,
    ring: { mode: 'deplete', fraction: 0.4, glyph: 'bolt' },
    primary: { label: 'Pause', icon: 'pause' },
    secondary: 'Stop',
    reason: null,
    today: {
      ...DAY,
      boost: 'on',
      band: { from: 9.67, to: 21.67 },
      summary: '26 of 38 follows · 6 of 6 unfollows',
      next: 'This session until about 3:10 PM',
    },
    results: { ...RESULTS, net: '+15', backs: '6 follow-backs today · 41 waiting' },
    feed: FEED_BOOST,
  },
  {
    id: 'boost-paused',
    label: 'Boost on, Epo stopped',
    note: 'A Boost keeps its clock while Epo is stopped, and says so instead of silently waiting.',
    tone: 'idle',
    headline: 'Stopped',
    pills: ['boost'],
    nowLine: ['Press Start when you’re ready.'],
    next: 'Today’s plan: about 44 actions in 5 sessions',
    why: false,
    progress: null,
    ring: { mode: 'static', fraction: 1, glyph: 'play' },
    primary: { label: 'Start', icon: 'play' },
    secondary: null,
    reason: null,
    today: { ...DAY, boost: 'paused', band: { from: 9.67, to: 21.67 }, next: 'Next session at 5:40 PM' },
    results: { ...RESULTS, net: '+7' },
    feed: FEED_BOOST,
  },
  {
    id: 'get-started',
    label: 'Get started',
    note: 'A first run replaces Today and Results with three steps that tick off as they happen.',
    tone: 'idle',
    headline: 'Let’s get set up',
    pills: [],
    nowLine: ['Choose a starting account whose followers look like your audience.'],
    next: null,
    why: false,
    progress: null,
    ring: { mode: 'static', fraction: 1, glyph: 'bullseye' },
    primary: { label: 'Set up', icon: 'sliders' },
    secondary: null,
    reason: null,
    today: 'get-started',
    results: null,
    feed: [],
  },
];

/**
 * Today, Results, Get started and the footer (spec Appendix C.15.5): the words around the numbers. Every
 * number and time comes from the plan or the status projection.
 */
import type { Res } from '@/ipc/contract';
import { atTime, clock, count, plural, sameLocalDay, weekdayTime } from '@/renderer/sidebar/format';

type Plan = NonNullable<Res<'status'>['plan']>;
type Session = Plan['sessions'][number];

export const TODAY_TITLE = 'Today’s plan';
export const NO_PLAN = 'Your plan for today appears once Epo has made it.';

/** "23 of 30 follows · 6 of 10 unfollows · 3 of 4 approvals": each kind the plan holds, so the parts add up. */
export function todaySummary(plan: Plan, withApprovals: boolean): string {
  const k = plan.kinds;
  const parts = [
    k.follow.planned > 0 ? `${count(k.follow.done)} of ${count(k.follow.planned)} follows` : null,
    k.unfollow.planned > 0 ? `${count(k.unfollow.done)} of ${count(k.unfollow.planned)} unfollows` : null,
    withApprovals && k.accept.planned > 0 ? `${count(k.accept.done)} of ${count(k.accept.planned)} approvals` : null,
  ].filter((x): x is string => x !== null);
  return parts.length === 0 ? 'Nothing planned today' : parts.join(' · ');
}

/** The approvals the short summary leaves out, for the line's tooltip. */
export function approvalsNote(plan: Plan): string | null {
  const a = plan.kinds.accept;
  return a.planned > 0 ? `Also ${count(a.done)} of ${count(a.planned)} follow-request approvals` : null;
}

/** The line under the strip: this session, the next one, or why there is none. */
export function todayNext(plan: Plan, now: number): string {
  const { day, totals } = plan;
  const next = plan.now.nextAt;
  const tomorrow = next === null ? '' : ` · next session ${atTime(next, now)}`;
  if (plan.now.sessionIdx !== null && plan.now.closesAt !== null) return `This session until about ${clock(plan.now.closesAt)}`;
  if (totals.remaining === 0 && totals.planned > 0) return `Today’s plan is done${tomorrow}`;
  if (day.light) return `Light day — about ${count(totals.planned)} actions.`;
  return next === null ? `About ${count(totals.planned)} actions today` : `Next session ${atTime(next, now)}`;
}

/**
 * A day with nothing to count (a day off, a late first open, a zero-volume light day): why, on the summary's
 * line, and when the next session is, on the line under it — two lines that each fit the column.
 */
function emptyDay(plan: Plan): string | null {
  if (plan.day.dayOff) return 'Day off — Epo does no automatic work today.';
  if (plan.totals.planned > 0) return null;
  if (plan.day.lateStart) return 'Today’s sessions had already passed when Epo opened.';
  return plan.day.light ? 'Light day — no actions planned today.' : null;
}

/** The two lines under the strip: what the day holds, then when things happen. */
export function todayLines(plan: Plan, now: number, withApprovals: boolean): { readonly sum: string; readonly next: string } {
  const empty = emptyDay(plan);
  if (empty === null) return { sum: todaySummary(plan, withApprovals), next: todayNext(plan, now) };
  const at = plan.now.nextAt;
  return { sum: empty, next: at === null ? '' : `Next session ${atTime(at, now)}` };
}

/** A plan block's tooltip. */
export function sessionTip(s: Session): string {
  if (s.state === 'skipped') return 'Skipped — Epo wasn’t running';
  if (s.state === 'before-open') return 'Before Epo opened';
  return `Session ${s.idx + 1} · ${clock(s.startAt)}–${clock(s.endAt)} · ${count(s.done)} of ${count(s.planned)} · ${s.pace} pace`;
}

export const RESULTS = {
  heroLabel: 'followers today',
  heroTip: (startsAt: number): string => `Followers gained minus followers lost since today’s plan began at ${clock(startsAt)}.`,
  followers: (n: number): string => plural(n, 'follower', 'followers'),
  checked: (at: number, now: number): string => `checked ${sameLocalDay(at, now) ? clock(at) : weekdayTime(at)}`,
  checkingNow: 'checking now…',
  neverSeen: 'Epo shows your follower count after it opens your profile.',
  backs: (today: number | null, waiting: number): string =>
    today === null ? `${count(waiting)} waiting to follow back` : `${plural(today, 'follow-back', 'follow-backs')} today · ${count(waiting)} waiting`,
  updating: 'updating…',
  signedOut: 'Your numbers appear after you sign in.',
  loading: 'Loading your numbers…',
  spark: (days: number): string => `last ${count(days)} days`,
} as const;

export const GET_STARTED = {
  title: 'Get started',
  progress: (done: number, total: number): string => `${count(done)} of ${count(total)}`,
  signIn: 'Sign in to Instagram',
  seed: 'Choose a starting account',
  start: 'Press Start',
  choose: 'Choose',
} as const;

export const FOOTER = {
  version: (v: string): string => `Epo ${v}`,
  ready: 'Update ready · Restart',
  available: 'Update available · View',
  diagnostics: 'Diagnostics',
} as const;

export const FEED_TITLE = 'Recent activity';
export const freshPill = (n: number): string => `${count(n)} new`;

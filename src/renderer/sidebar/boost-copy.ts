/**
 * The sidebar's Boost lines, filled from the Boost deck (`copy/boost.ts`) and the plan: the button, the
 * preview, the band in each state, and why the button waits. A clause whose number is zero is left out.
 */
import type { Res } from '@/ipc/contract';
import { BOOST_COPY } from '@/renderer/copy/boost';
import { clock, count, hoursMinutes } from '@/renderer/sidebar/format';

type Preview = NonNullable<Res<'previewBoost'>>;
type Boost = NonNullable<Res<'status'>['boost']>;

/** Fill a deck template's `{name}` slots; the deck's leading bolt is drawn as an icon instead. */
export function fill(template: string, vars: Readonly<Record<string, string>> = {}): string {
  return template.replace(/^⚡ /, '').replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

/** The deck has no line for a Boost that cannot run yet because today's plan is not wired. */
export const BOOST_NEEDS_PLAN = 'Boost works once today’s plan is ready.';
/** The paused band and the Now reason line split the deck's paused sentence (one line each). */
export const PAUSED_BAND = 'Boost on until {time} · Epo is stopped';
export const PAUSED_REASON = 'Press Start to use Boost.';
export const DAY_OFF = 'Today is a day off; Boost starts at {time}.';

export function buttonLabel(hours: number | null, stopped: boolean): string {
  if (stopped) return BOOST_COPY.control.startAndRun;
  return hours === null ? 'Boost' : fill(BOOST_COPY.control.start, { h: count(hours) });
}

/** What one tap would do, in the deck's words. */
export function previewLine(p: Preview, nextSessionAt: number | null, followsPlanned: number | null): string {
  if (p.why === 'quiet-hours') return fill(BOOST_COPY.control.quietHours, { time: clock(p.effectiveFrom) });
  if (p.why === 'day-off') return fill(DAY_OFF, { time: clock(p.effectiveFrom) });
  if (p.why === 'limit-reached-today') return BOOST_COPY.control.limitReached;
  if (p.extraFollowsToday === 0 && p.startsSessionNow && nextSessionAt !== null && followsPlanned !== null) {
    return fill(BOOST_COPY.control.actNowOnly, { time: clock(nextSessionAt), n: count(followsPlanned) });
  }
  const line = fill(BOOST_COPY.control.preview, {
    time: clock(p.endsAt), n: count(p.extraFollowsToday), k: count(p.unfollowsWaiting),
  });
  return p.unfollowsWaiting > 0 ? line : line.replace(/ · \S+ unfollows will wait$/, '');
}

/** The band while a Boost window is open: on, waiting for an eligible session, or kept while Epo is stopped. */
export function bandLine(b: Boost, now: number): string {
  const ends = b.endsAt ?? now;
  if (b.state === 'waiting') return fill(BOOST_COPY.control.waiting, { time: clock(b.effectiveFrom ?? b.startedAt ?? ends) });
  if (b.state === 'paused') return fill(PAUSED_BAND, { time: clock(ends) });
  const left = hoursMinutes(ends - now);
  return fill(BOOST_COPY.control.on, { time: clock(ends), h: left.hours, m: left.minutes });
}

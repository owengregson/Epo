/**
 * How the live column writes times and counts (spec C.15): `Intl` formats that follow the person's 12/24 h
 * setting, plurals from `Intl.PluralRules`, and every number taken from a projection, never from copy.
 */
import { commas, mmss } from '@/renderer/lib/format';

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const HOUR = new Intl.DateTimeFormat(undefined, { hour: 'numeric' });
const WEEKDAY_TIME = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const DATE = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const PLURAL = new Intl.PluralRules(undefined);

/** Unit lengths (a grid for formatting, not a timing). */
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

/** "9:40 PM". */
export const clock = (t: number): string => CLOCK.format(t);
/** "9 PM" (the plan strip's axis). */
export const hourLabel = (t: number): string => HOUR.format(t);
/** "Mon 11:20 PM". */
export const weekdayTime = (t: number): string => WEEKDAY_TIME.format(t);
/** "1,284". */
export const count = (n: number): string => commas(n);

const dayOf = (t: number): string => new Date(t).toDateString();

/** True when two instants fall on the same local calendar day. */
export function sameLocalDay(a: number, b: number): boolean {
  return dayOf(a) === dayOf(b);
}

/** True when `t` falls on the local day after `now`'s. */
export function isTomorrow(t: number, now: number): boolean {
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  return dayOf(t) === next.toDateString();
}

/** "at 9:04 AM", "tomorrow at 9:04 AM", or "Mon 9:04 AM" further out. */
export function atTime(t: number, now: number): string {
  if (sameLocalDay(t, now)) return `at ${clock(t)}`;
  if (isTomorrow(t, now)) return `tomorrow at ${clock(t)}`;
  return weekdayTime(t);
}

/** "1:12" while a deadline is under an hour away, else null (the caller names the time instead). */
export function countdownText(to: number, now: number): string | null {
  const left = to - now;
  return left < HOUR_MS ? mmss(left / SECOND_MS) : null;
}

/** A span as whole hours and the minutes past them ("7" and "12" for 7 h 12 m). */
export function hoursMinutes(ms: number): { readonly hours: string; readonly minutes: string } {
  const minutes = Math.max(0, Math.round(ms / MINUTE_MS));
  return { hours: String(Math.floor(minutes / 60)), minutes: String(minutes % 60) };
}

/** "1 follow-back" · "3 follow-backs": the count and the word in the right number. */
export function plural(n: number, one: string, other: string): string {
  return `${count(n)} ${PLURAL.select(n) === 'one' ? one : other}`;
}

/** A week of contiguous plan-days: inside it a group is named by its weekday, beyond it by its date. */
const WEEK_DAYS = 7;

/**
 * A day group's header over contiguous plan-days, today first (`index` 0): "Today", "Yesterday", then the
 * weekday inside the week and the date beyond it.
 */
export function dayHeader(startsAt: number, index: number): string {
  if (index === 0) return 'Today';
  if (index === 1) return 'Yesterday';
  return index < WEEK_DAYS ? WEEKDAY.format(startsAt) : DATE.format(startsAt);
}

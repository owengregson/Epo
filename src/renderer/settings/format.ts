/**
 * Formatting for the Settings stage: copy templates filled from the view, local wall-clock times, waits as
 * "5 m 4 s", and a parameter's value in its unit. Pure; the numbers always come from the caller.
 */
import { commas } from '@/renderer/lib/format';
import type { ParamValue } from '@/shared/settings-model';
import type { ParamUnit } from '@/shared/settings-params';

/** Fill `{name}` slots; a missing value leaves its slot visible rather than inventing one. */
export function fill(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (slot, name: string) => {
    const v = vars[name];
    return v === undefined ? slot : typeof v === 'number' ? commas(v) : v;
  });
}

const MINUTES_PER_DAY = 24 * 60;

/** A local minute of the day as the user's clock shows it ("11:30 PM"). */
export function minuteLabel(minute: number): string {
  const m = ((Math.round(minute) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const d = new Date(2000, 0, 1, Math.floor(m / 60), m % 60);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** An hour of the day as the user's clock names it ("12 AM", "6 PM"). */
export function hourLabel(hour: number): string {
  return new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, { hour: 'numeric' });
}

/** An instant as a local time ("9:40 PM"). */
export function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** A span of local times ("1:52 PM – 3:10 PM"). */
export function spanLabel(from: number, to: number): string {
  return `${timeLabel(from)} – ${timeLabel(to)}`;
}

/** A wait in seconds as "5 m 4 s" (or "45 s"); never split between a number and its unit. */
export function waitLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const out = m === 0 ? `${s} s` : `${m} m ${s % 60} s`;
  return out.replace(/ /g, ' ');
}

/** A follower count as the seed line shows it: "940", "12.4k", "1.2M". */
export function compact(n: number): string {
  const steps: ReadonlyArray<[number, string]> = [[1_000_000, 'M'], [1_000, 'k']];
  for (const [size, unit] of steps) {
    if (n >= size) return `${trimZero((n / size).toFixed(1))}${unit}`;
  }
  return commas(n);
}

const trimZero = (t: string): string => t.replace(/\.0$/, '');

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_DAYS = 7;

/** How long ago something was checked: "just now", "12 min ago", "3 h ago", "2 days ago", or its date. */
export function agoLabel(at: number, now: number): string {
  const ago = Math.max(0, now - at);
  if (ago < MINUTE_MS) return 'just now';
  if (ago < HOUR_MS) return `${Math.floor(ago / MINUTE_MS)} min ago`;
  if (ago < DAY_MS) return `${Math.floor(ago / HOUR_MS)} h ago`;
  const days = Math.floor(ago / DAY_MS);
  if (days < WEEK_DAYS) return days === 1 ? '1 day ago' : `${days} days ago`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** A number of days as a person says it: "2 days", "1 week", "2 weeks". */
export function daysLabel(n: number): string {
  if (n > 0 && n % WEEK_DAYS === 0) return n === WEEK_DAYS ? '1 week' : `${n / WEEK_DAYS} weeks`;
  return n === 1 ? '1 day' : `${commas(n)} days`;
}

/** A count with its noun ("1 follow", "3 follows"). */
export function count(n: number, one: string, many: string): string {
  return `${commas(n)} ${n === 1 ? one : many}`;
}

const trim = (n: number, digits: number): string => String(Number(n.toFixed(digits)));

/** One number in its parameter unit, as a row shows it. */
export function unitLabel(n: number, unit: ParamUnit): string {
  switch (unit) {
    case 'seconds': return waitLabel(n);
    case 'ms': return waitLabel(n / 1000);
    case 'percent': return `${trim(n, 1)}%`;
    case 'share': return `${trim(n * 100, 1)}%`;
    case 'factor': return `×${n.toFixed(1)}`;
    case 'hours': return `${trim(n, 2)} h`;
    case 'days': return count(n, 'day', 'days');
    case 'per-day': return `${commas(n)} a day`;
    case 'per-hour': return `${commas(n)} an hour`;
    case 'ratio': return trim(n, 2);
    default: return n >= 1000 ? commas(n) : trim(n, 2);
  }
}

/** Any parameter value as text: numbers in their unit, ranges as "a–b", a curve as its six points. */
export function valueLabel(v: ParamValue, unit: ParamUnit): string {
  if (typeof v === 'number') return unitLabel(v, unit);
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if ('min' in v) return `${unitLabel(v.min, unit)}–${unitLabel(v.max, unit)}`;
  return [v.hardLow, v.bandLow, v.peakLow, v.peakHigh, v.bandHigh, v.hardHigh].map((x) => trim(x, 2)).join(' · ');
}

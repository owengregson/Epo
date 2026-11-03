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

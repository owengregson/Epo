/**
 * Units of measure as brands, so a duration, a probability and a rate cannot be
 * swapped by a tired refactor.
 *
 * `Settings.gapMedianSeconds` and `SESSION.GAP_CAP_MS` are both `number` today;
 * one is 95, the other 900_000, and nothing but a name keeps them apart. Here
 * `minutes(3)` is an `Ms` and `Ms * Ms` does not typecheck — arithmetic goes
 * through the helpers at the bottom, which are the only places a branded number
 * is unwrapped and rebranded.
 */

import type { Brand } from './brand';

/** A duration in milliseconds. Always finite; never negative. */
export type Ms = Brand<number, 'Ms'>;

/** A dimensionless proportion in `[0, 1]`. */
export type Fraction = Brand<number, 'Fraction'>;

/** A rate: events per 24 h. */
export type PerDay = Brand<number, 'PerDay'>;

/** A rate: events per 60 min. */
export type PerHour = Brand<number, 'PerHour'>;

export const MS_PER_SECOND = 1_000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Refuse a value that cannot be a measurement at all. */
function finite(n: number, unit: string): number {
  if (!Number.isFinite(n)) throw new TypeError(`${unit} must be finite, got ${n}`);
  return n;
}

/** `n` milliseconds. Negative durations are refused, not clamped. */
export function ms(n: number): Ms {
  if (finite(n, 'Ms') < 0) throw new RangeError(`Ms must be >= 0, got ${n}`);
  return n as Ms;
}

export const seconds = (n: number): Ms => ms(n * MS_PER_SECOND);
export const minutes = (n: number): Ms => ms(n * MS_PER_MINUTE);
export const hours = (n: number): Ms => ms(n * MS_PER_HOUR);
export const days = (n: number): Ms => ms(n * MS_PER_DAY);

/** `n` as a proportion. Outside `[0, 1]` is a bug in the caller, so it throws. */
export function fraction(n: number): Fraction {
  if (finite(n, 'Fraction') < 0 || n > 1) throw new RangeError(`Fraction must be in [0,1], got ${n}`);
  return n as Fraction;
}

/** `n` events per day. */
export function perDay(n: number): PerDay {
  if (finite(n, 'PerDay') < 0) throw new RangeError(`PerDay must be >= 0, got ${n}`);
  return n as PerDay;
}

/** `n` events per hour. */
export function perHour(n: number): PerHour {
  if (finite(n, 'PerHour') < 0) throw new RangeError(`PerHour must be >= 0, got ${n}`);
  return n as PerHour;
}

/** A duration scaled by a dimensionless factor. `Ms × Ms` stays unrepresentable. */
export const mulMs = (a: Ms, factor: number): Ms => ms(a * factor);

/** A duration divided by a dimensionless divisor. Dividing by 0 is refused. */
export function divMs(a: Ms, divisor: number): Ms {
  if (divisor === 0) throw new RangeError('divMs by zero');
  return ms(a / divisor);
}

/** `a` rounded UP to the next whole multiple of `step` — how timeouts are read. */
export function ceilTo(a: Ms, step: Ms): Ms {
  if (step <= 0) return ms(Math.ceil(a));
  return ms(Math.ceil(a / step) * step);
}

/** `a` confined to `[lo, hi]`. Reversed bounds are normalised, never trusted. */
export function clampMs(a: Ms, lo: Ms, hi: Ms): Ms {
  const low = Math.min(lo, hi);
  const high = Math.max(lo, hi);
  return ms(Math.min(high, Math.max(low, a)));
}

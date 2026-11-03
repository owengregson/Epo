/**
 * The circadian field λ(t) and the one plan-day boundary (ADR 0607, spec §4.4): the quiet minute is
 * the argmin of the weekday λ masked by quiet hours (ties → centre of the longest minimal run); a
 * plan-day runs from one local quiet minute to the next (23, 24 or 25 h; DST-safe through setHours).
 * Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from '../units';
import { PLAN_BOUNDS } from './policy';
import type { CircadianShape, PlanDayWindow } from './types';

/** A quiet-hours window on the local minute clock, [start, end) and possibly wrapping midnight. */
export interface QuietHours {
  readonly startMinute: number;
  readonly endMinute: number;
}

const HOURS_PER_DAY = MS_PER_DAY / MS_PER_HOUR;
const MINUTES_PER_HOUR = MS_PER_HOUR / MS_PER_MINUTE;
const MINUTES_PER_DAY = MS_PER_DAY / MS_PER_MINUTE;
const SECONDS_PER_HOUR = MINUTES_PER_HOUR * MINUTES_PER_HOUR;
const SATURDAY = 6;
const SUNDAY = 0;

function hourDistance(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, HOURS_PER_DAY - d);
}

/** λ at shifted local hour `h` ∈ [0, 24) for one weekday weight, clamped into [0, 1]. */
export function intensityAtHour(h: number, shape: CircadianShape, weight: number): number {
  let raw = shape.overnightFloor;
  for (const b of shape.bumps) {
    const dist = hourDistance(h, b.centerHour);
    raw += b.amplitude * Math.exp(-(dist * dist) / (2 * b.widthHours * b.widthHours));
  }
  return Math.min(1, Math.max(0, Math.min(1, raw) * weight));
}

/** Normalized λ at epoch-ms `nowMs`, read in local time (weekday weight, weekend shift, install phase). */
export function intensityAt(nowMs: number, shape: CircadianShape, phaseOffsetHours: number): number {
  const d = new Date(nowMs);
  const dow = d.getDay();
  const weekend = dow === SUNDAY || dow === SATURDAY;
  const local = d.getHours() + d.getMinutes() / MINUTES_PER_HOUR + d.getSeconds() / SECONDS_PER_HOUR;
  const shifted = local + phaseOffsetHours - (weekend ? shape.weekendShiftHours : 0);
  const h = ((shifted % HOURS_PER_DAY) + HOURS_PER_DAY) % HOURS_PER_DAY;
  return intensityAtHour(h, shape, shape.weekdayWeights[dow] ?? 1);
}

/** True when the local minute of day lies inside the quiet window (an empty window masks nothing). */
export function inQuietHours(minuteOfDay: number, quiet: QuietHours | null): boolean {
  if (quiet === null || quiet.startMinute === quiet.endMinute) return false;
  return quiet.startMinute < quiet.endMinute
    ? minuteOfDay >= quiet.startMinute && minuteOfDay < quiet.endMinute
    : minuteOfDay >= quiet.startMinute || minuteOfDay < quiet.endMinute;
}

/** The local minute of the day at `t` (0..1439). */
export function localMinuteOf(t: number): number {
  const d = new Date(t);
  return d.getHours() * MINUTES_PER_HOUR + d.getMinutes();
}

/** λ masked by quiet hours at an instant (0 inside quiet hours). */
export function maskedIntensityAt(t: number, shape: CircadianShape, phase: number, quiet: QuietHours | null): number {
  return inQuietHours(localMinuteOf(t), quiet) ? 0 : intensityAt(t, shape, phase);
}

/**
 * The plan-day boundary's minute of the local day: the argmin of the weekday λ times the quiet mask
 * on a one-minute grid; ties break to the centre of the longest minimal (circular) run.
 */
export function quietMinute(shape: CircadianShape, phaseOffsetHours: number, quiet: QuietHours | null): number {
  const values: number[] = [];
  for (let m = 0; m < MINUTES_PER_DAY; m += 1) {
    const h = (((m / MINUTES_PER_HOUR + phaseOffsetHours) % HOURS_PER_DAY) + HOURS_PER_DAY) % HOURS_PER_DAY;
    values.push(inQuietHours(m, quiet) ? 0 : intensityAtHour(h, shape, 1));
  }
  const min = Math.min(...values);
  const isMin = values.map((v) => v === min);
  if (isMin.every(Boolean)) return 0;
  // Walk from just after a non-minimal minute, so a run wrapping midnight is seen whole and the
  // walk's last step (that same minute) closes any open run.
  const first = isMin.indexOf(false);
  let best = { start: 0, len: 0 };
  let runStart = 0;
  let runLen = 0;
  for (let i = 1; i <= MINUTES_PER_DAY; i += 1) {
    if (isMin[(first + i) % MINUTES_PER_DAY]) {
      if (runLen === 0) runStart = first + i;
      runLen += 1;
    } else if (runLen > 0) {
      if (runLen > best.len) best = { start: runStart, len: runLen };
      runLen = 0;
    }
  }
  return (best.start + Math.floor(best.len / 2)) % MINUTES_PER_DAY;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** The local date `t` falls on, 'YYYY-MM-DD'. */
export function localDateKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The local instant at `minuteOfDay` on the local date of `t`, shifted by `dayDelta` days. */
function atMinute(t: number, minuteOfDay: number, dayDelta: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayDelta,
    Math.floor(minuteOfDay / MINUTES_PER_HOUR), minuteOfDay % MINUTES_PER_HOUR).getTime();
}

/** The plan-day holding `now`: from the most recent local quiet minute to the next one. */
export function planDayWindow(now: number, quietMinuteOfDay: number): PlanDayWindow {
  let startsAt = atMinute(now, quietMinuteOfDay, 0);
  if (startsAt > now) startsAt = atMinute(now, quietMinuteOfDay, -1);
  let endsAt = atMinute(startsAt, quietMinuteOfDay, 1);
  // A quiet minute inside a skipped DST hour normalizes forward; the next start is still after this one.
  if (endsAt <= now) {
    startsAt = endsAt;
    endsAt = atMinute(startsAt, quietMinuteOfDay, 1);
  }
  return { key: localDateKey(startsAt), startsAt, endsAt, quietMinute: quietMinuteOfDay };
}

/** Counters scale by length / 24 h below the proration cut-off; DST days keep them whole. */
export function prorateFor(lengthMs: number): number {
  return lengthMs < PLAN_BOUNDS.PRORATE_BELOW_HOURS * MS_PER_HOUR ? lengthMs / MS_PER_DAY : 1;
}

/** The plan-day after a boundary change: from the old end to the first new quiet minute ≥ 12 h later. */
export function transitionDay(prevEndsAt: number, newQuietMinute: number): PlanDayWindow & { readonly prorate: number } {
  const earliest = prevEndsAt + PLAN_BOUNDS.TRANSITION_MIN_HOURS * MS_PER_HOUR;
  let endsAt = atMinute(earliest, newQuietMinute, 0);
  if (endsAt < earliest) endsAt = atMinute(earliest, newQuietMinute, 1);
  return {
    key: localDateKey(prevEndsAt), startsAt: prevEndsAt, endsAt, quietMinute: newQuietMinute,
    prorate: prorateFor(endsAt - prevEndsAt),
  };
}

/** Cumulative λ_eff mass over a span on the plan's grid, in λ-hours; quantiles interpolate. */
export interface MassCurve {
  readonly from: number;
  readonly step: number;
  readonly cum: readonly number[];
}

export function massCurve(from: number, to: number, shape: CircadianShape, phase: number, quiet: QuietHours | null): MassCurve {
  const step = PLAN_BOUNDS.GRID_MINUTES * MS_PER_MINUTE;
  const cum = [0];
  for (let t = from; t < to; t += step) {
    const width = Math.min(step, to - t);
    cum.push(cum[cum.length - 1] + (maskedIntensityAt(t, shape, phase, quiet) * width) / MS_PER_HOUR);
  }
  return { from, step, cum };
}

/** The λ_eff mass of [from, to). */
export function massBetween(from: number, to: number, shape: CircadianShape, phase: number,
  quiet: QuietHours | null = null): number {
  if (!(to > from)) return 0;
  const c = massCurve(from, to, shape, phase, quiet);
  return c.cum[c.cum.length - 1];
}

/** The instant where the curve's cumulative mass reaches fraction `q` of its total. */
export function quantileOf(curve: MassCurve, q: number): number {
  const total = curve.cum[curve.cum.length - 1];
  const target = Math.min(1, Math.max(0, q)) * total;
  let lo = 0;
  let hi = curve.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (curve.cum[mid] < target) lo = mid;
    else hi = mid;
  }
  const span = curve.cum[hi] - curve.cum[lo];
  const frac = span > 0 ? (target - curve.cum[lo]) / span : 0;
  return Math.round(curve.from + (lo + frac) * curve.step);
}

/** The instant inside the window where the λ_eff mass reaches fraction `q` of the window's mass. */
export function massQuantileAt(window: PlanDayWindow, shape: CircadianShape, phase: number, q: number,
  quiet: QuietHours | null = null): number {
  return quantileOf(massCurve(window.startsAt, window.endsAt, shape, phase, quiet), q);
}

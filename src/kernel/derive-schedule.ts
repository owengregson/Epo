/**
 * Tier 2 — the schedule derivations of Settings (ADR 0608, spec §6.2): the derived quiet window, the hourly
 * intensity previews, the session mass with quiet hours and days off masked, and the feasibility rule.
 * `DayShape`, `WeeklyShape` and `OrdinalPattern` are the kernel's own; kernel siblings only.
 */

import { type Bump, type DayShape, dayShapeBumps, type OrdinalPattern, overnightFloor, type WeeklyShape, weeklyWeights } from './derive';
import { ENVELOPE } from './derive-envelope';
import { EMPIRICAL } from './fundamentals';
import { SETTINGS_POLICY } from './settings-policy';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from './units';

/** A local wall-clock window in minutes [0, 1440); it may wrap midnight. */
export interface QuietWindow { readonly startMinute: number; readonly endMinute: number }

const MINUTES_PER_DAY = MS_PER_DAY / MS_PER_MINUTE;
const MINUTES_PER_HOUR = MS_PER_HOUR / MS_PER_MINUTE;
const HOURS_PER_DAY = MS_PER_DAY / MS_PER_HOUR;
/** The session-mass integration grid: 5-minute steps, as `sessionMassHours` integrates. */
const MASS_STEPS = HOURS_PER_DAY * (MINUTES_PER_HOUR / 5);
const SUNDAY = 0;
const SATURDAY = 6;

/** Twelve significant digits: the precision `sessionMassHours` reports. */
const exact = (n: number): number => Number.parseFloat(n.toPrecision(12));

/** Normalized λ at local hour `h`: the field `sessionMassHours` integrates (law-pinned to it). */
function lambdaAt(h: number, bumps: readonly Bump[], floor: number, weight: number): number {
  let raw = floor;
  for (const b of bumps) {
    const d = Math.abs(h - b.centerHour);
    const dist = Math.min(d, HOURS_PER_DAY - d);
    raw += b.amplitude * Math.exp(-(dist * dist) / (2 * b.widthHours * b.widthHours));
  }
  return Math.min(1, Math.max(0, Math.min(1, raw) * weight));
}

const wrap = (m: number, period: number): number => ((m % period) + period) % period;
const snap = (m: number): number =>
  wrap(Math.round(m / SETTINGS_POLICY.QUIET_GRID_MINUTES) * SETTINGS_POLICY.QUIET_GRID_MINUTES, MINUTES_PER_DAY);

/** Whether local minute `m` falls inside `w` (wrapping windows included). */
export function inWindow(m: number, w: QuietWindow): boolean {
  return w.startMinute < w.endMinute
    ? m >= w.startMinute && m < w.endMinute
    : m >= w.startMinute || m < w.endMinute;
}

/**
 * The derived quiet window: the contiguous overnight run (the one holding the trough) where the weekday λ
 * stays below `QUIET_INTENSITY_FRACTION` × its peak, edges snapped to the grid, at most `QUIET_MAX_HOURS`.
 */
export function deriveQuietHours(dayShape: DayShape): QuietWindow {
  const bumps = dayShapeBumps(dayShape);
  const floor = overnightFloor(dayShape);
  const lambda = Array.from({ length: MINUTES_PER_DAY }, (_, m) => lambdaAt(m / MINUTES_PER_HOUR, bumps, floor, 1));
  const peak = Math.max(...lambda);
  const quiet = lambda.map((v) => v < SETTINGS_POLICY.QUIET_INTENSITY_FRACTION * peak);
  const trough = lambda.indexOf(Math.min(...lambda));
  let start = trough;
  let end = trough;
  let length = 1;
  while (length < MINUTES_PER_DAY && quiet[wrap(start - 1, MINUTES_PER_DAY)]) [start, length] = [start - 1, length + 1];
  while (length < MINUTES_PER_DAY && quiet[wrap(end + 1, MINUTES_PER_DAY)]) [end, length] = [end + 1, length + 1];
  const maxMinutes = SETTINGS_POLICY.QUIET_MAX_HOURS * MINUTES_PER_HOUR;
  const centre = start + length / 2;
  const kept = Math.min(length, maxMinutes);
  const from = snap(centre - kept / 2);
  const to = snap(centre + kept / 2);
  return { startMinute: from, endMinute: to === from ? snap(to + SETTINGS_POLICY.QUIET_GRID_MINUTES) : to };
}

/** The hour-of-day shift of the weekend curve (the weekday curve has none). */
const shiftOf = (dow: number): number =>
  dow === SUNDAY || dow === SATURDAY ? EMPIRICAL.HUMAN_CIRCADIAN.weekendShiftHours : 0;

/** λ for a weekday at local hour `h`, its weight and weekend shift applied. */
function dayLambda(p: Pick<OrdinalPattern, 'dayShape' | 'weeklyShape'>, dow: number, h: number): number {
  const weight = weeklyWeights(p.weeklyShape)[dow] ?? 1;
  return lambdaAt(wrap(h - shiftOf(dow), HOURS_PER_DAY), dayShapeBumps(p.dayShape), overnightFloor(p.dayShape), weight);
}

/** 24 hourly intensities (0..1) for a weekday: the mean λ over each local hour. */
export function hourlyIntensity(dayShape: DayShape, weeklyShape: WeeklyShape, dow: number): number[] {
  const perHour = MASS_STEPS / HOURS_PER_DAY;
  return Array.from({ length: HOURS_PER_DAY }, (_, hour) => {
    let sum = 0;
    for (let i = 0; i < perHour; i += 1) sum += dayLambda({ dayShape, weeklyShape }, dow, hour + i / perHour);
    return exact(sum / perHour);
  });
}

/** `∫λ dt` over an average week-day with the quiet window and days off at zero (= `sessionMassHours` unmasked). */
export function sessionMassMasked(
  p: Pick<OrdinalPattern, 'dayShape' | 'weeklyShape'>, quiet: QuietWindow | null, daysOff: readonly number[],
): number {
  let total = 0;
  for (let dow = SUNDAY; dow <= SATURDAY; dow += 1) {
    if (daysOff.includes(dow)) continue;
    let day = 0;
    for (let i = 0; i < MASS_STEPS; i += 1) {
      const h = (i * HOURS_PER_DAY) / MASS_STEPS;
      if (quiet !== null && inWindow(h * MINUTES_PER_HOUR, quiet)) continue;
      day += dayLambda(p, dow, h);
    }
    total += (day / MASS_STEPS) * HOURS_PER_DAY;
  }
  return exact(total / (SATURDAY + 1));
}

export interface ScheduleFeasibility {
  readonly kind: 'ok' | 'short';
  readonly reachablePerDay: number;
  readonly binding: 'hourly-cap' | 'active-time' | null;
}

/**
 * Can the volume fit the active time at the cap? `'hourly-cap'` binds when the envelope's highest cap would
 * make it reachable, else `'active-time'` (the rule `deriveOperatingPlan` uses).
 */
export function feasibility(i: { readonly dailyVolume: number; readonly hourlyCap: number; readonly massHours: number }): ScheduleFeasibility {
  const reachable = i.hourlyCap * i.massHours;
  if (i.dailyVolume <= reachable) return { kind: 'ok', reachablePerDay: Math.floor(reachable), binding: null };
  const binding = i.dailyVolume <= ENVELOPE.hourlyCap.max * i.massHours ? 'hourly-cap' : 'active-time';
  return { kind: 'short', reachablePerDay: Math.floor(reachable), binding };
}

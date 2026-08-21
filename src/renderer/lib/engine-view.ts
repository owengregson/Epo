import type { EpoStatus, Settings } from '@/types';

export type EngineState = EpoStatus['state'];

/** Display label for an engine state. */
export function stateLabel(state: EngineState): string {
  switch (state) {
    case 'running':
      return 'Running';
    case 'paused':
      return 'Paused';
    case 'halted':
      return 'Halted';
    default:
      return 'Idle';
  }
}

/** Whole-hour → "08:00". */
export function hh(v: number): string {
  return `${String(v).padStart(2, '0')}:00`;
}

/** "08:00 – 22:00" from the active-hours settings. */
export function activeHoursText(s: Settings): string {
  return `${hh(s.activeHoursStart)} – ${hh(s.activeHoursEnd)}`;
}

/** Whether `nowHour` (0..23) falls inside the active window (handles wrap-around). */
export function hoursOpen(s: Settings, nowHour: number): boolean {
  const a = s.activeHoursStart;
  const b = s.activeHoursEnd;
  return a <= b ? nowHour >= a && nowHour < b : nowHour >= a || nowHour < b;
}

export interface DailyRateView {
  /** Actions recorded today. */
  done: number;
  /** Today's planned volume (falls back to the configured operating rate
   *  before status arrives), or null before either loads. */
  rate: number | null;
  /** Meter fill 0..100 (capped). */
  pct: number;
}

/**
 * The Actions-today meter model, shared by the Live Status hero and the
 * Rate & Safety card so the two readouts can never drift apart. The
 * denominator is the engine's per-cycle PLAN — the number today actually
 * stops at — so the meter completes instead of sticking just short of the
 * configured rate.
 */
export function dailyRateView(status: EpoStatus | null, settings: Settings | null): DailyRateView {
  const done = status?.actionsToday ?? 0;
  const rate = status?.plannedToday ?? settings?.dailyOperatingRate ?? null;
  const pct = rate != null && rate > 0 ? Math.min(100, (done / rate) * 100) : 0;
  return { done, rate, pct };
}

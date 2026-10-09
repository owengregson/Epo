import type { EpoStatus, PruneState, Settings } from '@/types';

export type EngineState = EpoStatus['state'];

/** Which driver the shell's transport controls (mirrors main's tab driver token). */
export type TransportDriver = 'growth' | 'prune';

/** The unified console posture the shell derives from BOTH status channels. */
export interface TransportModel {
  /** Drives `.console[data-state]` and the Start/Pause/Cancel posture. */
  state: EngineState;
  driver: TransportDriver;
  /** Prune is walking lists — no between-action boundary, so Pause locks. */
  pruneScanning: boolean;
}

/**
 * ONE transport for two drivers (the unified-status contract): while a prune
 * holds the tab its state wins — the growth engine underneath is idle or
 * parked-for-prune, and projecting THAT made the top bar offer a Start that
 * main could only refuse (`prune-running`). A prune scan/run reads as running;
 * a paused prune reads as paused (Resume routes back to the prune); any other
 * prune state defers to the growth engine's own projection.
 */
export function transportModel(
  engine: EngineState | undefined,
  prune: PruneState | undefined,
): TransportModel {
  if (prune === 'scanning' || prune === 'running' || prune === 'paused') {
    return {
      state: prune === 'paused' ? 'paused' : 'running',
      driver: 'prune',
      pruneScanning: prune === 'scanning',
    };
  }
  return { state: engine ?? 'idle', driver: 'growth', pruneScanning: false };
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

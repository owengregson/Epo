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

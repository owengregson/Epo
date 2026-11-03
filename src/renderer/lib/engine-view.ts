import type { Settings } from '@/types';

/**
 * What is left of the old console's engine view: the active-hours label the old Settings card reads.
 * The live column's posture (`src/shared/posture.ts`) replaced the rest.
 */

/** Whole-hour → "08:00". */
export function hh(v: number): string {
  return `${String(v).padStart(2, '0')}:00`;
}

/** "08:00 – 22:00" from the active-hours settings. */
export function activeHoursText(s: Settings): string {
  return `${hh(s.activeHoursStart)} – ${hh(s.activeHoursEnd)}`;
}

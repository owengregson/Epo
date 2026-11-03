/**
 * The sweep half of the cadence facts: whether the follow-back sweep is due
 * under its persisted cadence and the live sweep interval.
 */

import type { Settings } from '../settings/settings';
import { MS_PER_HOUR } from '../timing/units';
import type { SweepCadence } from './ports';

/** What the sweep fact reads (the Engine's fact deps satisfy it). */
export interface CadenceFactDeps {
  sweepCadence: SweepCadence;
  /** Live settings (swapped between steps). */
  settings(): Settings;
}

/** Whether the follow-back sweep is due at `now`. */
export function sweepDue(d: CadenceFactDeps, now: number): boolean {
  return d.sweepCadence.isDue(now, d.settings().followbackSweepHours * MS_PER_HOUR);
}

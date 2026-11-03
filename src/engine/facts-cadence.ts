/**
 * The sweep half of the cadence facts (spec §9.6, C11): a planned check is due from the last sweep's
 * end — a check whose steps were all fresh still counts as done. Without the plan (the legacy model)
 * the sweep keeps its interval from that same end.
 */

import type { Settings } from '../settings/settings';
import { MS_PER_HOUR } from '../timing/units';
import type { EnginePacing } from './plan-port';
import type { SweepCadence } from './ports';

/** What the sweep fact reads (the Engine's fact deps satisfy it). */
export interface CadenceFactDeps {
  sweepCadence: SweepCadence;
  /** The plan, or undefined in the legacy model. */
  pacing?: EnginePacing;
  /** Live settings (swapped between steps). */
  settings(): Settings;
}

/** Whether the follow-back sweep is due at `now`: the plan's `checkDue` on the sweep's end, or the legacy interval. */
export function sweepDue(d: CadenceFactDeps, now: number): boolean {
  const anchor = d.sweepCadence.lastSweepEndedAt;
  if (d.pacing !== undefined && anchor !== undefined) return d.pacing.view(now).checkDue(anchor.call(d.sweepCadence));
  return d.sweepCadence.isDue(now, d.settings().followbackSweepHours * MS_PER_HOUR);
}

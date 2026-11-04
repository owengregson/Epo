/** The plan decides when a check is due from the last completed sweep. */
import type { EnginePacing } from './plan-port';
import type { SweepCadence } from './ports';

export interface CadenceFactDeps {
  sweepCadence: SweepCadence;
  pacing: EnginePacing;
}

export function sweepDue(d: CadenceFactDeps, now: number): boolean {
  return d.pacing.view(now).checkDue(d.sweepCadence.lastSweepEndedAt());
}

/**
 * The Boost rows' handlers and typed fallbacks (spec §8.5), spread into `src/main/ipc.ts`. With the
 * Boost control wired every command runs through it; without it every command is refused with a
 * typed reason and the preview is null — Boost stays off, never a silent no-op.
 */

import type { IpcFallbacks, IpcHandlers } from '@/ipc/register';
import type { BoostControl } from '@/main/modules/boost-control';
import type { BoostCommandResult, BoostView } from '@/shared/boost';

type PlanRow = 'startBoost' | 'endBoost' | 'previewBoost';

/** No Boost window: the view while the plan core is not wired. */
export const BOOST_OFF: BoostView = {
  state: 'off', startedAt: null, endsAt: null, effectiveFrom: null, followsDuring: null, lastEnded: null,
};

const refused = (): BoostCommandResult => ({ kind: 'refused', reason: 'internal', boost: BOOST_OFF });

export function planHandlers(control: BoostControl | null = null): Pick<IpcHandlers, PlanRow> {
  if (control === null) return { startBoost: refused, endBoost: refused, previewBoost: () => null };
  return {
    startBoost: (hours, opts) => control.startBoost(hours, opts),
    endBoost: () => control.endBoost(),
    previewBoost: (hours) => control.previewBoost(hours),
  };
}

export function planFallbacks(): Pick<IpcFallbacks, PlanRow> {
  return { startBoost: refused, endBoost: refused, previewBoost: () => null };
}

/**
 * The Boost rows' handlers and typed fallbacks (spec §8.5), spread into
 * `src/main/ipc.ts`. Until the plan core lands every command is refused with a
 * typed reason and the preview is null; Boost stays off.
 */

import type { IpcFallbacks, IpcHandlers } from '@/ipc/register';
import type { BoostCommandResult, BoostView } from '@/shared/boost';

type PlanRow = 'startBoost' | 'endBoost' | 'previewBoost';

/** No Boost window: the view while the plan core is not wired. */
export const BOOST_OFF: BoostView = {
  state: 'off', startedAt: null, endsAt: null, effectiveFrom: null, followsDuring: null, lastEnded: null,
};

const refused = (): BoostCommandResult => ({ kind: 'refused', reason: 'internal', boost: BOOST_OFF });

export function planHandlers(): Pick<IpcHandlers, PlanRow> {
  return { startBoost: refused, endBoost: refused, previewBoost: () => null };
}

export function planFallbacks(): Pick<IpcFallbacks, PlanRow> {
  return { startBoost: refused, endBoost: refused, previewBoost: () => null };
}

/**
 * The Boost invoke rows (spec §8.5, §15.1): channel strings written here once and
 * spread into `CHANNELS`; `IpcContract` extends the contract. The Boost state
 * itself rides `EpoStatus.boost`. Type-only imports plus one frozen literal.
 */

import type { BoostCommandResult, BoostPreview } from '@/shared/boost';

export const PLAN_CHANNELS = {
  startBoost: 'boost:start',
  endBoost: 'boost:end',
  previewBoost: 'boost:preview',
} as const;

export interface PlanIpcContract {
  /** Start a Boost of `hours` (the Settings length); `alsoStart` starts Epo first when it is stopped. */
  startBoost: { req: [hours: number, opts: { alsoStart: boolean }]; res: BoostCommandResult };
  /** End the running Boost now. */
  endBoost: { req: []; res: BoostCommandResult };
  /** What a Boost of `hours` would do today; null when no plan exists. */
  previewBoost: { req: [hours: number]; res: BoostPreview | null };
}

/**
 * The surface report row's handler and typed fallback (spec §10.7, §15.1), spread into
 * `src/main/ipc.ts`. Until the parse-health stream wires the report, both answer the not-built
 * report: every area unseen, nothing recorded.
 */

import type { IpcFallbacks, IpcHandlers } from '@/ipc/register';
import { notBuiltSurfaceReport } from '@/main/modules/not-built';

export function surfaceHandlers(): Pick<IpcHandlers, 'surfaceReport'> {
  return { surfaceReport: () => notBuiltSurfaceReport(Date.now()) };
}

export function surfaceFallbacks(): Pick<IpcFallbacks, 'surfaceReport'> {
  return { surfaceReport: () => notBuiltSurfaceReport(Date.now()) };
}

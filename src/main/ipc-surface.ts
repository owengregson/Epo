/**
 * The surface report row's handler and typed fallback (spec §10.7, §15.1), spread into `src/main/ipc.ts`.
 * The handler answers the live graph's report; before a graph is built (or after it tore down) both answer
 * the not-built report: every area unseen, nothing recorded.
 */

import type { IpcFallbacks, IpcHandlers } from '@/ipc/register';
import { notBuiltSurfaceReport } from '@/main/modules/not-built';
import { liveSurfaceReporter } from '@/main/services/surface-wiring';

export function surfaceHandlers(): Pick<IpcHandlers, 'surfaceReport'> {
  return { surfaceReport: () => liveSurfaceReporter()?.report() ?? notBuiltSurfaceReport(Date.now()) };
}

export function surfaceFallbacks(): Pick<IpcFallbacks, 'surfaceReport'> {
  return { surfaceReport: () => notBuiltSurfaceReport(Date.now()) };
}

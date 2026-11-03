/**
 * The surface report invoke row (spec §10.7, §15.1): the Diagnostics pull; the summary rides
 * `EpoStatus.surface`. Channel string written here once and spread into `CHANNELS`. Type-only
 * imports plus one frozen literal.
 */

import type { SurfaceReport } from '@/shared/surface-health';

export const SURFACE_CHANNELS = {
  surfaceReport: 'surface:report',
} as const;

export interface SurfaceIpcContract {
  /** The surface health report: per-area states, recorded changes, the meters and a copyable text. */
  surfaceReport: { req: []; res: SurfaceReport };
}

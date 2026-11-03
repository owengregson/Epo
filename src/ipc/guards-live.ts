/**
 * Boundary guards for the live-data rows (spec §15.1, ADR 1009): shape only.
 * Spread into `GUARDS`; imported by `guards.ts` only.
 */

import { z } from 'zod';

const BOOL = z.boolean();

/** Checked against the row's argument tuple where `GUARDS` spreads it. */
export const LIVE_GUARDS = {
  setLogStream: [BOOL] as const,
};

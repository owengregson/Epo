/**
 * The engine kit's plan-side fakes: the in-memory follow-back sweep cadence.
 * Re-exported by `engine-harness.ts`, so suites import from either.
 */

import type { SweepCadence } from '@/engine/engine';

/**
 * The in-memory follow-back cadence: starts due (a fresh Engine's first
 * eligible step performs a catch-up sweep), then honours the configured
 * interval. Production injects a PERSISTED cadence instead (PRINCIPLES §3).
 */
export const memorySweepCadence = (): SweepCadence => {
  let last = 0;
  return {
    isDue: (now, everyMs) => now - last >= everyMs,
    markRun: (now) => {
      last = now;
    },
  };
};

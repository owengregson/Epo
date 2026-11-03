/**
 * D4 — the read retry's waits (spec §17.8): a read may be tried again (it fetches the same page), a
 * mutation never. The first wait spreads the envelope fetch's deadline over the read's retries, and no
 * wait outgrows that deadline; like every D4 value it never follows the session tempo.
 * Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

import { retryWait, timeoutFor } from './derive';
import { RUNTIME_POLICY } from './runtime-policy';

/** The read retry ladder's waits, in ms: its first wait and the cap every later one stops at. */
export const READ_RETRY_MS = {
  base: retryWait(timeoutFor('fetchEnvelope'), RUNTIME_POLICY.READ_RETRY_ATTEMPTS),
  cap: timeoutFor('fetchEnvelope'),
} as const;

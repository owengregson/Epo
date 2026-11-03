import type { TempoKey } from './keys';

/**
 * Keys whose consumers land in a later stream: `gap.action` with the cadence
 * switch (PR S2). Every other key has a call site; Phase I empties this list.
 */
export const PENDING_CONSUMERS: readonly TempoKey[] = ['gap.action'];

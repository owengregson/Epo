import type { TempoKey } from './keys';

/**
 * Keys whose consumers land in a later stream. Every key has a call site now (`gap.action` is
 * drawn at dispatch by the mutation cadence); Phase I keeps this list empty.
 */
export const PENDING_CONSUMERS: readonly TempoKey[] = [];

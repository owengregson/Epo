/**
 * The recovery's two read ports (spec §10.6): learned locations and operation names (persisted by
 * the production sink), and the identity oracle that keeps a located record's username continuous.
 */

import type { EndpointKind } from '@/surface/schema/endpoints';
import type { RecoveryRole } from '@/surface/sink';

export type { RecoveryRole } from '@/surface/sink';

/** Learned hints: patterns are tried first (consistent, then open); learned ops route at C2. */
export interface HintBook {
  patterns(endpoint: EndpointKind, role: RecoveryRole): readonly string[];
  learnedOps(): ReadonlyArray<{ readonly op: string; readonly kind: EndpointKind }>;
}

/** The username the store already holds for a pk (R7). */
export interface IdentityOracle {
  usernameOf(pk: string): string | undefined;
}

/** No learned hints: every recovery searches. */
export const NO_HINTS: HintBook = { patterns: () => [], learnedOps: () => [] };

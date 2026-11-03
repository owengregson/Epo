/**
 * Status composition (spec §15.3, §14 C22): the engine status plus the
 * graph-independent `basis`, then the current graph's contributors (aggregated
 * once per build by `graph-builder.ts`), then any extra contributors, in order.
 */

import type { BuiltGraph, StatusContributor } from '@/main/services/graph-types';
import type { StatusFields } from '@/shared/status-fields';
import type { EpoStatus } from '@/types';

export type { StatusContributor };

/** A status before composition: everything but the composed fields, which it may already carry. */
export type BaseStatus = Omit<EpoStatus, keyof StatusFields> & Partial<StatusFields>;

/** `basis`, graph-independent: a status composed over a built graph is 'built', else 'not-built'. */
export const basisOf = (graph: BuiltGraph | null): StatusFields['basis'] => (graph === null ? 'not-built' : 'built');

/** The engine status with every contributor's fields laid over it, in order. */
export function composeStatus(
  engineStatus: BaseStatus,
  contributors: readonly StatusContributor[],
  graph: BuiltGraph | null,
  now: number,
): EpoStatus {
  let status: EpoStatus = { ...engineStatus, basis: basisOf(graph) };
  for (const c of [...(graph?.statusContributors ?? []), ...contributors]) {
    status = { ...status, ...c.contribute(graph, now) };
  }
  return status;
}

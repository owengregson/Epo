/**
 * Status composition: the built engine status plus each contributor's fields,
 * merged in order. The Foundation passes no contributors yet.
 */

import type { BuiltGraph } from '@/main/services/graph-types';
import type { EpoStatus } from '@/types';

/** One source of status fields beyond the engine's own. */
interface StatusContributor {
  readonly name: string;
  contribute(graph: BuiltGraph | null, now: number): Partial<EpoStatus>;
}

/** The engine status with every contributor's fields laid over it, in order. */
export function composeStatus(
  engineStatus: EpoStatus,
  contributors: readonly StatusContributor[],
  graph: BuiltGraph | null,
  now: number,
): EpoStatus {
  let status = engineStatus;
  for (const c of contributors) status = { ...status, ...c.contribute(graph, now) };
  return status;
}

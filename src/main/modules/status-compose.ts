/**
 * Status composition (spec §15.3, §14 C22): the engine status plus the
 * graph-independent `basis`, then the current graph's contributors (aggregated
 * once per build by `graph-builder.ts`), then any extra contributors, in order.
 */

import type { BuiltGraph, StatusContributor } from '@/main/services/graph-types';
import type { BootView } from '@/shared/boot';
import type { StatusFields } from '@/shared/status-fields';
import type { EpoStatus } from '@/types';

export type { StatusContributor };

/** The account confirm-account verified: its pk and the username the signed-in page showed. */
export interface ConfirmedAccount {
  readonly pk: string;
  readonly username: string;
}

/**
 * The graph-independent contributors (spec §15.3): `boot` (readiness rides the status) and `account` (the
 * graph's username, confirmed only when confirm-account saw that username for that pk).
 */
export function bootContributors(d: { boot(): BootView; confirmed(): ConfirmedAccount | null }): readonly StatusContributor[] {
  return [
    { name: 'boot', contribute: () => ({ boot: d.boot() }) },
    {
      name: 'account',
      contribute: (graph) => {
        if (graph === null) return { account: null };
        const c = d.confirmed();
        const username = graph.ownUsername ?? null;
        return { account: { username, confirmed: c !== null && c.pk === graph.ownPk && c.username === username } };
      },
    },
  ];
}

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

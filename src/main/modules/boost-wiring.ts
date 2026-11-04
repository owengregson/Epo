/**
 * The Foundation-level Boost (spec §8.2, §8.5): the commands over the open graph's plan service, the
 * run intent and a Start queued behind the startup sequence like a user Start; the feed's Boost rows
 * read the window the plan persists. Signed out (no graph) every command is a typed refusal.
 */
import { BoostControl } from '@/main/modules/boost-control';
import type { BoostWindowLite } from '@/main/modules/feed-projection';
import type { BuiltGraph } from '@/main/services/graph-types';
import * as logger from '@/utils/logger';

type RunIntent = 'running' | 'stopped' | 'paused';

export interface BoostWiringDeps {
  graph(): Pick<BuiltGraph, 'plan' | 'store'> | null;
  /** The runtime coordinator: run intent, the operational block, and the command that advances intent. */
  runtime(): { snapshot(): { readonly desired: RunIntent; readonly blockedReason: string | null }; command(intent: 'running'): unknown };
  /** `Foundation.startEngine()`: queued behind the startup sequence, never refused while it runs. */
  startEngine(): Promise<unknown>;
  /** The configured seed handle ('' = none). */
  seed(): string;
  now?(): number;
}

export function boostControlOf(d: BoostWiringDeps): BoostControl {
  return new BoostControl({
    plan: () => d.graph()?.plan.service ?? null,
    runIntent: () => d.runtime().snapshot().desired,
    advanceRunIntent: () => {
      d.runtime().command('running');
    },
    startEngine: () => {
      d.startEngine().catch((e: unknown) => logger.error('boost: the queued Start failed', { error: String(e) }));
    },
    runtimeBlocked: () => d.runtime().snapshot().blockedReason !== null,
    hasSeed: () => d.seed().trim() !== '',
    followsSince: (t) => d.graph()?.store.tallySince(t).follow ?? null,
    now: d.now ?? (() => Date.now()),
  });
}

/** The window the plan persists, ended or not: the feed's started/ended Boost rows. */
export function boostWindowOf(graph: Pick<BuiltGraph, 'plan'>, now: number): BoostWindowLite | null {
  return graph.plan.service.snapshot(now).state.boost;
}

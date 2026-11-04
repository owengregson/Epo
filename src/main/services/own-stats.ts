/**
 * Own-account reads behind the mutation policy: resolving a username to its pk
 * through one fresh visit, and refreshing our own profile header counts.
 */

import type { OwnHeader } from '@/engine/census-authority';
import type { Clock } from '@/governors/clock';
import type { ReadBudget } from '@/governors/read-budget';
import type { ReadUse } from '@/kernel/plan';
import type { ProfileVisitor } from '@/rim/profile-visit-port';

/** A verified fresh own header (spec §10.4, Appendix D.1), or why none could be read. */
export type OwnStatsRefresh = { ok: true; header: OwnHeader } | {
  ok: false;
  reason: 'read-budget' | 'fresh-header-unavailable';
  retryAt?: number;
};

export interface OwnStatsDeps {
  ownPk: string;
  ownUsername?: string;
  clock: Clock;
  readBudget: ReadBudget;
  profiles(): ProfileVisitor;
  signal(): AbortSignal | undefined;
  onProgress?(phase: string): void;
  /** The identity and run-token check every write repeats. */
  active(): Promise<boolean>;
}

/** The identity resolution and own-header refresh of the mutation policy (see `mutation-policy.ts`). */
export function createOwnStats(d: OwnStatsDeps) {
  const { clock, readBudget, ownPk, active } = d;
  return {
    resolveIdentity: async (username: string): Promise<string | null> => {
      const token = d.signal();
      if (!await active() || token?.aborted || token !== d.signal()) return null;
      if (!readBudget.consume('profile', 'reconciliation').allowed) return null;
      const started = clock.now();
      const seen = await d.profiles().visit(username);
      if (!await active() || token?.aborted || token !== d.signal() || !seen.ok
        || !Number.isFinite(seen.obs.observedAt) || seen.obs.observedAt < started || seen.obs.observedAt > clock.now()) return null;
      d.onProgress?.('manual-identity-resolved');
      return seen.obs.accountPk;
    },
    refreshOwnStats: async (use: ReadUse = 'reconcile'): Promise<OwnStatsRefresh> => {
      if (!d.ownUsername || !await active()) return { ok: false, reason: 'fresh-header-unavailable' };
      const permit = readBudget.consume('profile', 'reconciliation', 1, use);
      if (!permit.allowed) return { ok: false, reason: 'read-budget', retryAt: permit.resumeAt ?? undefined };
      const started = clock.now();
      const seen = await d.profiles().visit(d.ownUsername, { pk: ownPk });
      const counted = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n);
      if (!await active() || !seen.ok || seen.obs.accountPk !== ownPk || !Number.isFinite(seen.obs.observedAt)
        || seen.obs.observedAt < started || seen.obs.observedAt > clock.now()) {
        return { ok: false, reason: 'fresh-header-unavailable' };
      }
      const { followers, following } = seen.obs.fields;
      if (!counted(followers) || !counted(following)) return { ok: false, reason: 'fresh-header-unavailable' };
      d.onProgress?.('own-header-verified');
      return { ok: true, header: { followers, following, observedAt: seen.obs.observedAt } };
    },
  };
}

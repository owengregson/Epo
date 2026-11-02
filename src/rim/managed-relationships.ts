import type { Clock } from '@/governors/clock';
import type { ReadBudget } from '@/governors/read-budget';
import type { ProfileVisitor } from './profile-visit-port';

/** Fresh relationship reads by immutable account ID, bounded by the account's shared allowance. */
export function managedRelationships(d: {
  clock: Clock;
  readBudget: ReadBudget;
  profiles: ProfileVisitor;
  signal(): AbortSignal | undefined;
  validateIdentity?(): Promise<boolean>;
  onProgress?(phase: string): void;
}) {
  return {
    read: async (accountPk: string, username: string): Promise<
      { ok: true; followsUs: boolean; observedAt: number }
      | { ok: false; reason: 'read-budget' | 'unavailable'; retryAt?: number }
    > => {
      const token = d.signal();
      const active = async (): Promise<boolean> => !token?.aborted && token === d.signal()
        && (!d.validateIdentity || await d.validateIdentity()) && !token?.aborted && token === d.signal();
      if (!await active()) return { ok: false, reason: 'unavailable' };
      const permit = d.readBudget.consume('profile', 'reconciliation');
      if (!permit.allowed) return { ok: false, reason: 'read-budget', retryAt: permit.resumeAt ?? undefined };
      const started = d.clock.now();
      const result = await d.profiles.visit(username);
      if (!await active() || !result.ok || result.obs.accountPk !== accountPk
        || !Number.isFinite(result.obs.observedAt) || result.obs.observedAt < started
        || result.obs.observedAt > d.clock.now() || result.viewer.followsUs === null) {
        return { ok: false, reason: 'unavailable' };
      }
      d.onProgress?.('managed-relationship-observed');
      return { ok: true, followsUs: result.viewer.followsUs, observedAt: result.obs.observedAt };
    },
  };
}

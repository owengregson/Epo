import { ActionAbortedError, ActionDeferredError } from '@/adapter/errors';
import type { FollowbackWatcher } from '@/engine/followback-watcher';
import { bioMatchesFilter } from '@/engine/prune-bio-filter';
import type { ReentrySupervisor } from '@/engine/reentry';
import { scoreCandidate } from '@/engine/scorer';
import type { Clock } from '@/governors/clock';
import type { RateGovernor } from '@/governors/rate-governor';
import type { ReadBudget } from '@/governors/read-budget';
import { reconcileEffects } from '@/rim/effect-reconciliation';
import type { ProfileVisitor } from '@/rim/profile-visit-port';
import { type Settings, toScorerConfig } from '@/settings/settings';
import type { KnowledgeStore } from '@/store/knowledge-store';

interface MutationPolicyDeps {
  store: KnowledgeStore;
  ownPk: string;
  ownUsername?: string;
  clock: Clock;
  rate: RateGovernor;
  reentry: ReentrySupervisor;
  readBudget: ReadBudget;
  profiles(): ProfileVisitor;
  followback(): FollowbackWatcher;
  settings(): Settings;
  signal(): AbortSignal | undefined;
  validateIdentity?(): Promise<boolean>;
  onProgress?(phase: string): void;
}

export type OwnStatsRefresh = { ok: true } | {
  ok: false;
  reason: 'read-budget' | 'fresh-header-unavailable';
  retryAt?: number;
};

/** Every writer proves identity and current relationship policy at the physical click boundary. */
export function createMutationPolicy(d: MutationPolicyDeps) {
  const { store, clock, rate, reentry, readBudget, ownPk } = d;
  const active = async (): Promise<boolean> => {
    const original = d.signal();
    return !original?.aborted && (!d.validateIdentity || await d.validateIdentity())
      && !original?.aborted && !d.signal()?.aborted && original === d.signal();
  };
  const budgetOpen = (): boolean => !rate.atHardCeiling() && !rate.atOperatingRate()
    && rate.actionsInLastHour() < d.settings().hourlyVelocityCap;
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
    beforeMutation: async (): Promise<void> => {
      if (!await active()) throw new ActionAbortedError('mutation-admission');
      if (!budgetOpen()) throw new ActionDeferredError('account mutation budget exhausted');
      const now = clock.now();
      if (reentry.requiresReconciliation(now)) throw new ActionDeferredError('relationship reconciliation required');
      if (reentry.mutationWaitUntil(now) !== null) throw new ActionDeferredError('return probation delay still owed');
      if ((store.getActionDelayDeadline() ?? 0) > now) throw new ActionDeferredError('shared mutation delay still owed');
      store.setActionDelayDeadline(now + rate.nextDelayMs());
    },
    prepareProfile: async (username: string, expectedPk: string, action: 'follow' | 'unfollow'): Promise<void> => {
      const token = d.signal();
      if (!await active()) throw new ActionAbortedError('profile-admission');
      const permit = readBudget.consume('profile', 'reconciliation');
      if (!permit.allowed) throw new ActionDeferredError('profile read budget exhausted');
      const started = clock.now();
      const seen = await d.profiles().visit(username);
      if (!await active() || token?.aborted || token !== d.signal()) throw new ActionAbortedError('profile-admission');
      if (!seen.ok || seen.obs.accountPk !== expectedPk || !Number.isFinite(seen.obs.observedAt)
        || seen.obs.observedAt < started || seen.obs.observedAt > clock.now()) {
        throw new ActionDeferredError('fresh profile identity unavailable or changed');
      }
      const now = seen.obs.observedAt;
      d.onProgress?.('mutation-profile-verified');
      if (seen.viewer.followsUs !== null) store.observeEdge(expectedPk, ownPk, 'follows', seen.viewer.followsUs, now);
      const account = store.getAccount(expectedPk);
      const rec = store.getFollowRecord(expectedPk);
      if (action === 'follow' && rec?.state === 'queued' && (!account || !scoreCandidate(account, toScorerConfig(d.settings())).eligible)) {
        store.upsertFollowRecord({ ...rec, score: 0 });
        throw new ActionDeferredError('profile no longer eligible');
      }
      if (action !== 'unfollow') return;
      if (store.getTarget(expectedPk) || account?.role === 'retained_target') throw new ActionDeferredError('source is protected');
      if (seen.viewer.followsUs === null) throw new ActionDeferredError('reciprocal relationship unresolved');
      if (!seen.viewer.followsUs) return;
      if (bioMatchesFilter(account?.bio, d.settings().pruneBioFilterWords)) throw new ActionDeferredError('mutual is protected by bio keep policy');
      if (rec?.state === 'unfollow_queued' && rec.followbackObservedAt === undefined && rec.followedBackAt === undefined) {
        store.upsertFollowRecord({ ...rec, state: 'followed_back', followbackObservedAt: now,
          holdUntil: now + d.settings().holdAfterFollowbackDays * 86_400_000, reconciledAt: now });
        throw new ActionDeferredError('new follow-back requires hold');
      }
      if (rec?.state !== 'unfollow_queued' || (rec.holdUntil ?? Infinity) > now) {
        throw new ActionDeferredError('reciprocal relationship is not due for removal');
      }
    },
    canAccept: async (): Promise<boolean> => !d.settings().dryRun && await active() && budgetOpen()
      && (store.getActionDelayDeadline() ?? 0) <= clock.now()
      && reentry.mutationWaitUntil(clock.now()) === null
      && !store.pendingEffectIntents().some((i) => i.state !== 'prepared'),
    onAccepted: (): void => {
      const now = clock.now();
      store.setActionDelayDeadline(now + rate.nextDelayMs());
      reentry.noteAction(now);
      d.onProgress?.('request-accepted');
    },
    refreshOwnStats: async (): Promise<OwnStatsRefresh> => {
      if (!d.ownUsername || !await active()) return { ok: false, reason: 'fresh-header-unavailable' };
      const permit = readBudget.consume('profile', 'reconciliation');
      if (!permit.allowed) return { ok: false, reason: 'read-budget', retryAt: permit.resumeAt ?? undefined };
      const started = clock.now();
      const seen = await d.profiles().visit(d.ownUsername);
      if (!await active() || !seen.ok || seen.obs.accountPk !== ownPk || !Number.isFinite(seen.obs.observedAt)
        || seen.obs.observedAt < started || seen.obs.observedAt > clock.now()
        || !Number.isFinite(seen.obs.fields.followers) || !Number.isFinite(seen.obs.fields.following)) {
        return { ok: false, reason: 'fresh-header-unavailable' };
      }
      d.onProgress?.('own-header-verified');
      return { ok: true };
    },
    prepareMutation: async (): Promise<boolean> => {
      const token = d.signal();
      const current = (): boolean => !token?.aborted && token === d.signal();
      if (!current() || !await active()) return false;
      const result = await reconcileEffects({ store, profiles: d.profiles(), ownPk, clock, readBudget, signal: d.signal });
      if (result.outcome !== 'complete' || !current() || !await active()) return false;
      if (reentry.requiresReconciliation(clock.now())) {
        const checked = await d.followback().check({ requireFresh: true, freshSinceAt: reentry.snapshot().reconciliationStartedAt ?? undefined });
        if (checked.outcome !== 'complete' || !current() || !await active()) return false;
        reentry.noteReconciled(checked, clock.now());
      }
      return current() && !reentry.requiresReconciliation(clock.now());
    },
  };
}

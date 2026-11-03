/**
 * The click review: before an action's click, one fresh profile visit proves
 * the identity, re-checks eligibility and settles the current relationship.
 */

import { ActionAbortedError, ActionDeferredError } from '@/adapter/errors';
import { bioMatchesFilter } from '@/engine/prune-bio-filter';
import { scoreCandidate } from '@/engine/scorer';
import type { Clock } from '@/governors/clock';
import type { ReadBudget } from '@/governors/read-budget';
import type { ProfileVisitor } from '@/rim/profile-visit-port';
import { type Settings, toScorerConfig } from '@/settings/settings';
import type { KnowledgeStore } from '@/store/knowledge-store';

export interface ClickReviewDeps {
  store: KnowledgeStore;
  ownPk: string;
  clock: Clock;
  readBudget: ReadBudget;
  profiles(): ProfileVisitor;
  settings(): Settings;
  signal(): AbortSignal | undefined;
  onProgress?(phase: string): void;
  /** The identity and run-token check every write repeats. */
  active(): Promise<boolean>;
}

/** The click-review half of the mutation policy (see `mutation-policy.ts`). */
export function createClickReview(d: ClickReviewDeps) {
  const { store, clock, readBudget, ownPk, active } = d;
  return {
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
  };
}

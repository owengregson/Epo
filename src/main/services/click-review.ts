/**
 * The click review: before an action's click, one fresh profile visit proves the identity,
 * re-checks eligibility, judges protection on the fresh fields and settles the current relationship.
 */

import { ActionAbortedError, ActionDeferredError, ActionReviewedError } from '@/adapter/errors';
import { freshSubject } from '@/engine/protection-gate';
import { scoreCandidate } from '@/engine/scorer';
import type { Clock } from '@/governors/clock';
import type { Admission } from '@/governors/plan-types';
import type { ReadBudget } from '@/governors/read-budget';
import type { MutationKind, Writer } from '@/kernel/plan';
import type { ProfileVisitor } from '@/rim/profile-visit-port';
import { type Settings, toScorerConfig } from '@/settings/settings';
import { protectionClickVerdict } from '@/shared/click-verdict';
import { NEVER_PAUSED, type SurfaceGate } from '@/shared/surface-gate';
import { type ProtectionIndex, protectionVerdict } from '@/shared/unfollow-protection';
import type { KnowledgeStore } from '@/store/knowledge-store';

export interface ClickReviewDeps {
  store: KnowledgeStore;
  ownPk: string;
  clock: Clock;
  readBudget: ReadBudget;
  profiles(): ProfileVisitor;
  settings(): Settings;
  /** The live protection index (the settings service's): every unfollow is judged on it (spec §7). */
  protection(): ProtectionIndex;
  signal(): AbortSignal | undefined;
  onProgress?(phase: string): void;
  /** The identity and run-token check every write repeats. */
  active(): Promise<boolean>;
  /** The plan's admission, asked BEFORE the visit (a refusal spends no read); the default admits. */
  preflight?(kind: MutationKind, writer: Writer, now: number, subject?: { pk: string; intentId?: string }): Admission;
  /** Which loop asks for the action (default: the growth loop). */
  writer?(): Writer;
  /** Pauses unfollows while the relationship surface is unconfirmed (default: never paused). */
  surfaceGate?: SurfaceGate;
}

/** Phase F: the plan admits everything here; today's checks keep running at `beforeMutation`. */
const ADMITS = (): Admission => ({ ok: true });

/** The click-review half of the mutation policy (see `mutation-policy.ts`). */
export function createClickReview(d: ClickReviewDeps) {
  const { store, clock, readBudget, ownPk, active } = d;
  return {
    prepareProfile: async (username: string, expectedPk: string, action: 'follow' | 'unfollow'): Promise<void> => {
      const token = d.signal();
      if (!await active()) throw new ActionAbortedError('profile-admission');
      const admission = (d.preflight ?? ADMITS)(action, d.writer?.() ?? 'growth', clock.now(), { pk: expectedPk });
      if (!admission.ok) {
        throw new ActionDeferredError(`plan refused: ${admission.reason}`, { reason: admission.reason, until: admission.until });
      }
      if (action === 'unfollow' && (d.surfaceGate ?? NEVER_PAUSED).paused('unfollows')) {
        throw new ActionDeferredError('surface paused: unfollows', { reason: 'surface-paused', until: null });
      }
      // A paused index refuses any unfollow whatever the subject, so it is judged before a read is spent.
      const paused = d.protection();
      if (action === 'unfollow' && paused.state !== 'ready') {
        throw new ActionReviewedError({ kind: 'protection-paused', state: paused.state });
      }
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
      // Step 5: protection on THIS body's own fields (never the folded row), before any follow-back logic.
      const verdict = protectionClickVerdict(protectionVerdict(freshSubject(seen.obs, username), d.protection()));
      if (verdict !== null) throw new ActionReviewedError(verdict);
      // Step 6: a source or the starting account is kept, a consuming verdict rather than a retried deferral.
      if (store.getTarget(expectedPk) || account?.role === 'retained_target') {
        throw new ActionReviewedError({ kind: 'protected', by: 'source', match: expectedPk });
      }
      if (seen.viewer.followsUs === null) throw new ActionDeferredError('reciprocal relationship unresolved');
      if (!seen.viewer.followsUs) return;
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

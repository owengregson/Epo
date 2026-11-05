/**
 * The click review (spec §9.7): before an action's click, one fresh profile visit proves the identity and,
 * in one order, the plan's admission, this account's journal, the surface gate, protection on the fresh
 * fields, requesters and the current relationship decide it. A refusal before the visit spends no read.
 */


import { ActionAbortedError, ActionDeferredError, ActionReviewedError } from '@/adapter/errors';
import { journalBlocks } from '@/engine/journal';
import { freshSubject } from '@/engine/protection-gate';
import { scoreCandidate } from '@/engine/scorer';
import type { Clock } from '@/governors/clock';
import type { Admission } from '@/governors/plan-types';
import type { ReadBudget } from '@/governors/read-budget';
import type { MutationKind, Writer } from '@/kernel/plan';
import { countsUnread, type ProfileSeen, type ProfileVisitor } from '@/rim/profile-visit-port';
import type { EffectiveSettings } from '@/settings/effective';
import { toScorerConfig } from '@/settings/mappers';
import { type ClickVerdict, protectionClickVerdict } from '@/shared/click-verdict';
import { NEVER_PAUSED, type SurfaceGate } from '@/shared/surface-gate';
import { type ProtectionIndex, protectionVerdict } from '@/shared/unfollow-protection';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { FollowRecord } from '@/store/types';

export interface ClickReviewDeps {
  store: KnowledgeStore;
  ownPk: string;
  clock: Clock;
  readBudget: ReadBudget;
  profiles(): ProfileVisitor;
  settings(): EffectiveSettings;
  /** The live protection index (the settings service's): every unfollow is judged on it (spec §7). */
  protection(): ProtectionIndex;
  signal(): AbortSignal | undefined;
  onProgress?(phase: string): void;
  /** The identity and run-token check every write repeats. */
  active(): Promise<boolean>;
  /** The plan's admission with this account's journal, asked BEFORE the visit (a refusal spends no read). */
  preflight?(kind: MutationKind, writer: Writer, now: number, subject?: { pk: string; intentId?: string }): Admission;
  /** Which loop asks for the action (default: the growth loop). */
  writer?(): Writer;
  /** Pauses unfollows while the relationship surface is unconfirmed (default: never paused). */
  surfaceGate?: SurfaceGate;
  /** Automatic follows must still belong to the durable quality cohort. Manual writes keep their own policy. */
  validateFollow?(record: FollowRecord): boolean;
}

/** With no plan wired, only the account's own journal refuses (the plan's preflight covers it otherwise). */
const journalOnly = (store: KnowledgeStore) => (_kind: MutationKind, _w: Writer, _now: number, subject?: { pk: string }): Admission =>
  subject !== undefined && journalBlocks(subject.pk, store.effectIntents.unsettledFor(subject.pk))
    ? { ok: false, reason: 'journal', until: null } : { ok: true };

const reviewed = (v: ClickVerdict): ActionReviewedError => new ActionReviewedError(v);
const deferred = (reason: string, until: number | null): ActionDeferredError =>
  new ActionDeferredError(`deferred before the visit: ${reason}`, { reason, until });

/** The click-review half of the mutation policy (see `mutation-policy.ts`). */
export function createClickReview(d: ClickReviewDeps) {
  const { store, clock, readBudget, ownPk, active } = d;
  let dispatchReview: { action: 'unfollow'; username: string; pk: string; seen: ProfileSeen }
    | { action: 'follow'; pk: string; managed: boolean } | null = null;

  /** Steps 0a–0c: the plan with this account's journal, the surface gate, a paused index, the read. */
  const admit = (action: 'follow' | 'unfollow', pk: string): void => {
    const admission = (d.preflight ?? journalOnly(store))(action, d.writer?.() ?? 'growth', clock.now(), { pk });
    if (!admission.ok) throw deferred(admission.reason, admission.until);
    if (action === 'unfollow' && (d.surfaceGate ?? NEVER_PAUSED).paused('unfollows')) throw deferred('surface-paused', null);
    // A paused index refuses any unfollow whatever the subject, so it is judged before a read is spent.
    const index = d.protection();
    if (action === 'unfollow' && index.state !== 'ready') throw reviewed({ kind: 'protection-paused', state: index.state });
    const permit = readBudget.consume('profile', 'reconciliation', 1, 'verify');
    if (!permit.allowed) throw deferred('read-budget', permit.resumeAt);
  };

  /** Steps 1–4: the visit's own outcome. A wall goes to the recovery ladder, unchanged. */
  const visit = async (username: string, pk: string, token: AbortSignal | undefined): Promise<ProfileSeen> => {
    const started = clock.now();
    const seen = await d.profiles().visit(username, { pk });
    if (!await active() || token?.aborted || token !== d.signal()) throw new ActionAbortedError('profile-admission');
    if (!seen.ok && seen.kind === 'walled') throw new ActionDeferredError('profile walled', { reason: 'walled', until: null });
    if (!seen.ok) throw reviewed({ kind: 'unavailable', evidence: seen.kind === 'gone' ? 'absent' : 'unreadable' });
    if (seen.obs.accountPk !== pk) throw reviewed({ kind: 'unavailable', evidence: 'renamed' });
    const t = seen.obs.observedAt;
    if (!Number.isFinite(t) || t < started || t > clock.now()) throw reviewed({ kind: 'unavailable', evidence: 'unreadable' });
    return seen;
  };

  /** Protection uses the current rules against this visit's evidence, including immediately before dispatch. */
  const protect = (username: string, pk: string, seen: ProfileSeen): void => {
    const verdict = protectionClickVerdict(protectionVerdict(freshSubject(seen.obs, username), d.protection()));
    if (verdict !== null) throw reviewed(verdict);
    if (store.getTarget(pk) || store.getAccount(pk)?.role === 'retained_target') {
      throw reviewed({ kind: 'protected', by: 'source', match: pk });
    }
  };

  /** Steps 5–13 on the fresh page (after its edge write); returning means proceed. */
  const unfollowReview = (username: string, pk: string, seen: ProfileSeen, now: number): void => {
    protect(username, pk, seen);
    const v = seen.viewer;
    // Step 7: they asked to follow you — the fresh flag (which also records the request) or an open request.
    const asked = v.incomingRequest === true;
    if (asked) store.observeEdge(pk, ownPk, 'requests', true, now);
    if (asked || store.getEdge(pk, ownPk, 'requests')?.status === 'active') throw reviewed({ kind: 'request-pending' });
    if (v.following === false && v.requested === false) throw reviewed({ kind: 'already-gone' });
    if (v.followsUs === null) throw reviewed({ kind: 'unavailable', evidence: 'unreadable' });
    const rec = store.getFollowRecord(pk);
    if (!v.followsUs) {
      if (rec !== null) store.upsertFollowRecord({ ...rec, reconciledAt: now });
      return;
    }
    const followedBack = rec?.followbackObservedAt !== undefined || rec?.followedBackAt !== undefined;
    if (rec?.state === 'unfollow_queued' && !followedBack) throw reviewed({ kind: 'reheld' });
    if (rec?.state !== 'unfollow_queued' || (rec.holdUntil ?? Infinity) > now) throw reviewed({ kind: 'not-due' });
  };

  /** Refresh the score without turning a quality-only deferral into permanent ineligibility. */
  const followReview = (pk: string, managed: boolean): void => {
    const rec = store.getFollowRecord(pk);
    if (rec?.state !== 'queued') {
      if (managed) throw new ActionDeferredError('follow no longer queued', { reason: 'source-quality', until: null });
      return;
    }
    const account = store.getAccount(pk);
    const scored = account ? scoreCandidate(account, toScorerConfig(d.settings())) : { score: 0, eligible: false };
    const fresh = { ...rec, score: scored.score };
    if (rec.score !== fresh.score) store.upsertFollowRecord(fresh);
    if (!scored.eligible) throw new ActionDeferredError('profile no longer eligible');
    if (managed && d.validateFollow && !d.validateFollow(fresh)) {
      throw new ActionDeferredError('profile below saved source quality', { reason: 'source-quality', until: null });
    }
  };

  return {
    /** Every press rechecks the live quality/protection policy, with no additional profile read. */
    dispatchGuard: (): (() => void) => {
      const r = dispatchReview;
      dispatchReview = null;
      return () => {
        if (r === null) return;
        if (r.action === 'follow') return followReview(r.pk, r.managed);
        if ((d.surfaceGate ?? NEVER_PAUSED).paused('unfollows')) throw deferred('surface-paused', null);
        protect(r.username, r.pk, r.seen);
        if (store.getEdge(r.pk, ownPk, 'requests')?.status === 'active') throw reviewed({ kind: 'request-pending' });
      };
    },
    prepareProfile: async (username: string, expectedPk: string, action: 'follow' | 'unfollow'): Promise<void> => {
      dispatchReview = null;
      const token = d.signal();
      if (!await active()) throw new ActionAbortedError('profile-admission');
      admit(action, expectedPk);
      const seen = await visit(username, expectedPk, token);
      // Recovered/partial facts may enrich the pool, but cannot prove a follow is still eligible (§10.6).
      if (action === 'follow' && (seen.tier === 'recovered' || seen.partial || countsUnread(seen))) {
        throw reviewed({ kind: 'unavailable', evidence: 'unreadable' });
      }
      const now = seen.obs.observedAt;
      d.onProgress?.('mutation-profile-verified');
      if (seen.viewer.followsUs !== null) store.observeEdge(expectedPk, ownPk, 'follows', seen.viewer.followsUs, now, { source: 'visit' });
      if (action === 'unfollow') {
        unfollowReview(username, expectedPk, seen, now);
        dispatchReview = { action, username, pk: expectedPk, seen };
        return;
      }
      const rec = store.getFollowRecord(expectedPk);
      const freshCounts = [seen.obs.fields.followers, seen.obs.fields.following]
        .every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0);
      if (rec?.state === 'queued' && !freshCounts) throw reviewed({ kind: 'unavailable', evidence: 'unreadable' });
      const managed = d.validateFollow !== undefined && (d.writer?.() ?? 'growth') === 'growth';
      followReview(expectedPk, managed);
      dispatchReview = { action, pk: expectedPk, managed };
    },
  };
}

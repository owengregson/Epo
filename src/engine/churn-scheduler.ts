import type { Clock } from '../governors/clock';
import type { RateGovernor } from '../governors/rate-governor';
import type { KnowledgeStore } from '../store/knowledge-store';
import { compareByScoreDesc, type EffectIntent, type FollowRecord } from '../store/types';
import { MS_PER_DAY } from '../timing/units';
import * as log from '../utils/logger';
import { CHURN_DEFAULTS, type ChurnActionOutcome, type ChurnActions, type ChurnConfig, type ChurnDeps, type VerbSpec } from './churn-types';
import { normalizeMutationOutcome } from './mutation-outcome';
import { bioMatchesFilter } from './prune-bio-filter';

export type { ChurnActionOutcome, ChurnActions, ChurnConfig, ChurnDeps } from './churn-types';
export { CHURN_DEFAULTS } from './churn-types';

/**
 * Drives every `FollowRecord` through the churn lifecycle:
 *
 * ```
 * queued
 *   → (rate ok) FOLLOW ok        → pending_followback  (followedAt set)
 *   → (fail, retries left)         queued               (retryCount++)
 *   → (fail, retries exhausted)    abandoned
 * pending_followback
 *   → (now - followedAt ≥ maxWait) unfollow_queued      (no follow-back timeout — reclaim slot)
 * followed_back
 *   → (now ≥ holdUntil)            unfollow_queued      (hold elapsed; a bio
 *                                  keep-word match on a live mutual holds instead)
 * unfollow_queued
 *   → (rate ok) UNFOLLOW ok        unfollowed
 *   → (fail, retries left)         unfollow_queued      (retryCount++)
 *   → (fail, retries exhausted)    abandoned
 * ```
 *
 * The scheduler is split into three responsibilities so the Engine can pace
 * Instagram actions one at a time with a delay between each:
 *
 * - {@link advanceTimers} — the no-IG state transitions (timeouts + holds).
 * - {@link nextDue} — pick the single most-due record needing IG traffic.
 * - {@link execute} — perform that ONE record's action (no delay inside).
 *
 * Gating (hard ceiling / active hours) is the Engine's job: it decides *when* to
 * call these; the scheduler only decides *what* happens next and applies it. The
 * critical safety invariant (fixing the old silent-drop bug) is preserved: a
 * record is never discarded — if the Engine's gate is closed it simply never
 * calls {@link execute}, leaving the record in place.
 */
export class ChurnScheduler {
  private readonly store: KnowledgeStore;
  private readonly clock: Clock;
  private readonly rate: RateGovernor;
  private readonly actions: ChurnActions;
  private readonly ownPk?: string;
  private cfg: ChurnConfig;
  private readonly pickQueued?: ChurnDeps['pickQueued'];
  private readonly validateFollow?: ChurnDeps['validateFollow'];
  private consecutiveCleanup = 0;
  /**
   * Consecutive `'failed'` action outcomes ACROSS records — the engine's
   * systemic-breakage signal. A single dead/renamed account produces at most
   * `maxRetries + 1` fails before it abandons; a broken input pipeline or a
   * silently-drifted selector fails every record identically, forever. The
   * engine reads this and enters the recovery ladder instead of burning the
   * whole queue (and the daily ledger budget) on clicks that do nothing. Reset
   * by any VERIFIED outcome (ok / already-in-state / simulated); `'blocked'` and
   * the no-username paths are neutral — nothing was clicked.
   */
  private consecutiveFailures = 0;
  /**
   * How many of the current consecutive failures were DRIFT-caused
   * (`AdapterStaleError` — the expected control is gone). The recovery ladder
   * compares this to the failure window: a window that is ALL drift, with clean
   * tab diagnostics, is drift evidence; anything mixed stays presumed
   * rate-limited. Reset together with {@link consecutiveFailures}.
   */
  private consecutiveDriftFailures = 0;
  /**
   * Consecutive `'blocked'` outcomes ACROSS records — the rate-wall streak the
   * recovery ladder enters on (mirrors the prune engine's consecutive-block
   * breaker). Blocks are record-NEUTRAL (nothing was clicked, no retry burned);
   * this window exists so a persistent wall is escalated instead of the same
   * record being re-driven at full pace forever. Reset by any verified
   * ok/simulated outcome.
   */
  private consecutiveBlocked = 0;
  /**
   * The classification of the MOST RECENT blocked outcome (`null` for an
   * ordinary sentinel/budget block, and after any verified outcome). The
   * engine reads it to tell a definitive server refusal (`'rate-limited'`,
   * which ladders up at once) from a streak it still has to prove.
   */
  private lastBlockCause: ChurnActionOutcome['cause'] | null = null;
  private lastOutcome: ChurnActionOutcome | null = null;
  lastActionOutcome(): ChurnActionOutcome | null { return this.lastOutcome ? { ...this.lastOutcome } : null; }
  /** Swap the live config in place (used when Settings are updated at runtime). */
  applyConfig(cfg: ChurnConfig): void {
    this.cfg = cfg;
  }

  /** The three streak windows the recovery ladder reads, in one read. */
  streaks(): { failed: number; drift: number; blocked: number } {
    return {
      failed: this.consecutiveFailures,
      drift: this.consecutiveDriftFailures,
      blocked: this.consecutiveBlocked,
    };
  }

  /** Open a fresh window for every streak (each ladder rung burns one). */
  resetStreaks(): void {
    this.consecutiveFailures = 0;
    this.consecutiveDriftFailures = 0;
    this.consecutiveBlocked = 0;
    this.lastBlockCause = null;
  }

  /** The most recent blocked outcome's classification (see {@link lastBlockCause}). */
  lastBlockedCause(): ChurnActionOutcome['cause'] | null {
    return this.lastBlockCause;
  }

  constructor(deps: ChurnDeps) {
    this.store = deps.store;
    this.clock = deps.clock;
    this.rate = deps.rate;
    this.actions = deps.actions;
    this.ownPk = deps.ownPk;
    this.cfg = deps.cfg ?? CHURN_DEFAULTS;
    this.pickQueued = deps.pickQueued;
    this.validateFollow = deps.validateFollow;
  }

  /**
   * Apply the timer-driven state transitions that need NO Instagram traffic:
   *
   * - `pending_followback` with `now - followedAt ≥ maxWaitForFollowbackMs`
   *   → `unfollow_queued` (`unfollowDueAt = now`): no follow-back in time, reclaim the slot.
   * - `followed_back` with `now ≥ holdUntil`
   *   → `unfollow_queued` (`unfollowDueAt = now`): the hold elapsed.
   *
   * Cheap and side-effect-free beyond the store; makes zero calls to `actions`.
   */
  advanceTimers(now: number = this.clock.now()): void {
    // No follow-back within the max wait → reclaim the slot.
    for (const rec of this.store.followRecordsByState('pending_followback')) {
      if (this.isRetained(rec.accountPk)) continue;
      if (rec.followedAt === undefined) continue;
      if (now - rec.followedAt >= this.cfg.maxWaitForFollowbackMs) {
        const deadline = rec.followedAt + this.cfg.maxWaitForFollowbackMs;
        if (this.ownPk !== undefined) {
          const edge = this.store.getEdge(rec.accountPk, this.ownPk, 'follows');
          if (edge?.status !== 'removed' || edge.lastConfirmedAt < deadline
            || !this.fresh(rec, now)) continue;
        }
        this.store.upsertFollowRecord({ ...rec, state: 'unfollow_queued', unfollowDueAt: deadline, unfollowReason: 'no-followback' });
        log.info('churn: no follow-back within max wait, queuing unfollow', {
          pk: rec.accountPk,
        });
      }
    }
    // Reciprocated and held long enough → time to unfollow — UNLESS the bio
    // keep-list protects this mutual. The gate re-evaluates on every sweep
    // (no state is rewritten), so editing the keep-words — or the follower
    // unfollowing us — takes effect on the next pass.
    for (const rec of this.store.followRecordsByState('followed_back')) {
      if (this.isRetained(rec.accountPk) || !this.fresh(rec, now)) continue;
      if (rec.holdUntil === undefined) continue;
      if (now >= rec.holdUntil) {
        if (this.bioKeepsFollower(rec.accountPk)) continue;
        this.store.upsertFollowRecord({ ...rec, state: 'unfollow_queued', unfollowDueAt: rec.holdUntil, unfollowReason: 'hold-expired' });
        log.info('churn: hold elapsed, queuing unfollow', { pk: rec.accountPk });
      }
    }
  }

  private fresh(rec: FollowRecord, now: number): boolean {
    if (this.ownPk === undefined) return true;
    return rec.reconciledAt !== undefined && rec.reconciledAt <= now
      && now - rec.reconciledAt <= (this.cfg.relationshipFreshMs ?? MS_PER_DAY);
  }

  private isRetained(pk: string): boolean {
    return this.store.getTarget(pk)?.status === 'retained'
      || this.store.getAccount(pk)?.role === 'retained_target';
  }

  /**
   * Whether `pk` is protected from unfollows by the bio keep-list: they follow
   * us back RIGHT NOW (the live graph edge — record state alone can be stale)
   * and their stored bio contains a configured keep-word. A non-follower is
   * NEVER protected — the keep-list means "mutuals I keep", not "skip these".
   * Without `ownPk` (bare test rigs) the caller's record state stands in for
   * the edge. An unobserved bio never matches (facts only, no fabrication).
   */
  private bioKeepsFollower(pk: string): boolean {
    if (this.cfg.bioKeepWords.length === 0) return false;
    if (this.ownPk !== undefined) {
      const followsUs = this.store.getEdge(pk, this.ownPk, 'follows')?.status === 'active';
      if (!followsUs) return false;
    }
    return bioMatchesFilter(this.store.getAccount(pk)?.bio, this.cfg.bioKeepWords);
  }

  /**
   * Return the single most-due record needing Instagram traffic, or `null` if none.
   *
   * Ordering: reclaimed slots first — `unfollow_queued` records are preferred
   * over `queued`, so we free capacity before spending it on new follows. Within
   * `unfollow_queued`, order by `unfollowDueAt` ascending then `accountPk`. Among
   * `queued` records the BEST candidate goes first: descending `score` (the
   * Scorer's composite — ratio, mutuals, private boost), with `accountPk` only as
   * a deterministic tie-break. A record without a score (not Scanner-created)
   * sorts last. This method does NOT check the ceiling/active-hours (the Engine
   * gates before calling) and does NOT act.
   */
  nextDue(now: number = this.clock.now()): FollowRecord | null {
    const queued = this.store.followRecordsByState('queued').filter((r) => r.score !== 0);
    const chosenFollow = this.pickQueued ? this.pickQueued(queued) : queued.sort(compareByScoreDesc)[0] ?? null;
    const unfollows = this.store.followRecordsByState('unfollow_queued')
      .filter((r) => !this.isRetained(r.accountPk) && this.fresh(r, now));
    if (unfollows.length > 0 && (this.consecutiveCleanup < 2 || chosenFollow === null)) {
      return unfollows.sort((a, b) => {
        const da = a.unfollowDueAt ?? 0;
        const db = b.unfollowDueAt ?? 0;
        if (da !== db) return da - db;
        return a.accountPk < b.accountPk ? -1 : a.accountPk > b.accountPk ? 1 : 0;
      })[0];
    }

    return chosenFollow;
  }

  /**
   * Perform exactly ONE record's Instagram action and apply its result. No delay is
   * incurred here — the Engine paces between calls. `queued` records are followed;
   * `unfollow_queued` records are unfollowed. Any other state is a no-op.
   *
   * On success: record the action in the ledger, transition the record, and (when
   * `ownPk` is known) observe the directed edge. On failure: record the failed
   * action and bump `retryCount`, abandoning once `maxRetries` is exceeded.
   *
   * Returns the attempt's outcome status so the Engine can route it: `'blocked'`
   * gets a short park (never a full-pace re-drive of the same record) and feeds
   * the recovery ladder's blocked streak; `'noop'` means nothing touched
   * Instagram (non-actionable record, or a due record with no username whose
   * retry was burned store-side).
   */
  async execute(
    rec: FollowRecord,
    now: number = this.clock.now(),
  ): Promise<ChurnActionOutcome['status'] | 'noop'> {
    this.lastOutcome = null;
    if (rec.state === 'queued') {
      return this.executeFollow(rec, now);
    }
    if (rec.state === 'unfollow_queued') {
      return this.executeUnfollow(rec, now);
    }
    log.warn('churn: execute called on a non-actionable record', {
      pk: rec.accountPk,
      state: rec.state,
    });
    return 'noop';
  }

  /**
   * Thin convenience for callers that want a single lifecycle step without the Engine:
   * advance timers, take at most ONE due record, and execute it. The three methods above
   * are the real API; this never loops over all records.
   */
  async tick(): Promise<void> {
    const now = this.clock.now();
    this.advanceTimers(now);
    const rec = this.nextDue(now);
    if (rec) await this.execute(rec, now);
  }

  /**
   * Per-verb differences the one applier below is parameterized by: the
   * follows-edge polarity a verified action leaves behind, the lifecycle state
   * it lands in, whether the transition stamps `followedAt`, and what an
   * EXTERNAL already-in-state result means for the record.
   */
  private static readonly VERBS = {
    follow: {
      edge: true,
      next: 'pending_followback',
      stampsFollowedAt: true,
      // Nothing was clicked — an external actor already follows this
      // account. `reconcileOwnFollow` drops the record to `external`; writing a
      // lifecycle transition on top would claim a follow that was never ours.
      closeOnExternal: false,
    },
    unfollow: {
      edge: false,
      next: 'unfollowed',
      stampsFollowedAt: false,
      // Already not following: reconcile the edge AND close the record — the
      // lifecycle is genuinely over, whoever ended it.
      closeOnExternal: true,
    },
  } as const satisfies Record<'follow' | 'unfollow', VerbSpec>;

  /**
   * Follow one `queued` record: resolve the username, perform the click, apply
   * the outcome. Every outcome rule lives in {@link applyOutcome}.
   */
  private async executeFollow(
    rec: FollowRecord,
    now: number,
  ): Promise<ChurnActionOutcome['status'] | 'noop'> {
    if (this.validateFollow && !(await this.validateFollow(rec, now))) {
      this.store.upsertFollowRecord({ ...rec, score: 0 });
      return 'noop';
    }
    const username = this.store.getAccount(rec.accountPk)?.username;
    if (username === undefined) {
      // MUST make progress: `nextDue` is a pure ranking with no memory, so a
      // bare return would hand this same record back every step forever. Burn a
      // retry (no ledger row — nothing touched Instagram) until it abandons.
      log.warn('churn: no username for due follow, burning a retry', { pk: rec.accountPk });
      this.retryOrAbandon(rec, 'follow', now);
      return 'noop';
    }
    return this.performAttempt(rec, 'follow', username, now);
  }

  /**
   * Unfollow one `unfollow_queued` record. The keep-list's moment-of-truth
   * check comes first: a record can reach the queue before the person followed
   * back (timeout path) or before the keep-word was configured — a protected
   * mutual is re-held, never unfollowed.
   */
  private async executeUnfollow(
    rec: FollowRecord,
    now: number,
  ): Promise<ChurnActionOutcome['status'] | 'noop'> {
    if (this.isRetained(rec.accountPk) || !this.fresh(rec, now)) return 'noop';
    if (this.bioKeepsFollower(rec.accountPk)) {
      // The hold stamp is kept (or set due-now), so the sweep's own gate
      // re-decides each pass: remove the keep-word later and rotation resumes.
      this.store.upsertFollowRecord({
        ...rec,
        state: 'followed_back',
        holdUntil: rec.holdUntil ?? now,
      });
      log.info('churn: due unfollow is a bio-protected mutual, re-holding', {
        pk: rec.accountPk,
      });
      return 'noop';
    }
    const username = this.store.getAccount(rec.accountPk)?.username;
    if (username === undefined) {
      // Same starvation guard as the follow path: progress or abandon.
      log.warn('churn: no username for due unfollow, burning a retry', { pk: rec.accountPk });
      this.retryOrAbandon(rec, 'unfollow', now);
      return 'noop';
    }
    return this.performAttempt(rec, 'unfollow', username, now);
  }

  private async performAttempt(
    rec: FollowRecord, verb: 'follow' | 'unfollow', username: string, now: number,
  ): Promise<ChurnActionOutcome['status']> {
    const intent = this.store.beginEffectIntent({
      accountPk: rec.accountPk, username, action: verb, channel: 'growth', at: now,
    });
    if (intent.state === 'dispatched' || intent.state === 'uncertain') {
      // Only fresh, read-only recovery may settle an unknown previous mutation.
      this.lastOutcome = { status: 'blocked', cause: 'local-policy', unverifiedClick: true };
      this.lastBlockCause = 'local-policy';
      return 'blocked';
    }
    const outcome = await this.attempt(verb, rec, username, intent);
    return this.applyOutcome(rec, verb, username, outcome, this.clock.now(), intent);
  }

  /** Perform the click. The port resolves rather than rejects; a rejection is
   *  still caught (no silent catches — it is logged and read as a failure). */
  private async attempt(
    verb: 'follow' | 'unfollow',
    rec: FollowRecord,
    username: string,
    intent: EffectIntent,
  ): Promise<ChurnActionOutcome> {
    try {
      return await this.actions[verb](username, rec.accountPk, () => {
        this.store.markEffectDispatched(intent.id, this.clock.now());
      });
    } catch (err) {
      log.error(`churn: ${verb} action threw`, {
        pk: rec.accountPk,
        username,
        error: String(err),
      });
      if (this.store.getEffectIntent(intent.id)?.state === 'dispatched') {
        return { status: 'blocked', cause: 'tab-unhealthy', unverifiedClick: true };
      }
      return { status: 'failed' };
    }
  }

  /**
   * THE outcome rules, once, for both verbs:
   *
   *  - `'blocked'`   — nothing was clicked: the record is left completely
   *                    untouched (no ledger, no retry) and the streak feeds the
   *                    ladder. An unverified dispatched write stays uncertain
   *                    until read-only reconciliation resolves current state.
   *  - `'ok'`        — ledger row + lifecycle transition + directed edge. When
   *                    the click was skipped (`alreadyInState`) the relationship
   *                    is external, without claiming a new action or its timing.
   *  - `'simulated'` — dry-run: the lifecycle advances, no edge, no ledger row.
   *  - `'failed'`    — ledger `fail` + retry/abandon.
   */
  private applyOutcome(
    rec: FollowRecord,
    verb: 'follow' | 'unfollow',
    username: string,
    outcome: ChurnActionOutcome,
    now: number,
    intent: EffectIntent,
  ): ChurnActionOutcome['status'] {
    outcome = normalizeMutationOutcome(outcome, this.store.getEffectIntent(intent.id)?.state === 'dispatched');
    this.lastOutcome = { ...outcome };
    const spec = ChurnScheduler.VERBS[verb];
    const pk = rec.accountPk;

    switch (outcome.status) {
      case 'blocked':
        if (outcome.cause !== 'local-policy') this.consecutiveBlocked += 1;
        this.lastBlockCause = outcome.cause ?? null;
        if (outcome.unverifiedClick === true) {
          this.store.markEffectUncertain(intent.id, now);
          log.warn(`churn: ${verb} click dispatched but unverified (tab stall), will re-observe`, {
            pk,
            username,
          });
        } else {
          const dispatched = this.store.getEffectIntent(intent.id)?.state === 'dispatched';
          if (dispatched) this.store.markEffectUncertain(intent.id, now);
          else this.store.settleEffectIntent(intent.id, { at: now, result: 'cancelled' });
        }
        log.info(`churn: ${verb} blocked, leaving record untouched`, {
          pk,
          username,
          cause: outcome.cause ?? null,
        });
        return 'blocked';

      case 'ok': {
        this.clearStreaksOnVerified();
        if (outcome.alreadyInState === true) {
          this.store.settleEffectIntent(intent.id, {
            at: now, result: 'external',
            record: { ...rec, state: spec.closeOnExternal ? spec.next : 'external' },
            edge: this.ownPk === undefined ? undefined : { srcPk: this.ownPk, dstPk: pk, active: spec.edge },
          });
          if (!spec.closeOnExternal) this.store.setRole(pk, 'skipped');
          log.info(`churn: ${verb} found already in the target state (external), reconciled`, {
            pk,
            username,
          });
          return 'ok';
        }
        this.commit(rec, verb, spec, now, intent);
        log.info(`churn: ${verb} performed`, { pk, username });
        return 'ok';
      }

      case 'simulated':
        this.clearStreaksOnVerified();
        this.store.settleEffectIntent(intent.id, {
          at: now, result: 'simulated', record: this.transition(rec, spec, now),
        });
        log.info(`churn: dry-run ${verb} simulated, state advanced (no edge/ledger)`, {
          pk,
          username,
        });
        return 'simulated';

      case 'failed':
        this.consecutiveFailures += 1;
        this.lastBlockCause = null;
        if (outcome.cause === 'drift') this.consecutiveDriftFailures += 1;
        this.store.settleEffectIntent(intent.id, {
          at: now, result: 'fail', ledger: 'growth', record: this.retryRecord(rec, now),
        });
        return 'failed';
    }
  }

  /** A verified action: ledger row, lifecycle transition, directed edge. */
  private commit(
    rec: FollowRecord,
    verb: 'follow' | 'unfollow',
    spec: VerbSpec,
    now: number,
    intent: EffectIntent,
  ): void {
    this.store.settleEffectIntent(intent.id, {
      at: now, result: 'ok', ledger: 'growth', record: this.transition(rec, spec, now),
      edge: this.ownPk === undefined ? undefined : { srcPk: this.ownPk, dstPk: rec.accountPk, active: spec.edge },
    });
    this.consecutiveCleanup = verb === 'unfollow' ? this.consecutiveCleanup + 1 : 0;
  }

  /** The record as the verb's verified/simulated transition leaves it. */
  private transition(rec: FollowRecord, spec: VerbSpec, now: number): FollowRecord {
    return spec.stampsFollowedAt
      ? { ...rec, state: spec.next, followedAt: now }
      : { ...rec, state: spec.next };
  }

  /** Any VERIFIED outcome (ok / already-in-state / simulated) opens fresh windows. */
  private clearStreaksOnVerified(): void {
    this.consecutiveFailures = 0;
    this.consecutiveDriftFailures = 0;
    this.consecutiveBlocked = 0;
    this.lastBlockCause = null;
  }

  /**
   * Bump `retryCount`; once it exceeds `maxRetries` the record is abandoned —
   * stamped with `abandonedAt = now` so the recovery requeue-healer can later
   * place the abandonment inside a closed systemic-incident window — otherwise
   * it stays in its current queued/due state for the next tick.
   */
  private retryOrAbandon(rec: FollowRecord, action: 'follow' | 'unfollow', now: number): void {
    const retryCount = rec.retryCount + 1;
    if (retryCount > this.cfg.maxRetries) {
      this.store.upsertFollowRecord({ ...rec, state: 'abandoned', retryCount, abandonedAt: now });
      log.warn('churn: retries exhausted, abandoning record', {
        pk: rec.accountPk,
        action,
        retryCount,
      });
    } else {
      this.store.upsertFollowRecord({ ...rec, retryCount });
      log.warn('churn: action failed, will retry next tick', {
        pk: rec.accountPk,
        action,
        retryCount,
      });
    }
  }

  private retryRecord(rec: FollowRecord, now: number): FollowRecord {
    const retryCount = rec.retryCount + 1;
    return retryCount > this.cfg.maxRetries
      ? { ...rec, state: 'abandoned', retryCount, abandonedAt: now }
      : { ...rec, retryCount };
  }
}

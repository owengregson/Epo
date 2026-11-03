import type { Clock } from '../governors/clock';
import type { RateGovernor } from '../governors/rate-governor';
import type { ProtectionIndex } from '../shared/unfollow-protection';
import type { KnowledgeStore } from '../store/knowledge-store';
import type { EffectIntent, FollowRecord } from '../store/types';
import * as log from '../utils/logger';
import { ChurnPick } from './churn-pick';
import type { ChurnActionOutcome, ChurnActions, ChurnConfig, ChurnDeps, VerbSpec } from './churn-types';
import { normalizeMutationOutcome } from './mutation-outcome';
import { keepingVerdictOf, keepRecord, keptStampFor, selectionVerdict } from './protection-gate';
import { type ProtectionPort, unconfiguredProtection } from './protection-port';

export type { ChurnActionOutcome, ChurnActions, ChurnConfig, ChurnDeps } from './churn-types';

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
 *   → (now ≥ holdUntil)            unfollow_queued      (hold elapsed; never with mutuals kept)
 * pending_followback | followed_back | unfollow_queued
 *   → (protected at selection)     kept                 (spec §7.4; non-blocking, re-judged)
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
  /** The due ranking and the unfollow gates (see `churn-pick.ts`). */
  private readonly pick: ChurnPick;
  private readonly protection: ProtectionPort;
  private readonly reconciler?: ChurnDeps['reconciler'];
  private readonly validateFollow?: ChurnDeps['validateFollow'];
  private consecutiveCleanup = 0;
  /**
   * Consecutive `'failed'` outcomes ACROSS records: the systemic-breakage signal (one dead account fails
   * at most `maxRetries + 1` times; a broken pipeline fails every record) that enters the recovery
   * ladder. Reset by any VERIFIED outcome; blocked, reviewed and no-username paths are neutral.
   */
  private consecutiveFailures = 0;
  /** How many of those failures were DRIFT-caused: an all-drift window with clean tab diagnostics is drift evidence. */
  private consecutiveDriftFailures = 0;
  /** Consecutive record-neutral `'blocked'` outcomes: the rate-wall streak the ladder enters on. */
  private consecutiveBlocked = 0;
  /** The MOST RECENT block's cause (null for an ordinary block or after a verified outcome): a server refusal ladders up at once. */
  private lastBlockCause: ChurnActionOutcome['cause'] | null = null;
  private lastOutcome: ChurnActionOutcome | null = null;
  lastActionOutcome(): ChurnActionOutcome | null { return this.lastOutcome ? { ...this.lastOutcome } : null; }
  /** Swap the live config in place (a settings reload), and re-judge the kept records against the live rules. */
  applyConfig(cfg: ChurnConfig): void {
    this.cfg = cfg;
    this.reconciler?.sync(this.clock.now());
  }

  /** The live protection state: anything but 'ready' pauses every automatic unfollow (spec §7.6). */
  protectionState(): ProtectionIndex['state'] { return this.protection.index().state; }

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
    this.cfg = deps.cfg;
    this.protection = deps.protection ?? unconfiguredProtection(deps.clock);
    this.reconciler = deps.reconciler;
    this.pick = new ChurnPick({
      store: deps.store,
      ownPk: deps.ownPk,
      cfg: () => this.cfg,
      consecutiveCleanup: () => this.consecutiveCleanup,
      pickQueued: deps.pickQueued,
      hasActiveRequest: deps.hasActiveRequest ?? (() => false),
      unfollowsPaused: () => this.protection.index().state !== 'ready',
    });
    this.validateFollow = deps.validateFollow;
  }

  /**
   * The store-only transitions, with zero calls to `actions` — protection first (spec §7.4):
   * P1 a `pending_followback` past the wait reclaims its slot; P2 a `followed_back` past its hold
   * rotates out (never with mutuals kept); P3/P4 a queued unfollow a rule now protects is kept.
   */
  advanceTimers(now: number = this.clock.now()): void {
    this.reconciler?.sync(now);
    const idx = this.protection.index();
    for (const rec of this.store.followRecordsByState('pending_followback')) {
      if (this.pick.isRetained(rec.accountPk) || rec.followedAt === undefined) continue;
      if (now - rec.followedAt < this.cfg.maxWaitForFollowbackMs || this.stopsAtSelection(rec, idx, now)) continue;
      const deadline = rec.followedAt + this.cfg.maxWaitForFollowbackMs;
      if (this.ownPk !== undefined) {
        const edge = this.store.getEdge(rec.accountPk, this.ownPk, 'follows');
        if (edge?.status !== 'removed' || edge.lastConfirmedAt < deadline || !this.pick.fresh(rec, now)) continue;
      }
      this.store.upsertFollowRecord({ ...rec, state: 'unfollow_queued', unfollowDueAt: deadline, unfollowReason: 'no-followback' });
      log.info('churn: no follow-back within max wait, queuing unfollow', { pk: rec.accountPk });
    }
    for (const rec of this.cfg.rotateMutuals ? this.store.followRecordsByState('followed_back') : []) {
      if (this.pick.isRetained(rec.accountPk) || rec.holdUntil === undefined || now < rec.holdUntil) continue;
      if (this.stopsAtSelection(rec, idx, now) || !this.pick.fresh(rec, now)) continue;
      this.store.upsertFollowRecord({ ...rec, state: 'unfollow_queued', unfollowDueAt: rec.holdUntil, unfollowReason: 'hold-expired' });
      log.info('churn: hold elapsed, queuing unfollow', { pk: rec.accountPk });
    }
    for (const rec of this.store.followRecordsByState('unfollow_queued')) this.stopsAtSelection(rec, idx, now);
  }

  /** Selection over stored facts: protected → kept, paused → held where it is. True when the unfollow stops here. */
  private stopsAtSelection(rec: FollowRecord, idx: ProtectionIndex, now: number): boolean {
    const v = selectionVerdict(this.store, rec.accountPk, idx);
    if (v.kind === 'protected') {
      keepRecord(this.store, rec, keptStampFor(v, now, rec.checkFailures ?? 0, this.protection));
      log.info('churn: protected at selection, kept', { pk: rec.accountPk, by: v.by });
    }
    return v.kind === 'protected' || v.kind === 'paused';
  }

  /**
   * Return the single most-due record needing Instagram traffic, or `null` if none
   * (the ranking lives in {@link ChurnPick.nextDue}; `kind` narrows it to one verb).
   */
  nextDue(now: number = this.clock.now(), kind?: 'follow' | 'unfollow'): FollowRecord | null {
    return this.pick.nextDue(now, kind);
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

  /** One lifecycle step without the Engine: advance timers, then execute at most ONE due record. */
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
   * Unfollow one `unfollow_queued` record. Selection is judged once more right before the click
   * (a rule may have arrived since it was queued): protected → kept, paused → untouched; the
   * click itself judges the fresh profile.
   */
  private async executeUnfollow(
    rec: FollowRecord,
    now: number,
  ): Promise<ChurnActionOutcome['status'] | 'noop'> {
    if (this.pick.isRetained(rec.accountPk) || !this.pick.fresh(rec, now)) return 'noop';
    if (this.stopsAtSelection(rec, this.protection.index(), now)) return 'noop';
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
   *  - `'reviewed'`  — the click review consumed the work; the intent is cancelled (never dispatched).
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

      case 'reviewed': {
        this.store.settleEffectIntent(intent.id, { at: now, result: 'cancelled' });
        // Protected or unreadable at the click → kept (spec §7.4); paused leaves it where it is.
        const keeping = keepingVerdictOf(outcome.verdict);
        if (keeping !== null) keepRecord(this.store, rec, keptStampFor(keeping, now, rec.checkFailures ?? 0, this.protection));
        log.info(`churn: ${verb} reviewed at the click`, { pk, verdict: outcome.verdict?.kind ?? null });
        return 'reviewed';
      }
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

import { KnowledgeStore } from '../store/knowledge-store';
import { Clock } from '../governors/clock';
import { RateGovernor } from '../governors/rate-governor';
import { FollowRecord } from '../store/types';
import * as log from '../utils/logger';

/**
 * The only Instagram-touching surface the scheduler needs. The real implementation
 * wraps Actor + Sentinel + request budget; tests pass a fake that records calls and
 * returns configurable ok/fail. Both methods resolve (never reject) with `{ ok }` so
 * a failed action is a value, not a thrown exception — but the scheduler still guards
 * against rejections defensively (no silent catches; failures are logged).
 */
export interface ChurnActions {
  follow(username: string): Promise<{ ok: boolean }>;
  unfollow(username: string): Promise<{ ok: boolean }>;
}

/** Lifecycle timers + retry cap for the churn state machine (§3.4). All tunable in Settings. */
export interface ChurnConfig {
  /** How long to wait for a follow-back before reclaiming the slot (default 4 days). */
  maxWaitForFollowbackMs: number;
  /** How long to keep a reciprocated follow before unfollowing (default 2 days). */
  holdAfterFollowbackMs: number;
  /** Failed follow/unfollow attempts tolerated before a record is abandoned (default 3). */
  maxRetries: number;
}

/** Design defaults (v3 §3.4). */
export const CHURN_DEFAULTS: ChurnConfig = {
  maxWaitForFollowbackMs: 4 * 24 * 3600 * 1000,
  holdAfterFollowbackMs: 2 * 24 * 3600 * 1000,
  maxRetries: 3,
};

/** Injected collaborators — no browser, no globals, so the scheduler is unit-testable. */
export interface ChurnDeps {
  store: KnowledgeStore;
  clock: Clock;
  rate: RateGovernor;
  actions: ChurnActions;
  /** Our own account `pk`; when set, follow/unfollow are recorded as directed edges. */
  ownPk?: string;
  cfg?: ChurnConfig;
}

/**
 * Drives every `FollowRecord` through the §3.4 lifecycle:
 *
 * ```
 * queued
 *   → (rate ok) FOLLOW ok        → pending_followback  (followedAt set)
 *   → (fail, retries left)         queued               (retryCount++)
 *   → (fail, retries exhausted)    abandoned
 * pending_followback
 *   → (now - followedAt ≥ maxWait) unfollow_queued      (no follow-back timeout — reclaim slot)
 * followed_back
 *   → (now ≥ holdUntil)            unfollow_queued      (hold elapsed)
 * unfollow_queued
 *   → (rate ok) UNFOLLOW ok        unfollowed
 *   → (fail, retries left)         unfollow_queued      (retryCount++)
 *   → (fail, retries exhausted)    abandoned
 * ```
 *
 * `tick()` performs exactly one pass and is deterministic given the injected clock.
 * The critical safety invariant (fixing the old silent-drop bug): when the rate
 * governor is closed, due records are LEFT IN PLACE, never discarded.
 */
export class ChurnScheduler {
  private readonly store: KnowledgeStore;
  private readonly clock: Clock;
  private readonly rate: RateGovernor;
  private readonly actions: ChurnActions;
  private readonly ownPk?: string;
  private readonly cfg: ChurnConfig;

  constructor(deps: ChurnDeps) {
    this.store = deps.store;
    this.clock = deps.clock;
    this.rate = deps.rate;
    this.actions = deps.actions;
    this.ownPk = deps.ownPk;
    this.cfg = deps.cfg ?? CHURN_DEFAULTS;
  }

  /** One lifecycle pass: timer transitions first, then rate-gated Instagram actions. */
  async tick(): Promise<void> {
    const now = this.clock.now();

    // 1. Timer transitions — pure state moves, no Instagram traffic. Always run.
    this.applyTimerTransitions(now);

    // 2. Rate gate. If we may not act, leave every queued/due record untouched.
    if (this.rate.atHardCeiling()) {
      log.debug('churn: hard ceiling reached, deferring actions this tick');
      return;
    }
    if (!this.rate.withinActiveHours()) {
      log.debug('churn: outside active hours, deferring actions this tick');
      return;
    }

    // Reclaimed slots (unfollows) are processed before new follows (§3.4 ordering).
    await this.processUnfollows(now);
    if (this.rate.atHardCeiling()) {
      log.debug('churn: hard ceiling reached after unfollows, skipping follows this tick');
      return;
    }
    await this.processFollows(now);
  }

  /**
   * Move records whose timers have elapsed into `unfollow_queued`. No Instagram
   * actions occur here, so this runs regardless of the rate gate.
   */
  private applyTimerTransitions(now: number): void {
    // No follow-back within the max wait → reclaim the slot.
    for (const rec of this.store.followRecordsByState('pending_followback')) {
      if (rec.followedAt === undefined) continue;
      if (now - rec.followedAt >= this.cfg.maxWaitForFollowbackMs) {
        this.store.upsertFollowRecord({ ...rec, state: 'unfollow_queued', unfollowDueAt: now });
        log.info('churn: no follow-back within max wait, queuing unfollow', {
          pk: rec.accountPk,
        });
      }
    }
    // Reciprocated and held long enough → time to unfollow.
    for (const rec of this.store.followRecordsByState('followed_back')) {
      if (rec.holdUntil === undefined) continue;
      if (now >= rec.holdUntil) {
        this.store.upsertFollowRecord({ ...rec, state: 'unfollow_queued', unfollowDueAt: now });
        log.info('churn: hold elapsed, queuing unfollow', { pk: rec.accountPk });
      }
    }
  }

  /** Execute queued follows, re-checking the hard ceiling between each action. */
  private async processFollows(now: number): Promise<void> {
    for (const rec of this.store.followRecordsByState('queued')) {
      if (this.rate.atHardCeiling()) {
        log.debug('churn: hard ceiling reached mid-tick, stopping follows', {
          remainingPk: rec.accountPk,
        });
        return;
      }
      const username = this.store.getAccount(rec.accountPk)?.username;
      if (username === undefined) {
        log.warn('churn: skipping follow, unknown username for account', { pk: rec.accountPk });
        continue;
      }

      let ok = false;
      try {
        ({ ok } = await this.actions.follow(username));
      } catch (err) {
        log.error('churn: follow action threw', {
          pk: rec.accountPk,
          username,
          error: String(err),
        });
        ok = false;
      }

      if (ok) {
        this.store.recordAction(rec.accountPk, 'follow', 'ok', now);
        this.store.upsertFollowRecord({ ...rec, state: 'pending_followback', followedAt: now });
        if (this.ownPk !== undefined) {
          this.store.observeEdge(this.ownPk, rec.accountPk, 'follows', true, now);
        }
        log.info('churn: followed', { pk: rec.accountPk, username });
      } else {
        this.store.recordAction(rec.accountPk, 'follow', 'fail', now);
        this.retryOrAbandon(rec, 'follow');
      }
    }
  }

  /** Execute queued unfollows, re-checking the hard ceiling between each action. */
  private async processUnfollows(now: number): Promise<void> {
    for (const rec of this.store.followRecordsByState('unfollow_queued')) {
      if (this.rate.atHardCeiling()) {
        log.debug('churn: hard ceiling reached mid-tick, stopping unfollows', {
          remainingPk: rec.accountPk,
        });
        return;
      }
      const username = this.store.getAccount(rec.accountPk)?.username;
      if (username === undefined) {
        log.warn('churn: skipping unfollow, unknown username for account', { pk: rec.accountPk });
        continue;
      }

      let ok = false;
      try {
        ({ ok } = await this.actions.unfollow(username));
      } catch (err) {
        log.error('churn: unfollow action threw', {
          pk: rec.accountPk,
          username,
          error: String(err),
        });
        ok = false;
      }

      if (ok) {
        this.store.recordAction(rec.accountPk, 'unfollow', 'ok', now);
        this.store.upsertFollowRecord({ ...rec, state: 'unfollowed' });
        if (this.ownPk !== undefined) {
          this.store.observeEdge(this.ownPk, rec.accountPk, 'follows', false, now);
        }
        log.info('churn: unfollowed', { pk: rec.accountPk, username });
      } else {
        this.store.recordAction(rec.accountPk, 'unfollow', 'fail', now);
        this.retryOrAbandon(rec, 'unfollow');
      }
    }
  }

  /**
   * Bump `retryCount`; once it exceeds `maxRetries` the record is abandoned,
   * otherwise it stays in its current queued/due state for the next tick.
   */
  private retryOrAbandon(rec: FollowRecord, action: 'follow' | 'unfollow'): void {
    const retryCount = rec.retryCount + 1;
    if (retryCount > this.cfg.maxRetries) {
      this.store.upsertFollowRecord({ ...rec, state: 'abandoned', retryCount });
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
}

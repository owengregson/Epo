import { KnowledgeStore } from '../store/knowledge-store';
import { Clock } from '../governors/clock';
import { RateGovernor } from '../governors/rate-governor';
import { FollowRecord } from '../store/types';
import * as log from '../utils/logger';

/**
 * The discriminated outcome of a single follow/unfollow attempt (R4):
 *
 * - `'ok'`        — the click was performed and the Actor verified the transition.
 * - `'failed'`    — a click was attempted but did not confirm (retry/abandon).
 * - `'blocked'`   — budget exhausted or Sentinel non-`ok` BEFORE any click; the
 *                   record is left completely untouched so it retries when the
 *                   window clears. A block is NOT a failure.
 * - `'simulated'` — dry-run: no click happened. The lifecycle STATE still advances
 *                   (so dry-run exercises the machine) but no real edge/ledger row
 *                   is written (f12), so dry-run never pollutes yield/overlap.
 */
export type ChurnActionOutcome = {
  status: 'ok' | 'failed' | 'blocked' | 'simulated';
  /** True when `ok` but no click happened — the button was already in the target
   *  state, so an external actor is responsible for the relationship (Phase A). */
  alreadyInState?: boolean;
};

/**
 * The only Instagram-touching surface the scheduler needs. The real implementation
 * wraps Actor + Sentinel + request budget; tests pass a fake that records calls and
 * returns a configurable outcome. Both methods resolve (never reject) with a
 * {@link ChurnActionOutcome} so an outcome is a value, not a thrown exception — but
 * the scheduler still guards against rejections defensively (no silent catches;
 * failures are logged).
 */
export interface ChurnActions {
  follow(username: string): Promise<ChurnActionOutcome>;
  unfollow(username: string): Promise<ChurnActionOutcome>;
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
 * The scheduler is split into three responsibilities so the Engine runtime (§3.1)
 * can pace Instagram actions one-at-a-time with a human delay between each:
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

  /** Swap the live config in place (used when Settings are updated at runtime). */
  applyConfig(cfg: ChurnConfig): void {
    this.cfg = cfg;
  }

  constructor(deps: ChurnDeps) {
    this.store = deps.store;
    this.clock = deps.clock;
    this.rate = deps.rate;
    this.actions = deps.actions;
    this.ownPk = deps.ownPk;
    this.cfg = deps.cfg ?? CHURN_DEFAULTS;
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

  /**
   * Return the single most-due record needing Instagram traffic, or `null` if none.
   *
   * Ordering (§3.2): reclaimed slots first — `unfollow_queued` records are preferred
   * over `queued`, so we free capacity before spending it on new follows. Within
   * `unfollow_queued`, order by `unfollowDueAt` ascending then `accountPk`; `queued`
   * records order by `accountPk`. This method does NOT check the ceiling/active-hours
   * (the Engine gates before calling) and does NOT act.
   */
  nextDue(now: number = this.clock.now()): FollowRecord | null {
    void now; // parity with the other methods; no time-based filtering here.

    const unfollows = this.store.followRecordsByState('unfollow_queued');
    if (unfollows.length > 0) {
      return unfollows.sort((a, b) => {
        const da = a.unfollowDueAt ?? 0;
        const db = b.unfollowDueAt ?? 0;
        if (da !== db) return da - db;
        return a.accountPk < b.accountPk ? -1 : a.accountPk > b.accountPk ? 1 : 0;
      })[0];
    }

    const queued = this.store.followRecordsByState('queued');
    if (queued.length > 0) {
      return queued.sort((a, b) =>
        a.accountPk < b.accountPk ? -1 : a.accountPk > b.accountPk ? 1 : 0,
      )[0];
    }

    return null;
  }

  /**
   * Perform exactly ONE record's Instagram action and apply its result. No delay is
   * incurred here — the Engine paces between calls. `queued` records are followed;
   * `unfollow_queued` records are unfollowed. Any other state is a no-op.
   *
   * On success: record the action in the ledger, transition the record, and (when
   * `ownPk` is known) observe the directed edge. On failure: record the failed
   * action and bump `retryCount`, abandoning once `maxRetries` is exceeded.
   */
  async execute(rec: FollowRecord, now: number = this.clock.now()): Promise<void> {
    if (rec.state === 'queued') {
      await this.executeFollow(rec, now);
    } else if (rec.state === 'unfollow_queued') {
      await this.executeUnfollow(rec, now);
    } else {
      log.warn('churn: execute called on a non-actionable record', {
        pk: rec.accountPk,
        state: rec.state,
      });
    }
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
   * Follow one `queued` record. Outcome handling (R4/f12/Phase A):
   *  - `'blocked'`   → leave the record completely untouched (no ledger, no retry).
   *  - `'ok'` + `alreadyInState` → an external actor already follows this account:
   *                    reconcile (record drops to `external`); no ledger, no edge here.
   *  - `'ok'`        → ledger `ok` + `pending_followback` + active `ownPk→pk` edge.
   *  - `'simulated'` → advance to `pending_followback` only; no edge, no ledger row.
   *  - `'failed'`    → ledger `fail` + retry/abandon.
   */
  private async executeFollow(rec: FollowRecord, now: number): Promise<void> {
    const username = this.store.getAccount(rec.accountPk)?.username;
    if (username === undefined) {
      log.warn('churn: skipping follow, unknown username for account', { pk: rec.accountPk });
      return;
    }

    let outcome: ChurnActionOutcome = { status: 'failed' };
    try {
      outcome = await this.actions.follow(username);
    } catch (err) {
      log.error('churn: follow action threw', {
        pk: rec.accountPk,
        username,
        error: String(err),
      });
      outcome = { status: 'failed' };
    }

    switch (outcome.status) {
      case 'blocked':
        // Budget/sentinel closed BEFORE any click — retry when the window clears.
        log.info('churn: follow blocked, leaving record untouched', {
          pk: rec.accountPk,
          username,
        });
        return;
      case 'ok':
        if (outcome.alreadyInState === true) {
          // Phase A: nothing was clicked — an external actor already follows this
          // account. Reconcile (drops the record to `external` + writes the edge);
          // NO ledger row and NO pending_followback — the follow was never ours.
          this.store.reconcileOwnFollow(rec.accountPk, true, now);
          log.info('churn: follow found already-following (external), backing off', {
            pk: rec.accountPk,
            username,
          });
          return;
        }
        this.store.recordAction(rec.accountPk, 'follow', 'ok', now);
        this.store.upsertFollowRecord({ ...rec, state: 'pending_followback', followedAt: now });
        if (this.ownPk !== undefined) {
          this.store.observeEdge(this.ownPk, rec.accountPk, 'follows', true, now);
        }
        log.info('churn: followed', { pk: rec.accountPk, username });
        return;
      case 'simulated':
        // f12: advance the lifecycle under dry-run WITHOUT a real edge or ledger row.
        this.store.upsertFollowRecord({ ...rec, state: 'pending_followback', followedAt: now });
        log.info('churn: dry-run follow simulated, state advanced (no edge/ledger)', {
          pk: rec.accountPk,
          username,
        });
        return;
      case 'failed':
        this.store.recordAction(rec.accountPk, 'follow', 'fail', now);
        this.retryOrAbandon(rec, 'follow');
        return;
    }
  }

  /**
   * Unfollow one `unfollow_queued` record. Outcome handling mirrors
   * {@link executeFollow}: `'blocked'` leaves the record untouched; `'ok'` +
   * `alreadyInState` reconciles (an external actor already unfollowed) and closes
   * the record as `unfollowed` with NO ledger row; `'ok'` writes the ledger +
   * `unfollowed` + removes the edge; `'simulated'` advances to `unfollowed` only
   * (no edge/ledger); `'failed'` retries/abandons.
   */
  private async executeUnfollow(rec: FollowRecord, now: number): Promise<void> {
    const username = this.store.getAccount(rec.accountPk)?.username;
    if (username === undefined) {
      log.warn('churn: skipping unfollow, unknown username for account', { pk: rec.accountPk });
      return;
    }

    let outcome: ChurnActionOutcome = { status: 'failed' };
    try {
      outcome = await this.actions.unfollow(username);
    } catch (err) {
      log.error('churn: unfollow action threw', {
        pk: rec.accountPk,
        username,
        error: String(err),
      });
      outcome = { status: 'failed' };
    }

    switch (outcome.status) {
      case 'blocked':
        log.info('churn: unfollow blocked, leaving record untouched', {
          pk: rec.accountPk,
          username,
        });
        return;
      case 'ok':
        if (outcome.alreadyInState === true) {
          // Phase A: nothing was clicked — already not following (an external
          // actor unfollowed for us). Reconcile the edge, close the record, and
          // write NO ledger row — the unfollow was not our action.
          this.store.reconcileOwnFollow(rec.accountPk, false, now);
          this.store.upsertFollowRecord({ ...rec, state: 'unfollowed' });
          log.info('churn: unfollow found already-not-following (external), reconciled', {
            pk: rec.accountPk,
            username,
          });
          return;
        }
        this.store.recordAction(rec.accountPk, 'unfollow', 'ok', now);
        this.store.upsertFollowRecord({ ...rec, state: 'unfollowed' });
        if (this.ownPk !== undefined) {
          this.store.observeEdge(this.ownPk, rec.accountPk, 'follows', false, now);
        }
        log.info('churn: unfollowed', { pk: rec.accountPk, username });
        return;
      case 'simulated':
        // f12: advance the lifecycle under dry-run WITHOUT removing a real edge.
        this.store.upsertFollowRecord({ ...rec, state: 'unfollowed' });
        log.info('churn: dry-run unfollow simulated, state advanced (no edge/ledger)', {
          pk: rec.accountPk,
          username,
        });
        return;
      case 'failed':
        this.store.recordAction(rec.accountPk, 'unfollow', 'fail', now);
        this.retryOrAbandon(rec, 'unfollow');
        return;
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

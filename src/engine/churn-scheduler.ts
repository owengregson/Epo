import type { Clock } from '../governors/clock';
import type { RateGovernor } from '../governors/rate-governor';
import type { KnowledgeStore } from '../store/knowledge-store';
import { compareByScoreDesc, type FollowRecord } from '../store/types';
import { MS_PER_DAY } from '../timing/units';
import * as log from '../utils/logger';

/**
 * The discriminated outcome of a single follow/unfollow attempt (R4):
 *
 * - `'ok'`        — the click was performed and the Actor verified the transition.
 * - `'failed'`    — a click was attempted but did not confirm (retry/abandon).
 * - `'blocked'`   — Sentinel non-`ok` BEFORE any click; the
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
  /**
   * Why a non-ok outcome happened, when the cause is classifiable:
   *  - `'tab-unhealthy'` — the TAB stalled or its webContents was unavailable
   *    (status `'blocked'`: record-neutral — never a retry, never a fail row;
   *    the recovery ladder routes it to tab recovery, not the wait ladder).
   *  - `'drift'` — an `AdapterStaleError`: the expected control is gone
   *    (status `'failed'`; feeds the ladder's drift-evidence tally).
   * Absent when the cause is unknown or ordinary.
   */
  cause?: 'tab-unhealthy' | 'drift';
  /**
   * True when a tab failure landed AFTER the click was dispatched but BEFORE
   * post-state verification — the action may have LANDED on Instagram. The
   * scheduler marks the record so the next attempt's already-in-state pre-check
   * resolves ownership (a landed click is recorded as OURS, never re-clicked).
   */
  unverifiedClick?: boolean;
};

/**
 * The only Instagram-touching surface the scheduler needs. The real implementation
 * wraps Actor + Sentinel; tests pass a fake that records calls and
 * returns a configurable outcome. Both methods resolve (never reject) with a
 * {@link ChurnActionOutcome} so an outcome is a value, not a thrown exception — but
 * the scheduler still guards against rejections defensively (no silent catches;
 * failures are logged).
 */
export interface ChurnActions {
  follow(username: string): Promise<ChurnActionOutcome>;
  unfollow(username: string): Promise<ChurnActionOutcome>;
}

/**
 * Lifecycle timers + retry cap for the churn state machine (§3.4). All tunable in
 * Settings. NB: the post-follow-back HOLD is not here — `holdUntil` is stamped by the
 * FollowbackWatcher (its `holdAfterFollowbackMs`); the scheduler only honors the stamp.
 */
export interface ChurnConfig {
  /** How long to wait for a follow-back before reclaiming the slot (default 4 days). */
  maxWaitForFollowbackMs: number;
  /** Failed follow/unfollow attempts tolerated before a record is abandoned (default 3). */
  maxRetries: number;
}

/** Design defaults (v3 §3.4). */
export const CHURN_DEFAULTS: ChurnConfig = {
  maxWaitForFollowbackMs: 4 * MS_PER_DAY,
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
 * can pace Instagram actions one-at-a-time with a paced delay between each:
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
  /**
   * Consecutive `'failed'` action outcomes ACROSS records — the engine's
   * systemic-breakage signal. A single dead/renamed account produces at most
   * `maxRetries + 1` fails before it abandons; a broken input pipeline or a
   * silently-drifted selector fails every record identically, forever. The
   * engine reads this and halts loudly instead of burning the whole queue
   * (and the daily ledger budget) on clicks that do nothing — the 2026-08-13
   * overnight run abandoned ~20 candidates that way. Reset by any VERIFIED
   * outcome (ok / already-in-state / simulated); `'blocked'` and the
   * no-username paths are neutral — nothing was clicked.
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
   * Amendment C — records whose last attempt ended in a POST-CLICK tab failure:
   * the click was dispatched but never verified, so the action may have LANDED.
   * On the next attempt, an already-in-state result for a marked record is OUR
   * landed click (recorded as ours: ledger + transition), not an external
   * actor's. In-memory by design (the cheapest correct form): across a relaunch
   * the marker is lost and the next attempt degrades to the existing safe
   * leave-alone reconcile — never a re-click, never a phantom ledger row.
   */
  private readonly unverifiedClicks = new Map<string, 'follow' | 'unfollow'>();

  /** Swap the live config in place (used when Settings are updated at runtime). */
  applyConfig(cfg: ChurnConfig): void {
    this.cfg = cfg;
  }

  /** How many actions in a row have failed (see {@link consecutiveFailures}). */
  consecutiveFailureCount(): number {
    return this.consecutiveFailures;
  }

  /** How many of the current failure window's fails were drift-caused. */
  consecutiveDriftFailureCount(): number {
    return this.consecutiveDriftFailures;
  }

  /** Give a restarted engine a fresh failure window (called when it halts). */
  resetConsecutiveFailures(): void {
    this.consecutiveFailures = 0;
    this.consecutiveDriftFailures = 0;
  }

  /** How many actions in a row came back blocked (see {@link consecutiveBlocked}). */
  consecutiveBlockedCount(): number {
    return this.consecutiveBlocked;
  }

  /** Clear the blocked window (the engine calls this when the ladder enters). */
  resetConsecutiveBlocked(): void {
    this.consecutiveBlocked = 0;
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
   * `unfollow_queued`, order by `unfollowDueAt` ascending then `accountPk`. Among
   * `queued` records the BEST candidate goes first: descending `score` (the
   * Scorer's composite — ratio, mutuals, private boost), with `accountPk` only as
   * a deterministic tie-break. A record without a score (not Scanner-created)
   * sorts last. This method does NOT check the ceiling/active-hours (the Engine
   * gates before calling) and does NOT act.
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
      return queued.sort(compareByScoreDesc)[0];
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
   * Follow one `queued` record. Outcome handling (R4/f12/Phase A):
   *  - `'blocked'`   → leave the record completely untouched (no ledger, no retry).
   *  - `'ok'` + `alreadyInState` → an external actor already follows this account:
   *                    reconcile (record drops to `external`); no ledger, no edge here.
   *  - `'ok'`        → ledger `ok` + `pending_followback` + active `ownPk→pk` edge.
   *  - `'simulated'` → advance to `pending_followback` only; no edge, no ledger row.
   *  - `'failed'`    → ledger `fail` + retry/abandon.
   */
  private async executeFollow(
    rec: FollowRecord,
    now: number,
  ): Promise<ChurnActionOutcome['status'] | 'noop'> {
    const username = this.store.getAccount(rec.accountPk)?.username;
    if (username === undefined) {
      // MUST make progress: `nextDue` is a pure ranking with no memory, so a
      // bare return would hand this same record back every step forever — the
      // engine "acts" on it eternally and every other record starves. Burn a
      // retry (no ledger row — nothing touched Instagram) until it abandons.
      log.warn('churn: no username for due follow, burning a retry', { pk: rec.accountPk });
      this.retryOrAbandon(rec, 'follow', now);
      return 'noop';
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
        // Budget/sentinel/tab closed BEFORE any confirmed click — retry when
        // the window clears. Record-neutral, but the streak feeds the ladder.
        this.consecutiveBlocked += 1;
        if (outcome.unverifiedClick === true) {
          // Amendment C: the click was dispatched, then the tab stalled — the
          // follow may have landed. The NEXT attempt's pre-check arbitrates.
          this.unverifiedClicks.set(rec.accountPk, 'follow');
          log.warn('churn: follow click dispatched but unverified (tab stall), will re-observe', {
            pk: rec.accountPk,
            username,
          });
        }
        log.info('churn: follow blocked, leaving record untouched', {
          pk: rec.accountPk,
          username,
          cause: outcome.cause ?? null,
        });
        return 'blocked';
      case 'ok':
        this.consecutiveFailures = 0;
        this.consecutiveDriftFailures = 0;
        this.consecutiveBlocked = 0;
        if (outcome.alreadyInState === true) {
          if (this.unverifiedClicks.get(rec.accountPk) === 'follow') {
            // Amendment C: OUR previous click landed (the tab stalled before it
            // could verify) — this is our action, not an external actor's.
            // Record it as ours: ledger row, lifecycle transition, edge.
            this.unverifiedClicks.delete(rec.accountPk);
            this.store.recordAction(rec.accountPk, 'follow', 'ok', now);
            this.store.upsertFollowRecord({ ...rec, state: 'pending_followback', followedAt: now });
            if (this.ownPk !== undefined) {
              this.store.observeEdge(this.ownPk, rec.accountPk, 'follows', true, now);
            }
            log.info('churn: unverified follow confirmed landed, recorded as ours', {
              pk: rec.accountPk,
              username,
            });
            return 'ok';
          }
          // Phase A: nothing was clicked — an external actor already follows this
          // account. Reconcile (drops the record to `external` + writes the edge);
          // NO ledger row and NO pending_followback — the follow was never ours.
          this.store.reconcileOwnFollow(rec.accountPk, true, now);
          log.info('churn: follow found already-following (external), backing off', {
            pk: rec.accountPk,
            username,
          });
          return 'ok';
        }
        this.unverifiedClicks.delete(rec.accountPk);
        this.store.recordAction(rec.accountPk, 'follow', 'ok', now);
        this.store.upsertFollowRecord({ ...rec, state: 'pending_followback', followedAt: now });
        if (this.ownPk !== undefined) {
          this.store.observeEdge(this.ownPk, rec.accountPk, 'follows', true, now);
        }
        log.info('churn: followed', { pk: rec.accountPk, username });
        return 'ok';
      case 'simulated':
        // f12: advance the lifecycle under dry-run WITHOUT a real edge or ledger row.
        this.consecutiveFailures = 0;
        this.consecutiveDriftFailures = 0;
        this.consecutiveBlocked = 0;
        this.unverifiedClicks.delete(rec.accountPk);
        this.store.upsertFollowRecord({ ...rec, state: 'pending_followback', followedAt: now });
        log.info('churn: dry-run follow simulated, state advanced (no edge/ledger)', {
          pk: rec.accountPk,
          username,
        });
        return 'simulated';
      case 'failed':
        // A definitive failed click also settles an earlier unverified one: had
        // it landed, this attempt would have read already-in-state instead.
        this.unverifiedClicks.delete(rec.accountPk);
        this.consecutiveFailures += 1;
        if (outcome.cause === 'drift') this.consecutiveDriftFailures += 1;
        this.store.recordAction(rec.accountPk, 'follow', 'fail', now);
        this.retryOrAbandon(rec, 'follow', now);
        return 'failed';
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
  private async executeUnfollow(
    rec: FollowRecord,
    now: number,
  ): Promise<ChurnActionOutcome['status'] | 'noop'> {
    const username = this.store.getAccount(rec.accountPk)?.username;
    if (username === undefined) {
      // Same starvation guard as the follow path: progress or abandon.
      log.warn('churn: no username for due unfollow, burning a retry', { pk: rec.accountPk });
      this.retryOrAbandon(rec, 'unfollow', now);
      return 'noop';
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
        this.consecutiveBlocked += 1;
        if (outcome.unverifiedClick === true) {
          // Amendment C: post-click tab stall — the unfollow may have landed.
          this.unverifiedClicks.set(rec.accountPk, 'unfollow');
          log.warn('churn: unfollow click dispatched but unverified (tab stall), will re-observe', {
            pk: rec.accountPk,
            username,
          });
        }
        log.info('churn: unfollow blocked, leaving record untouched', {
          pk: rec.accountPk,
          username,
          cause: outcome.cause ?? null,
        });
        return 'blocked';
      case 'ok':
        this.consecutiveFailures = 0;
        this.consecutiveDriftFailures = 0;
        this.consecutiveBlocked = 0;
        if (outcome.alreadyInState === true) {
          if (this.unverifiedClicks.get(rec.accountPk) === 'unfollow') {
            // Amendment C: OUR previous unfollow landed unverified — record it
            // as ours (ledger + close + edge removal), not as external.
            this.unverifiedClicks.delete(rec.accountPk);
            this.store.recordAction(rec.accountPk, 'unfollow', 'ok', now);
            this.store.upsertFollowRecord({ ...rec, state: 'unfollowed' });
            if (this.ownPk !== undefined) {
              this.store.observeEdge(this.ownPk, rec.accountPk, 'follows', false, now);
            }
            log.info('churn: unverified unfollow confirmed landed, recorded as ours', {
              pk: rec.accountPk,
              username,
            });
            return 'ok';
          }
          // Phase A: nothing was clicked — already not following (an external
          // actor unfollowed for us). Reconcile the edge, close the record, and
          // write NO ledger row — the unfollow was not our action.
          this.store.reconcileOwnFollow(rec.accountPk, false, now);
          this.store.upsertFollowRecord({ ...rec, state: 'unfollowed' });
          log.info('churn: unfollow found already-not-following (external), reconciled', {
            pk: rec.accountPk,
            username,
          });
          return 'ok';
        }
        this.unverifiedClicks.delete(rec.accountPk);
        this.store.recordAction(rec.accountPk, 'unfollow', 'ok', now);
        this.store.upsertFollowRecord({ ...rec, state: 'unfollowed' });
        if (this.ownPk !== undefined) {
          this.store.observeEdge(this.ownPk, rec.accountPk, 'follows', false, now);
        }
        log.info('churn: unfollowed', { pk: rec.accountPk, username });
        return 'ok';
      case 'simulated':
        // f12: advance the lifecycle under dry-run WITHOUT removing a real edge.
        this.consecutiveFailures = 0;
        this.consecutiveDriftFailures = 0;
        this.consecutiveBlocked = 0;
        this.unverifiedClicks.delete(rec.accountPk);
        this.store.upsertFollowRecord({ ...rec, state: 'unfollowed' });
        log.info('churn: dry-run unfollow simulated, state advanced (no edge/ledger)', {
          pk: rec.accountPk,
          username,
        });
        return 'simulated';
      case 'failed':
        this.unverifiedClicks.delete(rec.accountPk);
        this.consecutiveFailures += 1;
        if (outcome.cause === 'drift') this.consecutiveDriftFailures += 1;
        this.store.recordAction(rec.accountPk, 'unfollow', 'fail', now);
        this.retryOrAbandon(rec, 'unfollow', now);
        return 'failed';
    }
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
}

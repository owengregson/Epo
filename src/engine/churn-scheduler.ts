import type { Clock } from '../governors/clock';
import type { RateGovernor } from '../governors/rate-governor';
import type { KnowledgeStore } from '../store/knowledge-store';
import { compareByScoreDesc, type FollowRecord, type FollowState } from '../store/types';
import { MS_PER_DAY } from '../timing/units';
import * as log from '../utils/logger';
import { bioMatchesFilter } from './prune-bio-filter';

/**
 * The discriminated outcome of a single follow/unfollow attempt:
 *
 * - `'ok'`        — the click was performed and the Actor verified the transition.
 * - `'failed'`    — a click was attempted but did not confirm (retry/abandon).
 * - `'blocked'`   — Sentinel non-`ok` BEFORE any click; the
 *                   record is left completely untouched so it retries when the
 *                   window clears. A block is NOT a failure.
 * - `'simulated'` — dry-run: no click happened. The lifecycle STATE still advances
 *                   (so dry-run exercises the machine) but no real edge/ledger row
 *                   is written, so dry-run never pollutes yield/overlap.
 */
export type ChurnActionOutcome = {
  status: 'ok' | 'failed' | 'blocked' | 'simulated';
  /** True when `ok` but no click happened — the button was already in the target
   *  state, so an external actor is responsible for the relationship. */
  alreadyInState?: boolean;
  /**
   * Why a non-ok outcome happened, when the cause is classifiable:
   *  - `'tab-unhealthy'` — the TAB stalled or its webContents was unavailable
   *    (status `'blocked'`: record-neutral — never a retry, never a fail row;
   *    the recovery ladder routes it to tab recovery, not the wait ladder).
   *  - `'drift'` — an `AdapterStaleError`: the expected control is gone
   *    (status `'failed'`; feeds the ladder's drift-evidence tally).
   *  - `'rate-limited'` — Instagram's SERVER refused the mutation as
   *    throttling (`feedback_required` / 429 in the response; status
   *    `'blocked'`: record-neutral, but DEFINITIVE — the engines back off at
   *    once instead of proving a blocked streak against the wall).
   * Absent when the cause is unknown or ordinary.
   */
  cause?: 'tab-unhealthy' | 'drift' | 'rate-limited';
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
 * Lifecycle timers + retry cap for the churn state machine. All tunable in
 * Settings. NB: the post-follow-back HOLD is not here — `holdUntil` is stamped by the
 * FollowbackWatcher (its `holdAfterFollowbackMs`); the scheduler only honors the stamp.
 */
export interface ChurnConfig {
  /** How long to wait for a follow-back before reclaiming the slot (default 4 days). */
  maxWaitForFollowbackMs: number;
  /** Failed follow/unfollow attempts tolerated before a record is abandoned (default 3). */
  maxRetries: number;
  /**
   * The bio keep-list (Settings `pruneBioFilterWords`): an account that
   * FOLLOWS US BACK and whose bio contains any of these words/phrases
   * (case-insensitive substring — see prune-bio-filter.ts) is never rotated
   * out or unfollowed; it stays a kept mutual. Deliberately scoped to
   * follow-backs only: a non-follower is pruned regardless of bio (both the
   * one-shot prune run and the woven trickle feed).
   */
  bioKeepWords: string[];
}

/** Design defaults. */
export const CHURN_DEFAULTS: ChurnConfig = {
  maxWaitForFollowbackMs: 4 * MS_PER_DAY,
  maxRetries: 3,
  bioKeepWords: [],
};

/** What one verb does to a record and the graph when its action verifies. */
interface VerbSpec {
  /** The follows-edge polarity a verified action leaves behind. */
  edge: boolean;
  /** The lifecycle state a verified action lands in. */
  next: FollowState;
  /** Whether the transition stamps `followedAt`. */
  stampsFollowedAt: boolean;
  /** Whether an EXTERNAL already-in-state result also closes the record. */
  closeOnExternal: boolean;
}

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
  /**
   * Records whose last attempt ended in a POST-CLICK tab failure: the click was
   * dispatched but never verified, so it may have LANDED. On the next attempt an
   * already-in-state result for a MARKED record is our landed click, not an
   * external actor's. In-memory by design — losing it across a relaunch degrades
   * to the safe reconcile. See `docs/adr/0206-unverified-click-arbitration.md`.
   */
  private readonly unverifiedClicks = new Map<string, 'follow' | 'unfollow'>();

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
    // Reciprocated and held long enough → time to unfollow — UNLESS the bio
    // keep-list protects this mutual. The gate re-evaluates on every sweep
    // (no state is rewritten), so editing the keep-words — or the follower
    // unfollowing us — takes effect on the next pass.
    for (const rec of this.store.followRecordsByState('followed_back')) {
      if (rec.holdUntil === undefined) continue;
      if (now >= rec.holdUntil) {
        if (this.bioKeepsFollower(rec.accountPk)) continue;
        this.store.upsertFollowRecord({ ...rec, state: 'unfollow_queued', unfollowDueAt: now });
        log.info('churn: hold elapsed, queuing unfollow', { pk: rec.accountPk });
      }
    }
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
    const username = this.store.getAccount(rec.accountPk)?.username;
    if (username === undefined) {
      // MUST make progress: `nextDue` is a pure ranking with no memory, so a
      // bare return would hand this same record back every step forever. Burn a
      // retry (no ledger row — nothing touched Instagram) until it abandons.
      log.warn('churn: no username for due follow, burning a retry', { pk: rec.accountPk });
      this.retryOrAbandon(rec, 'follow', now);
      return 'noop';
    }
    return this.applyOutcome(rec, 'follow', username, await this.attempt('follow', rec, username), now);
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
    return this.applyOutcome(
      rec,
      'unfollow',
      username,
      await this.attempt('unfollow', rec, username),
      now,
    );
  }

  /** Perform the click. The port resolves rather than rejects; a rejection is
   *  still caught (no silent catches — it is logged and read as a failure). */
  private async attempt(
    verb: 'follow' | 'unfollow',
    rec: FollowRecord,
    username: string,
  ): Promise<ChurnActionOutcome> {
    try {
      return await this.actions[verb](username);
    } catch (err) {
      log.error(`churn: ${verb} action threw`, {
        pk: rec.accountPk,
        username,
        error: String(err),
      });
      return { status: 'failed' };
    }
  }

  /**
   * THE outcome rules, once, for both verbs:
   *
   *  - `'blocked'`   — nothing was clicked: the record is left completely
   *                    untouched (no ledger, no retry) and the streak feeds the
   *                    ladder. A post-click tab stall additionally MARKS the
   *                    record, so the next attempt's already-in-state pre-check
   *                    can claim the landed click as ours.
   *  - `'ok'`        — ledger row + lifecycle transition + directed edge. When
   *                    the click was skipped (`alreadyInState`) the marker
   *                    decides: OUR landed click is recorded as ours; anything
   *                    else is an external actor's, reconciled per verb.
   *  - `'simulated'` — dry-run: the lifecycle advances, no edge, no ledger row.
   *  - `'failed'`    — ledger `fail` + retry/abandon.
   */
  private applyOutcome(
    rec: FollowRecord,
    verb: 'follow' | 'unfollow',
    username: string,
    outcome: ChurnActionOutcome,
    now: number,
  ): ChurnActionOutcome['status'] {
    const spec = ChurnScheduler.VERBS[verb];
    const pk = rec.accountPk;

    switch (outcome.status) {
      case 'blocked':
        this.consecutiveBlocked += 1;
        this.lastBlockCause = outcome.cause ?? null;
        if (outcome.unverifiedClick === true) {
          this.unverifiedClicks.set(pk, verb);
          log.warn(`churn: ${verb} click dispatched but unverified (tab stall), will re-observe`, {
            pk,
            username,
          });
        }
        log.info(`churn: ${verb} blocked, leaving record untouched`, {
          pk,
          username,
          cause: outcome.cause ?? null,
        });
        return 'blocked';

      case 'ok': {
        this.clearStreaksOnVerified();
        const ourLandedClick = this.unverifiedClicks.get(pk) === verb;
        this.unverifiedClicks.delete(pk);
        if (outcome.alreadyInState === true && !ourLandedClick) {
          this.store.reconcileOwnFollow(pk, spec.edge, now);
          if (spec.closeOnExternal) {
            this.store.upsertFollowRecord({ ...rec, state: spec.next });
          }
          log.info(`churn: ${verb} found already in the target state (external), reconciled`, {
            pk,
            username,
          });
          return 'ok';
        }
        this.commit(rec, verb, spec, now);
        log.info(
          ourLandedClick
            ? `churn: unverified ${verb} confirmed landed, recorded as ours`
            : `churn: ${verb} performed`,
          { pk, username },
        );
        return 'ok';
      }

      case 'simulated':
        this.clearStreaksOnVerified();
        this.unverifiedClicks.delete(pk);
        this.store.upsertFollowRecord(this.transition(rec, spec, now));
        log.info(`churn: dry-run ${verb} simulated, state advanced (no edge/ledger)`, {
          pk,
          username,
        });
        return 'simulated';

      case 'failed':
        // A definitive failed click also settles an earlier unverified one: had
        // it landed, this attempt would have read already-in-state instead.
        this.unverifiedClicks.delete(pk);
        this.consecutiveFailures += 1;
        this.lastBlockCause = null;
        if (outcome.cause === 'drift') this.consecutiveDriftFailures += 1;
        this.store.recordAction(pk, verb, 'fail', now);
        this.retryOrAbandon(rec, verb, now);
        return 'failed';
    }
  }

  /** A verified action: ledger row, lifecycle transition, directed edge. */
  private commit(
    rec: FollowRecord,
    verb: 'follow' | 'unfollow',
    spec: VerbSpec,
    now: number,
  ): void {
    this.store.recordAction(rec.accountPk, verb, 'ok', now);
    this.store.upsertFollowRecord(this.transition(rec, spec, now));
    if (this.ownPk !== undefined) {
      this.store.observeEdge(this.ownPk, rec.accountPk, 'follows', spec.edge, now);
    }
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
}

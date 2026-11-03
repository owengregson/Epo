/**
 * AdapterBackedChurnActions — the live implementation of the `ChurnActions` port
 * (§2). This is where a SINGLE follow/unfollow's pre-checks live; the paced delay
 * between actions is the Engine's concern, never this class's.
 *
 * Two invariants:
 *
 *  - It RESOLVES with a discriminated outcome, never rejects. The scheduler must
 *    tell a *blocked* action (sentinel non-ok before any click, a wall, a tab
 *    stall) apart from a genuine *failed* click: `blocked` leaves the record
 *    completely untouched for a later retry, `failed` burns one. A thrown Actor
 *    error is caught, logged (never silently), and classified by type.
 *  - The hard-ceiling gate is the Engine's job — it decides *when* to call
 *    `execute` — so it is deliberately not re-checked here.
 */

import {
  ActionAbortedError,
  ActionBlockedError,
  ActionDeferredError,
  ActionRateLimitedError,
  ActionReviewedError,
  AdapterStaleError,
  TabUnavailableError,
  TabUnresponsiveError,
} from '@/adapter/errors';
import type { InstagramAdapter } from '@/adapter/instagram-adapter';
import type { ChurnActionOutcome, ChurnActions } from '@/engine/churn-scheduler';
import { normalizeMutationOutcome } from '@/engine/mutation-outcome';
import { type Clock, SystemClock } from '@/governors/clock';
import type { KnowledgeStore } from '@/store/knowledge-store';
import * as logger from '@/utils/logger';

export interface ChurnActionsDeps {
  validateIdentity?: () => Promise<boolean>;
  adapter: InstagramAdapter;
  store: KnowledgeStore;
  /** Our own account pk; when set, its `accounts` endpoint is ensured once. */
  ownPk?: string;
  /** When true, log-and-noop the click while the ledger still records intent. */
  dryRun: boolean;
  clock?: Clock;
}

export class AdapterBackedChurnActions implements ChurnActions {
  private readonly adapter: InstagramAdapter;
  private readonly store: KnowledgeStore;
  private readonly ownPk?: string;
  private dryRun: boolean;
  private readonly clock: Clock;
  private selfEnsured = false;
  private readonly validateIdentity?: () => Promise<boolean>;

  constructor(deps: ChurnActionsDeps) {
    this.adapter = deps.adapter;
    this.validateIdentity = deps.validateIdentity;
    this.store = deps.store;
    this.ownPk = deps.ownPk;
    this.dryRun = deps.dryRun;
    this.clock = deps.clock ?? new SystemClock();
  }

  /** Toggle dry-run at runtime (used when Settings are updated). */
  setDryRun(dryRun: boolean): void {
    this.dryRun = dryRun;
  }

  follow(username: string, expectedPk?: string, onDispatch?: () => void): Promise<ChurnActionOutcome> {
    return this.act(username, 'follow', expectedPk, onDispatch);
  }

  unfollow(username: string, expectedPk?: string, onDispatch?: () => void): Promise<ChurnActionOutcome> {
    return this.act(username, 'unfollow', expectedPk, onDispatch);
  }

  private async act(
    username: string,
    action: 'follow' | 'unfollow',
    expectedPk?: string,
    onDispatch?: () => void,
  ): Promise<ChurnActionOutcome> {
    this.ensureSelfObserved();
    if (this.validateIdentity && !(await this.validateIdentity())) return { status: 'blocked' };

    // Order: sentinel → (dry-run) → click. A block BEFORE the click is not a
    // failure — the scheduler leaves the record untouched to retry later.
    const status = await this.adapter.sentinel.check();
    if (status !== 'ok') {
      logger.warn('rim.churn-actions: sentinel blocked, blocking action', {
        username,
        action,
        status,
      });
      return { status: 'blocked' };
    }

    if (this.dryRun) {
      logger.info('rim.churn-actions: dry-run, simulating action (no click)', {
        username,
        action,
      });
      return { status: 'simulated' };
    }

    let dispatched = false;
    const dispatch = (): void => { onDispatch?.(); dispatched = true; };
    try {
      const result =
        action === 'follow'
          ? await this.adapter.actor.follow(username, expectedPk, dispatch)
          : await this.adapter.actor.unfollow(username, expectedPk, dispatch);
      // The Actor already verified the post-click state; trust its Result.
      // An ok WITHOUT a click means the button was already in the
      // target state — an external actor owns the relationship. Surface it as
      // `alreadyInState` so the scheduler reconciles instead of claiming it.
      return result.ok
        ? { status: 'ok', alreadyInState: !result.value.clicked }
        : normalizeMutationOutcome({ status: 'failed' }, dispatched);
    } catch (e) {
      if (dispatched && !(e instanceof ActionRateLimitedError)) {
        logger.warn('rim.churn-actions: dispatched action has no verified result', { username, action, error: String(e) });
        return { status: 'blocked', cause: 'tab-unhealthy', unverifiedClick: true };
      }
      // The review consumed the work (spec §9.7): the scheduler settles the record by the verdict.
      if (e instanceof ActionReviewedError) return { status: 'reviewed', verdict: e.verdict };
      // A deferral (a plan refusal, this account's journal, a wall) leaves the work for later; its reason travels.
      if (e instanceof ActionDeferredError) {
        return { status: 'blocked', cause: 'local-policy', verdict: { kind: 'deferred', reason: e.reason, until: e.until } };
      }
      if (e instanceof ActionAbortedError) {
        // A user stop/pause interrupted the wait — NOT a failure and NOT
        // selector drift. 'blocked' leaves the record completely untouched
        // (no ledger row, no retry burned) so it acts when the engine resumes.
        logger.info('rim.churn-actions: action aborted by driver stop, leaving record untouched', {
          username,
          action,
        });
        return { status: 'blocked' };
      }
      if (e instanceof ActionRateLimitedError) {
        // Instagram's SERVER refused the mutation as throttling (the response
        // said so — no page dialog, the button merely snapped back). Record-
        // neutral like every block, but the cause is DEFINITIVE: the engines
        // back off at once instead of proving a streak against the wall.
        logger.warn('rim.churn-actions: Instagram refused the action as rate-limited', {
          username,
          action,
          httpStatus: e.httpStatus,
          detail: e.detail,
        });
        return { status: 'blocked', cause: 'rate-limited' };
      }
      if (e instanceof ActionBlockedError) {
        // Instagram put a block interstitial where the expected control was —
        // the ACTION is throttled, not broken. 'blocked' leaves the record/
        // candidate untouched; the schedulers' blocked handling (park + retry,
        // halt when persistent) is exactly the right response.
        logger.warn('rim.churn-actions: Instagram blocked the action mid-flow', {
          username,
          action,
          matched: e.matchedText,
        });
        return { status: 'blocked' };
      }
      if (e instanceof TabUnresponsiveError) {
        // The TAB stalled — a renderer/CDP condition, never the record's fault
        // and never selector drift. Record-neutral like the other blocks (no
        // retry burned, no fail ledger row); `cause` routes the recovery
        // ladder to tab recovery, and a post-click stall flags the record for
        // re-observation (the click may have landed).
        logger.warn('rim.churn-actions: tab unresponsive mid-action, leaving record untouched', {
          username,
          action,
          component: e.component,
          phase: e.phase ?? 'pre-click',
        });
        return {
          status: 'blocked',
          cause: 'tab-unhealthy',
          unverifiedClick: e.phase === 'post-click' ? true : undefined,
        };
      }
      if (e instanceof TabUnavailableError) {
        // The tab's webContents is destroyed/uninitialized (teardown race,
        // hard navigation failure) — the same tab-machinery family as a stall.
        logger.warn('rim.churn-actions: tab webContents gone, leaving record untouched', {
          username,
          action,
        });
        return { status: 'blocked', cause: 'tab-unhealthy' };
      }
      if (e instanceof AdapterStaleError) {
        // The expected control is gone: possible interface drift. Still a
        // 'failed' (retry/abandon as before) — the `cause` feeds the recovery
        // ladder's drift-evidence tally, which only confirms drift over
        // repeated windows with clean tab diagnostics.
        logger.error('rim.churn-actions: adapter stale (possible drift)', {
          username,
          action,
          selector: e.selector,
        });
        return { status: 'failed', cause: 'drift' };
      }
      logger.error('rim.churn-actions: actor threw', {
        username,
        action,
        error: String(e),
      });
      return { status: 'failed' };
    }
  }

  /**
   * Ensure our own account exists as a real `accounts` endpoint so
   * `ownPk`-anchored edges (written by the ChurnScheduler) resolve to a node.
   * Lazy and idempotent — runs at most once, only if `ownPk` is set and no row
   * already exists.
   */
  private ensureSelfObserved(): void {
    if (this.selfEnsured || this.ownPk === undefined) return;
    this.selfEnsured = true;
    if (this.store.getAccount(this.ownPk) !== null) return;
    this.store.observe({
      accountPk: this.ownPk,
      observedAt: this.clock.now(),
      source: 'action',
      fields: {},
    });
    logger.debug('rim.churn-actions: observed self endpoint', { ownPk: this.ownPk });
  }
}

/**
 * AdapterBackedChurnActions — the live implementation of the `ChurnActions` port
 * (§2). This is where a SINGLE follow/unfollow's pre-checks live; the paced delay
 * between actions is the Engine's concern, never this class's.
 *
 * Folded review fixes:
 *  - C1: gate one action on `Sentinel.check()` before the
 *        click. The hardened Actor (A3) verifies the post-click state and returns a
 *        `Result`, so the ledger/edge (written by the ChurnScheduler) only record
 *        real transitions. The hard-ceiling gate is the Engine's job (it decides
 *        *when* to call `execute`), so it is deliberately not re-checked here.
 *  - C2: observe our OWN account once (from `ownPk`) so `ownPk`-anchored edges have
 *        a real `accounts` endpoint. `pk` is the single ledger identity.
 *  - R4: resolve (never reject) with a DISCRIMINATED outcome so the scheduler can
 *        tell a *blocked* action (sentinel non-ok, BEFORE any
 *        click) apart from a genuine *failed* click. `'blocked'` leaves the record
 *        untouched for a later retry; `'simulated'` is dry-run (no click); `'ok'`/
 *        `'failed'` map the Actor's verified `Result`. A thrown Actor error is
 *        caught, logged (never silently), and reported as `'failed'`.
 */

import {
  ActionAbortedError,
  ActionBlockedError,
  AdapterStaleError,
  TabUnresponsiveError,
} from '@/adapter/errors';
import type { InstagramAdapter } from '@/adapter/instagram-adapter';
import type { ChurnActionOutcome, ChurnActions } from '@/engine/churn-scheduler';
import { type Clock, SystemClock } from '@/governors/clock';
import type { KnowledgeStore } from '@/store/knowledge-store';
import * as logger from '@/utils/logger';

export interface ChurnActionsDeps {
  adapter: InstagramAdapter;
  store: KnowledgeStore;
  /** Our own account pk; when set, its `accounts` endpoint is ensured once (C2). */
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

  constructor(deps: ChurnActionsDeps) {
    this.adapter = deps.adapter;
    this.store = deps.store;
    this.ownPk = deps.ownPk;
    this.dryRun = deps.dryRun;
    this.clock = deps.clock ?? new SystemClock();
  }

  /** Toggle dry-run at runtime (used when Settings are updated). */
  setDryRun(dryRun: boolean): void {
    this.dryRun = dryRun;
  }

  follow(username: string): Promise<ChurnActionOutcome> {
    return this.act(username, 'follow');
  }

  unfollow(username: string): Promise<ChurnActionOutcome> {
    return this.act(username, 'unfollow');
  }

  private async act(
    username: string,
    action: 'follow' | 'unfollow',
  ): Promise<ChurnActionOutcome> {
    this.ensureSelfObserved();

    // C1/R4 order: sentinel → (dry-run) → click. A block BEFORE the click
    // is not a failure — the scheduler leaves the record untouched to retry later.
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

    try {
      const result =
        action === 'follow'
          ? await this.adapter.actor.follow(username)
          : await this.adapter.actor.unfollow(username);
      // A3: the Actor already verified the post-click state; trust its Result.
      // Phase A: an ok WITHOUT a click means the button was already in the
      // target state — an external actor owns the relationship. Surface it as
      // `alreadyInState` so the scheduler reconciles instead of claiming it.
      return result.ok
        ? { status: 'ok', alreadyInState: !result.value.clicked }
        : { status: 'failed' };
    } catch (e) {
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
        // re-observation (the click may have landed — amendment C).
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
      if (e instanceof Error && e.message.includes('webContents unavailable')) {
        // The tab's webContents is destroyed/uninitialized (teardown race,
        // hard navigation failure) — the same tab-machinery family as a stall.
        logger.warn('rim.churn-actions: webContents unavailable, leaving record untouched', {
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
   * C2: ensure our own account exists as a real `accounts` endpoint so
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

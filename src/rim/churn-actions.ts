/**
 * AdapterBackedChurnActions — the live implementation of the `ChurnActions` port
 * (§2). This is where a SINGLE follow/unfollow's pre-checks live; the human delay
 * between actions is the Engine's concern, never this class's.
 *
 * Folded review fixes:
 *  - C1: gate one action on `budget.canSpend()` then `Sentinel.check()` before the
 *        click. The hardened Actor (A3) verifies the post-click state and returns a
 *        `Result`, so the ledger/edge (written by the ChurnScheduler) only record
 *        real transitions. The hard-ceiling gate is the Engine's job (it decides
 *        *when* to call `execute`), so it is deliberately not re-checked here.
 *  - C2: observe our OWN account once (from `ownPk`) so `ownPk`-anchored edges have
 *        a real `accounts` endpoint. `pk` is the single ledger identity.
 *  - R4: resolve (never reject) with a DISCRIMINATED outcome so the scheduler can
 *        tell a *blocked* action (budget exhausted / sentinel non-ok, BEFORE any
 *        click) apart from a genuine *failed* click. `'blocked'` leaves the record
 *        untouched for a later retry; `'simulated'` is dry-run (no click); `'ok'`/
 *        `'failed'` map the Actor's verified `Result`. A thrown Actor error is
 *        caught, logged (never silently), and reported as `'failed'`.
 */

import type { InstagramAdapter } from '@/adapter/instagram-adapter';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { RequestBudget } from '@/governors/request-budget';
import { SystemClock, type Clock } from '@/governors/clock';
import type { ChurnActions, ChurnActionOutcome } from '@/engine/churn-scheduler';
import * as logger from '@/utils/logger';

export interface ChurnActionsDeps {
  adapter: InstagramAdapter;
  budget: RequestBudget;
  store: KnowledgeStore;
  /** Our own account pk; when set, its `accounts` endpoint is ensured once (C2). */
  ownPk?: string;
  /** When true, log-and-noop the click while the ledger still records intent. */
  dryRun: boolean;
  clock?: Clock;
}

export class AdapterBackedChurnActions implements ChurnActions {
  private readonly adapter: InstagramAdapter;
  private readonly budget: RequestBudget;
  private readonly store: KnowledgeStore;
  private readonly ownPk?: string;
  private dryRun: boolean;
  private readonly clock: Clock;
  private selfEnsured = false;

  constructor(deps: ChurnActionsDeps) {
    this.adapter = deps.adapter;
    this.budget = deps.budget;
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

    // C1/R4 order: budget → sentinel → (dry-run) → click. A block BEFORE the click
    // is not a failure — the scheduler leaves the record untouched to retry later.
    if (!this.budget.canSpend()) {
      logger.warn('rim.churn-actions: request budget exhausted, blocking action', {
        username,
        action,
      });
      return { status: 'blocked' };
    }

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

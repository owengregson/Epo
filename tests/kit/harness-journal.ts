/**
 * The engine kit's mutation-effect fakes: scripted churn and prune actions, the
 * no-op woven unfollow feed, and a protection rig. Re-exported by `engine-harness.ts`.
 */

import type { ChurnActionOutcome, ChurnActions } from '@/engine/churn-scheduler';
import type { EngineUnfollowFeed } from '@/engine/engine';
import { createProtectionPort, type ProtectionPort } from '@/engine/protection-port';
import type { Clock } from '@/governors/clock';
import { calendarPlanDayClock } from '@/governors/plan-day-clock';
import type { ProtectionSettings, ProtectionState } from '@/shared/settings-model';
import { compileProtection } from '@/shared/unfollow-protection';

/** A live protection index a test edits in place, behind a real port on local-midnight plan-days. */
export class ProtectionRig {
  settings: ProtectionSettings = { accounts: [], words: [], wordMatch: 'anywhere', keepVerified: false };
  state: ProtectionState = 'ready';
  rev = 1;
  readonly port: ProtectionPort;
  constructor(clock: Clock) {
    this.port = createProtectionPort({
      index: () => compileProtection(this.settings, this.state, this.rev),
      clock, dayClock: calendarPlanDayClock({ now: () => clock.now() }),
    });
  }
  private edit(over: Partial<ProtectionSettings>): this {
    this.settings = { ...this.settings, ...over };
    this.rev += 1;
    return this;
  }
  words(...texts: string[]): this { return this.edit({ words: texts.map((text) => ({ text, addedAt: 0 })) }); }
  verified(on = true): this { return this.edit({ keepVerified: on }); }
  account(pk: string, username: string): this {
    return this.edit({ accounts: [...this.settings.accounts,
      { pk, username, linkedAt: 1, formerUsernames: [], addedAt: 1, source: 'you', valid: true }] });
  }
  pause(state: Exclude<ProtectionState, 'ready'>): this { this.state = state; this.rev += 1; return this; }
}

/** Scripted prune churn actions: per-username outcomes, defaulting to a verified ok. */
export class FakePruneActions {
  unfollows: string[] = [];
  outcomes = new Map<string, ChurnActionOutcome>();
  async unfollow(username: string): Promise<ChurnActionOutcome> {
    this.unfollows.push(username);
    return this.outcomes.get(username) ?? { status: 'ok' };
  }
}

/** Records every churn call and returns a configurable discriminated outcome. */
export class FakeActions implements ChurnActions {
  followCalls: string[] = [];
  unfollowCalls: string[] = [];
  followOk = true;
  unfollowOk = true;
  followStatus?: ChurnActionOutcome['status'];
  unfollowStatus?: ChurnActionOutcome['status'];
  /** Report an `ok` that clicked nothing (already in the target state). */
  followAlreadyInState?: boolean;
  unfollowAlreadyInState?: boolean;
  /** Recovery-ladder classification of a non-ok outcome (tab stall / drift). */
  followCause?: ChurnActionOutcome['cause'];
  unfollowCause?: ChurnActionOutcome['cause'];
  /** The click was dispatched but its verification stalled. */
  followUnverifiedClick?: boolean;
  unfollowUnverifiedClick?: boolean;
  async follow(username: string): Promise<ChurnActionOutcome> {
    this.followCalls.push(username);
    return {
      status: this.followStatus ?? (this.followOk ? 'ok' : 'failed'),
      alreadyInState: this.followAlreadyInState,
      cause: this.followCause,
      unverifiedClick: this.followUnverifiedClick,
    };
  }
  async unfollow(username: string): Promise<ChurnActionOutcome> {
    this.unfollowCalls.push(username);
    return {
      status: this.unfollowStatus ?? (this.unfollowOk ? 'ok' : 'failed'),
      alreadyInState: this.unfollowAlreadyInState,
      cause: this.unfollowCause,
      unverifiedClick: this.unfollowUnverifiedClick,
    };
  }
}

/**
 * The no-op woven feed. `EngineDeps.unfollowFeed` is REQUIRED (the composition
 * root always wires one); "prune weaving is off" is a feed that offers nothing,
 * not an absent port.
 */
export const NO_UNFOLLOW_FEED: EngineUnfollowFeed = {
  nextCandidate: () => null,
  executeUnfollow: () => Promise.resolve('failed'),
  atDailyCap: () => true,
};

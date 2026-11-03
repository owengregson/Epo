/**
 * The engine kit's mutation-effect fakes: scripted churn and prune actions and
 * the no-op woven unfollow feed. Re-exported by `engine-harness.ts`.
 */

import type { ChurnActionOutcome, ChurnActions } from '@/engine/churn-scheduler';
import type { EngineUnfollowFeed } from '@/engine/engine';

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

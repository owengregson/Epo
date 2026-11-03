/**
 * The plan-facing fact sources: the pacing model's session gate, and the one
 * action the tick may take (the due record, the woven offer, the weave draw).
 */

import type { Settings } from '../settings/settings';
import { PATTERN } from '../timing/config';
import type { FactSource, FeedCandidate } from './facts';
import type { EnginePacing } from './plan-port';
import type { EngineChurn } from './ports';

/** What the plan sources read (the Engine's fact deps satisfy it). */
export interface PlanFactDeps {
  /** Live settings (swapped between steps). */
  settings(): Settings;
  /** The organic planner, or undefined in the legacy model. */
  pacing?: EnginePacing;
  churn: EngineChurn;
  /** The woven prune feed's next offer (consumes leading skips — see the Engine). */
  selectPruneCandidate(now: number): FeedCandidate | null;
  /** The seeded engine stream (never the noise stream). */
  rng(): number;
}

/** The pacing source: the legacy metronome or the organic planner's session gate. */
export function pacingSource(d: PlanFactDeps): FactSource<'pacing'> {
  return {
    staleAfterMs: 0,
    gather: async (read) => {
      const { now } = await read('clock');
      const settings = d.settings();
      const planner = d.pacing;
      if (planner === undefined) {
        return {
          model: 'legacy' as const,
          sessionOpen: true,
          nextSessionStartAt: now,
          hourlyVelocityCap: settings.hourlyVelocityCap,
          activeHoursStart: settings.activeHoursStart,
        };
      }
      // The planner's own clock advances only when the hard ceiling is not
      // already closing the day — a ceiling park must not consume session
      // time it never used.
      const { atHardCeiling } = await read('ledger');
      if (!atHardCeiling) planner.advance(now);
      const sessionOpen = planner.isSessionOpen(now);
      return {
        model: 'organic' as const,
        sessionOpen,
        nextSessionStartAt: sessionOpen ? now : planner.nextSessionStartAt(now),
        hourlyVelocityCap: settings.hourlyVelocityCap,
        activeHoursStart: settings.activeHoursStart,
      };
    },
  };
}

/** The action source: the due record, the woven prune offer and the weave draw. */
export function actionSource(d: PlanFactDeps): FactSource<'action'> {
  return {
    staleAfterMs: 0,
    gather: async (read) => {
      const { now } = await read('clock');
      const due = d.churn.nextDue(now);
      const pruneCandidate = d.selectPruneCandidate(now);
      const unfollowFraction = Math.min(
        d.settings().maxUnfollowFractionPerSession,
        PATTERN.MAX_UNFOLLOW_FRACTION_PER_SESSION,
      );
      // The interleave draw is taken HERE — exactly when both streams have
      // work and the lifecycle record is not itself an unfollow — so the
      // decision stays pure and the seeded stream keeps its order.
      const weaveDraw =
        due !== null && pruneCandidate !== null && due.state !== 'unfollow_queued'
          ? d.rng()
          : null;
      return { due, pruneCandidate, weaveDraw, unfollowFraction };
    },
  };
}

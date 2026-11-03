/**
 * The plan-facing fact sources: the plan's facts for the pacing verdict (spec §5.15), and the one
 * action the tick may take (the due record, the woven offer, the weave draw).
 */

import type { PlanView } from '../governors/plan-types';
import type { Settings } from '../settings/settings';
import { PATTERN } from '../timing/config';
import type { FactSource, FeedCandidate } from './facts';
import type { EnginePacing, PlanFacts } from './plan-port';
import type { EngineChurn } from './ports';

/** What the plan sources read (the Engine's fact deps satisfy it). */
export interface PlanFactDeps {
  /** Live settings (swapped between steps). */
  settings(): Settings;
  /** The plan: the one pacing model (spec §5.13 S2). */
  pacing: EnginePacing;
  churn: EngineChurn;
  /** The woven prune feed's next offer (consumes leading skips — see the Engine). */
  selectPruneCandidate(now: number): FeedCandidate | null;
  /** The seeded engine stream (never the noise stream). */
  rng(): number;
}

/** The day's automatic volume: what the day law drew, or more once a Boost lifted it. */
const dayVolume = (view: PlanView): number => Math.max(view.plan.volume.drawn, view.plan.volume.planned);

/**
 * The plan's park (spec §5.16), exact: the day done (the hard ceiling or V) parks to the next
 * plan-day's first session, a closed session to the next one (with none left, to the boundary), and
 * a full rolling hour until it has room again plus one gap draw.
 */
export function planPark(view: PlanView, atHardCeiling: boolean, velocityUntil: number | null = null): PlanFacts['park'] {
  const end = view.window.endsAt;
  if (atHardCeiling || view.used.auto >= dayVolume(view)) {
    const tomorrow = view.nextSessionAt !== null && view.nextSessionAt >= end ? view.nextSessionAt : end;
    return { key: 'engine:daily-ceiling-park', until: tomorrow };
  }
  if (view.open === null) return { key: 'engine:session-park', until: view.nextSessionAt ?? end };
  if (velocityUntil !== null && velocityUntil > view.at) return { key: 'engine:velocity-park', until: velocityUntil };
  return null;
}

/**
 * The plan's facts at the view's instant. The planned check and the census host arrive with the
 * reopen sweep (RO-b); until then neither is due here.
 */
export function planFacts(view: PlanView, atHardCeiling: boolean, velocityUntil: number | null = null): PlanFacts {
  const open = view.open;
  return {
    sessionOpen: open !== null,
    park: planPark(view, atHardCeiling, velocityUntil),
    admits: {
      follow: view.admits('follow', 'growth').ok,
      unfollow: view.admits('unfollow', 'growth').ok,
      accept: view.admits('accept', 'accept-pass').ok,
      explore: open !== null,
    },
    mix: open?.mix ?? 'normal',
    probation: open?.probation ?? false,
    reads: { exploreLeft: open?.readsLeft.explore ?? 0, reconcileLeft: open?.readsLeft.reconcile ?? 0 },
    checkDue: false,
    checkLight: view.checkLight(),
    censusDue: false,
  };
}

/** The pacing source: the plan's facts, ensured only while provisional. */
export function pacingSource(d: PlanFactDeps): FactSource<'pacing'> {
  return {
    staleAfterMs: 0,
    gather: async (read) => {
      const { now } = await read('clock');
      const { atHardCeiling } = await read('ledger');
      const view = d.pacing.ensureIfProvisional(now);
      return planFacts(view, atHardCeiling, d.pacing.velocityParkUntil(now));
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

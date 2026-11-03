/**
 * The plan-facing fact sources: the plan's facts for the pacing verdict (spec §5.15), and the one
 * action the tick may take (the due record, the woven offer, the weave draw).
 */

import type { PlanView } from '../governors/plan-types';
import type { Settings } from '../settings/settings';
import type { FactSource, FeedCandidate } from './facts';
import { planMix } from './plan-mix';
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
  /** The cleanup cool-down after a rate wall (spec §5.7). */
  cleanupCooldown(now: number): boolean;
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
export function planFacts(view: PlanView, atHardCeiling: boolean, velocityUntil: number | null = null,
  explorationPaused = false): PlanFacts {
  const open = view.open;
  return {
    sessionOpen: open !== null,
    park: planPark(view, atHardCeiling, velocityUntil),
    admits: {
      follow: view.admits('follow', 'growth').ok,
      unfollow: view.admits('unfollow', 'growth').ok,
      accept: view.admits('accept', 'accept-pass').ok,
      explore: open !== null && !explorationPaused,
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
      return planFacts(view, atHardCeiling, d.pacing.velocityParkUntil(now), d.pacing.paused('exploration'));
    },
  };
}

/** The action source: the plan's mix (spec §5.7) — the one record or woven offer the tick acts on. */
export function actionSource(d: PlanFactDeps): FactSource<'action'> {
  return {
    staleAfterMs: 0,
    gather: async (read) => {
      const { now } = await read('clock');
      return planMix({ view: d.pacing.view(now), churn: d.churn, woven: () => d.selectPruneCandidate(now),
        unfollowsPaused: d.pacing.paused('unfollows'), cooldown: d.cleanupCooldown(now) }, now);
    },
  };
}

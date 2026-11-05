/**
 * Assembling a plan (ADR 0607): the day's ceilings (prorated on a short transition day), the kinds as
 * the sum over the sessions, the reads attached per session and the bookkeeping fields. Shared by the
 * draw, the re-plans and the Boost overlay. Layering: kernel siblings only.
 */

import { prorateFor } from './circadian';
import { intentDigest } from './digest';
import type { LaidSession } from './layout';
import { NO_READ_FACTS, type PlanReadFacts, planReads } from './reads';
import { dayLatent } from './tempo';
import type { DayPlan, DrawInput, PlannedSession, ReplanCause } from './types';
import { acceptsPerPass, automaticDayMax } from './volume';

export interface DrawOptions {
  /** The draw's instant (`drawnAt`); the first open by default. */
  readonly now?: number;
  readonly cause?: ReplanCause;
  readonly readFacts?: PlanReadFacts;
  /** Whether a session starting at `startAt` re-enters on probation (the service reads the ledger). */
  readonly probationAt?: (startAt: number) => boolean;
  /** The one-time upgrade probation: the first kept session runs gently. */
  readonly upgradeProbation?: boolean;
  /** A valid allocation charge recovered while another persisted plan field is repaired. */
  readonly forfeited?: number;
}

/** The plan-day's ceilings; a short transition day prorates every day counter. */
export function dayCeilings(input: DrawInput): DayPlan['ceilings'] {
  const p = prorateFor(input.window.endsAt - input.window.startsAt);
  const { intent } = input;
  return {
    automaticMax: Math.floor(automaticDayMax(intent.operatingRate) * p),
    day: Math.floor(intent.hardCeiling * p),
    hour: intent.hourlyCap,
    unfollowHour: intent.unfollowHourlyCap,
    probationHour: intent.probationHourlyCap,
    followDay: intent.operatingRate,
    acceptsPerPass: acceptsPerPass(intent.hourlyCap),
  };
}

/** Totals of the sessions' kinds (the day's kinds always equal the sum over its sessions). */
export function kindsOf(sessions: readonly Pick<PlannedSession, 'budget' | 'mix'>[], lifecycle: number): DayPlan['kinds'] {
  const sum = (k: 'follow' | 'unfollow' | 'accept'): number => sessions.reduce((a, s) => a + s.mix[k], 0);
  const budgets = sessions.reduce((a, s) => a + s.budget, 0);
  const follow = sum('follow');
  const unfollow = sum('unfollow');
  const accept = sum('accept');
  return { follow, unfollow, accept, lifecycleUnfollow: Math.min(lifecycle, unfollow), slack: budgets - follow - unfollow - accept };
}

/** Attach reads, kinds and the bookkeeping fields to laid-out sessions. */
export function assemble(input: DrawInput, seed: number, opts: DrawOptions, volume: DayPlan['volume'],
  laid: readonly LaidSession[], lifecycle: number): DayPlan {
  const kinds = kindsOf(laid, lifecycle);
  const reads = planReads(input, kinds, laid, opts.readFacts ?? NO_READ_FACTS);
  const sessions = laid.map((s, i) => ({ ...s, reads: reads.sessions[i] }));
  return {
    v: 1, window: input.window, revision: 0, cause: opts.cause ?? 'day-start',
    drawnAt: opts.now ?? input.firstOpenAt, firstOpenAt: input.firstOpenAt,
    intentDigest: intentDigest(input.intent), seed,
    volume: { ...volume, planned: sessions.reduce((a, s) => a + s.budget, 0) },
    ceilings: dayCeilings(input), kinds, reads: reads.plan, dayTempo: { z: dayLatent(seed) }, sessions, demand: input.demand,
  };
}

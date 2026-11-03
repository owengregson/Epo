/**
 * The plan's reads (ADR 0607, spec §5.8 layer 2): the day's and each session's read buckets inside
 * D6 — explore sized by the follows, reconcile by the unfollows and the journal, one check at each
 * session start plus one per check spacing, head walks from the frontier term, and the census as a
 * durable per-session predicate sized by `censusWalkMax`. Layering: kernel siblings only.
 */

import { CENSUS_POLICY } from '../census-policy';
import { NOISE } from '../derive';
import {
  censusPagesMax,
  derivePlanReadAllowance,
  frontierPages,
  type PlanReadAllowance,
  type PlanReadDemand,
} from '../derive-reads';
import { EXPLORATION_POLICY } from '../exploration-policy';
import { EMPIRICAL } from '../fundamentals';
import { BOUNDS_REENTRY } from '../reentry-policy';
import { locationOf, resolve } from '../tempo/resolve';
import { REFERENCE_TEMPO } from '../tempo/source';
import { targetMeanMs } from './gap';
import type { LaidSession } from './layout';
import { apportion } from './layout';
import type { DayPlan, DrawInput, PlanDemand, PlanIntent, ReadPlan, SessionReads, SessionTempo } from './types';

/** Surface facts the reads need that live outside the kernel (the following list's composed pages). */
export interface PlanReadFacts {
  readonly followingWalkPages: number;
}

/** Without surface facts the plan reserves no following pages. */
export const NO_READ_FACTS: PlanReadFacts = { followingWalkPages: 0 };

/** A session's check spacing: the drawn `check.spacing` at its tempo, or a slower override. */
export function checkSpacingMs(tempo: SessionTempo, intent: PlanIntent): number {
  return Math.max(locationOf(resolve('check.spacing', tempo)), intent.checkSpacingOverrideMs ?? 0);
}

/** The briskest spacing any session draws (pace at BEAT_MIN), or the slower override. */
export function checkSpacingMin(intent: PlanIntent): number {
  return checkSpacingMs({ ...REFERENCE_TEMPO, pace: NOISE.BEAT_MIN_FACTOR }, intent);
}

/**
 * Mid-session checks a plan-day can need: M actions at the slowest derived pace, one per briskest
 * spacing, plus one. A slower gap override lengthens sessions but never raises this total.
 */
export function checksPerDayMax(intent: PlanIntent): number {
  const longest = intent.hardCeiling * targetMeanMs(intent.hourlyCap, NOISE.BEAT_MAX_FACTOR, null);
  return Math.ceil(longest / checkSpacingMin(intent)) + 1;
}

/** Candidates the plan queues: the operating rate with its buffer. */
export function dailyPlanSizeOf(intent: PlanIntent): number {
  return Math.round(intent.operatingRate * intent.planBuffer);
}

/** Rows per page when no census has measured one: one slice's rows over its pages. */
const FALLBACK_ROWS = EXPLORATION_POLICY.rowsPerSlice / EXPLORATION_POLICY.pagesPerSlice;

/** The plan-day D6 demand for an intent and the store's census facts. */
export function planReadDemand(intent: PlanIntent, demand: PlanDemand, facts: PlanReadFacts = NO_READ_FACTS): PlanReadDemand {
  return {
    dailyHardCeiling: intent.hardCeiling,
    dailyPlanSize: dailyPlanSizeOf(intent),
    sessionsPerDayMax: intent.sessions.max,
    checksPerDayMax: checksPerDayMax(intent),
    censusPagesMax: censusPagesMax(demand.ownHeader, demand.census.rowsPerPage, FALLBACK_ROWS) + facts.followingWalkPages,
    frontierPages: frontierPages(intent.sessions.max),
  };
}

/** The D6 totals for an intent (the plan's reads always fit inside them, law L8). */
export function planReadAllowance(intent: PlanIntent, demand: PlanDemand, facts: PlanReadFacts = NO_READ_FACTS): PlanReadAllowance {
  return derivePlanReadAllowance(planReadDemand(intent, demand, facts));
}

/** Slices that fill `follows` with its buffer, each queuing at most `queuedPerSource` (D6's own sizing at F = P0). */
function slicesFor(follows: number, planBuffer: number): number {
  return Math.ceil(Math.round(Math.max(0, follows) * planBuffer) / EXPLORATION_POLICY.queuedPerSource);
}

/**
 * The longest census walk the host session can finish: the pages that fit its remaining window at the
 * walk's page, rest and fetch times, never more than the census bound.
 */
export function censusWalkMax(session: { readonly remainingMs: number; readonly tempo: SessionTempo }): number {
  const page = locationOf(resolve('walk.page', session.tempo));
  const rest = locationOf(resolve('walk.rest', session.tempo));
  const every = Math.max(1, locationOf(resolve('walk.rest-every', session.tempo)));
  const perPage = page + rest / every + EMPIRICAL.LATENCY.fetchEnvelope.p50;
  return Math.max(0, Math.min(CENSUS_POLICY.maxWalkPages, Math.floor(Math.max(0, session.remainingMs) / perPage)));
}

/**
 * The day's read plan and each session's buckets: explore ∝ F_s, reconcile ∝ U_s (≥ 1 for journal
 * settlement), checks = 1 + ⌊L_s / spacing_s⌋, a head walk bounded by the frontier term at each start.
 */
export function planReads(input: DrawInput, kinds: DayPlan['kinds'], sessions: readonly LaidSession[],
  facts: PlanReadFacts = NO_READ_FACTS): { readonly plan: ReadPlan; readonly sessions: readonly SessionReads[] } {
  const { intent, demand } = input;
  const x = EXPLORATION_POLICY;
  const slices = slicesFor(kinds.follow, intent.planBuffer);
  const explore = slices * (x.profilesPerSlice + x.sourceOpenReads);
  const explorePages = slices * (x.pagesPerSlice + x.sourceOpenReads);
  // Every mutation's click is a verify read (inside the reserve); journal and re-evaluation reads fill
  // the reconcile share left after the catch-up's profile.
  const d6 = planReadAllowance(intent, demand, facts);
  const reconcileShare = d6.profiles - d6.explorationProfiles - d6.verifyReserve - 1;
  const reconcile = Math.min(demand.journalPending + demand.protectedReeval, Math.max(0, reconcileShare))
    + kinds.follow + kinds.unfollow + kinds.accept;
  const kept = sessions.filter((s) => s.budget > 0);
  const byFollow = kept.map((s) => s.mix.follow + Number.EPSILON);
  const byUnfollow = kept.map((s) => s.mix.unfollow + Number.EPSILON);
  const exploreS = apportion(explore, byFollow);
  const explorePagesS = apportion(explorePages, byFollow);
  const reconcileS = apportion(Math.max(reconcile, kept.length), byUnfollow, kept.length > 0 ? 1 : 0);
  // Mid-session checks stay inside the notifications total: the start checks first, the rest by length.
  const wanted = kept.map((s) => Math.floor((s.expectedEndAt - s.startAt) / checkSpacingMs(s.tempo, intent)));
  // The catch-up holds the total's last notification.
  const room = Math.max(0, intent.sessions.max - kept.length + checksPerDayMax(intent) - 1);
  const midS = wanted.reduce((a, b) => a + b, 0) <= room ? wanted
    : apportion(room, kept.map((s) => s.expectedEndAt - s.startAt)).map((m, i) => Math.min(m, wanted[i]));
  let k = 0;
  const per = sessions.map((s): SessionReads => {
    if (s.budget <= 0) return { reconcile: 0, explore: 0, explorePages: 0, checks: 0, checkPages: 0 };
    const i = k;
    k += 1;
    return { reconcile: reconcileS[i], explore: exploreS[i], explorePages: explorePagesS[i], checks: 1 + midS[i],
      checkPages: BOUNDS_REENTRY.FRONTIER_PAGES_MAX };
  });
  const sum = (key: keyof SessionReads): number => per.reduce((a, r) => a + r[key], 0);
  const census = intent.cleanupShare > 0 ? censusPagesMax(demand.ownHeader, demand.census.rowsPerPage, FALLBACK_ROWS) : 0;
  return {
    plan: {
      reconcile: sum('reconcile'), explore: sum('explore'), explorePages: sum('explorePages'), checks: sum('checks'),
      checkPages: sum('checkPages'), census, following: facts.followingWalkPages,
      catchUp: { profiles: 1, notifications: 1, pages: BOUNDS_REENTRY.FRONTIER_PAGES_MAX },
    },
    sessions: per,
  };
}

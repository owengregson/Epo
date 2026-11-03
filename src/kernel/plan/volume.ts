/**
 * The day law and the kinds (ADR 0607, spec §5.4 step 2, §5.7): a plan-day's automatic volume is
 * `min(lognormal day, band day)` — exactly today's realized law, so no automatic day ever exceeds
 * `automaticDayMax(P0)` — and the kinds split it with no randomness (lifecycle first, follows ≤ P0).
 * Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

import { PATTERN } from '../derive';
import { POLICY } from '../policy';
import { inverseNormal, u, z } from './seed';
import type { DayOfWeek, DayPlan, PlanDayWindow, PlanDemand, PlanIntent } from './types';

/** The supremum of today's cycle plan: the largest automatic day Epo ever runs at target `P0`. */
export function automaticDayMax(operatingRate: number): number {
  const p0 = Math.max(0, Math.round(operatingRate));
  if (p0 < PATTERN.CYCLE_PLAN_MIN_CAP) return p0;
  return Math.min(p0 - 1, Math.ceil(PATTERN.CYCLE_PLAN_MAX_FRACTION * p0 - 0.5));
}

/** Today's cycle-plan band at uniform `b` ∈ [0, 1): the automatic-day ceiling the day law keeps. */
export function bandDay(operatingRate: number, b: number): number {
  const p0 = Math.max(0, Math.round(operatingRate));
  if (p0 < PATTERN.CYCLE_PLAN_MIN_CAP) return p0;
  const lo = PATTERN.CYCLE_PLAN_MIN_FRACTION;
  const hi = PATTERN.CYCLE_PLAN_MAX_FRACTION;
  return Math.min(p0 - 1, Math.max(1, Math.round(p0 * (lo + b * (hi - lo)))));
}

/** The user's own day off: the weekday of the local date the plan-day starts on. */
export function isDayOff(window: PlanDayWindow, daysOff: readonly DayOfWeek[]): boolean {
  return daysOff.includes(new Date(window.startsAt).getDay() as DayOfWeek);
}

/** The volume law from three uniforms (rest decision and fraction, lognormal z, band). */
function lawAt(intent: PlanIntent, restU: number, lnZ: number, bandU: number): DayPlan['volume'] {
  const p0 = intent.operatingRate;
  const band = bandDay(p0, bandU);
  if (intent.restDayProbability > 0 && restU < intent.restDayProbability) {
    // Given a rest draw, restU / p is itself uniform: one coordinate decides and sizes the light day.
    const lognormal = Math.max(0, Math.round(p0 * (restU / intent.restDayProbability) * PATTERN.REST_DAY_MAX_FRACTION));
    const drawn = Math.min(lognormal, band);
    return { lognormal, band, rest: true, drawn, planned: drawn, binding: 'light-day' };
  }
  const lognormal = Math.max(0, Math.round(p0 * Math.exp(Math.max(0, intent.volumeSigma) * lnZ)));
  const drawn = Math.min(lognormal, band);
  return { lognormal, band, rest: false, drawn, planned: drawn, binding: lognormal > band ? 'band' : 'none' };
}

/** The plan-day's automatic volume `V`, drawn once per plan-day (spec §5.4 step 2). */
export function drawVolume(seed: number, intent: PlanIntent): DayPlan['volume'] {
  return lawAt(intent, u(seed, 'volume-rest'), z(seed, 'volume'), u(seed, 'volume-band'));
}

/** Most days' range of the day law (Settings' "most days"): deterministic quadrature over the law. */
export function dayLawQuantiles(intent: PlanIntent): { readonly p10: number; readonly median: number; readonly p90: number } {
  const GRID = 64;
  const points: { v: number; w: number }[] = [];
  const p = Math.min(1, Math.max(0, intent.restDayProbability));
  for (let i = 0; i < GRID; i += 1) {
    const q = (i + 0.5) / GRID;
    if (p > 0) points.push({ v: lawAt(intent, q * p, 0, q).drawn, w: p / GRID });
    for (let j = 0; j < GRID; j += 1) {
      points.push({ v: lawAt(intent, 1, inverseNormal(q), (j + 0.5) / GRID).drawn, w: (1 - p) / (GRID * GRID) });
    }
  }
  points.sort((a, b) => a.v - b.v);
  const at = (target: number): number => {
    let acc = 0;
    for (const pt of points) {
      acc += pt.w;
      if (acc >= target) return pt.v;
    }
    return points[points.length - 1]?.v ?? 0;
  };
  return { p10: at(0.1), median: at(0.5), p90: at(0.9) };
}

/** Accepts per drawer pass: what the hourly cap leaves above its sustained rate (≤ 5 Standard, 3 Cautious, 6 Bold). */
export function acceptsPerPass(hourlyCap: number): number {
  return Math.max(0, Math.floor(hourlyCap - hourlyCap / POLICY.CEILING_HEADROOM));
}

/** The per-session unfollow share bound `u_max`: zero inside a Boost window. */
export function unfollowShare(boost: boolean): number {
  return boost ? 0 : PATTERN.MAX_UNFOLLOW_FRACTION_PER_SESSION;
}

/**
 * The kinds of a plan-day's volume (spec §5.7), no randomness: lifecycle unfollows first, then
 * cleanup at its share of the room, accepts (growth) up to half the rest, follows never above P0,
 * yielding up to half their share while a lifecycle backlog exceeds a day's room (never in Boost).
 */
export function allocateKinds(volume: number, intent: PlanIntent, demand: PlanDemand, boost: boolean): DayPlan['kinds'] {
  const v = Math.max(0, Math.floor(volume));
  const room = Math.floor(v * unfollowShare(boost));
  const lifecycle = Math.min(Math.max(0, demand.lifecycleDueByDayEnd), room);
  const cleanupRoom = Math.floor((room - lifecycle) * Math.max(0, intent.cleanupShare));
  const cleanup = Math.max(0, Math.min(demand.pruneStock, cleanupRoom, intent.cleanupPerDayCap ?? Number.POSITIVE_INFINITY));
  const unfollow = lifecycle + cleanup;
  const accept = intent.acceptRequests
    ? Math.max(0, Math.min(demand.pendingRequests + Math.ceil(demand.acceptsRecent), Math.floor((v - unfollow) / 2)))
    : 0;
  const excess = boost ? 0 : Math.max(0, demand.lifecycleBacklog - room);
  const open = v - unfollow - accept;
  const followCap = Math.max(0, intent.operatingRate - demand.followsDoneToday);
  const follow = Math.max(0, Math.min(open - Math.min(Math.floor(open / 2), excess), followCap));
  return { follow, unfollow, lifecycleUnfollow: lifecycle, accept, slack: open - follow };
}

/**
 * The Boost overlay (ADR 0904, spec §8.3, Q5): inside the window the remainder's unfollows wait and
 * become follows (≤ P0), the day may be lifted to automaticDayMax (prorated, never above), a session
 * opens now when Epo is meant to run and none is open; M, H, the gap floor, the tempo and D6 never
 * move. Re-applied after every re-plan. Layering: kernel siblings only.
 */

import { EMPIRICAL } from '../fundamentals';
import { MS_PER_MINUTE } from '../units';
import { kindsOf } from './assemble';
import { inQuietHours, massCurve } from './circadian';
import { apportion, availableBlocks, type LaidSession, placeSessions, sessionKinds } from './layout';
import { PLAN_BOUNDS } from './policy';
import { planReads } from './reads';
import { openSessionAt, type PlanUsage, sessionStatus } from './status';
import { sessionTempo } from './tempo';
import type { BoostWindow, DayPlan, DrawInput, PlanDayWindow } from './types';
import { isDayOff } from './volume';

const BOUNDARY = EMPIRICAL.HUMAN_SESSION_BOUNDARY_MS.value;
const NO_MIX = { follow: 0, unfollow: 0, accept: 0 } as const;

/** The part of an active Boost window inside a plan-day, or null. */
export function boostSpan(boost: BoostWindow | null, window: PlanDayWindow): { readonly t0: number; readonly t1: number } | null {
  if (boost === null || boost.endedAt !== null) return null;
  const t0 = Math.max(boost.startedAt, window.startsAt);
  const t1 = Math.min(boost.endsAt, window.endsAt);
  return t0 < t1 ? { t0, t1 } : null;
}

/** May a session open at `now`: inside the day's central λ_eff mass and outside quiet hours. */
export function insertableAt(input: DrawInput, window: PlanDayWindow, now: number): boolean {
  const d = new Date(now);
  if (inQuietHours(d.getHours() * 60 + d.getMinutes(), input.intent.quietHours)) return false;
  const curve = massCurve(window.startsAt, window.endsAt, input.intent.shape, input.phaseOffsetHours, input.intent.quietHours);
  const total = curve.cum[curve.cum.length - 1];
  const i = Math.min(curve.cum.length - 1, Math.max(0, Math.floor((now - window.startsAt) / (PLAN_BOUNDS.GRID_MINUTES * MS_PER_MINUTE))));
  const q = total > 0 ? curve.cum[i] / total : 0;
  return q >= PLAN_BOUNDS.BOOST_INSERT_MASS.LO && q <= PLAN_BOUNDS.BOOST_INSERT_MASS.HI;
}

const sumMix = (ss: readonly LaidSession[]) => ({
  follow: ss.reduce((a, s) => a + s.mix.follow, 0),
  unfollow: ss.reduce((a, s) => a + s.mix.unfollow, 0),
  accept: ss.reduce((a, s) => a + s.mix.accept, 0),
});

/** Open a session at `now` and re-lay the not-yet-started sessions after it, budgets summing to theirs. */
function insertNow(plan: DayPlan, sessions: LaidSession[], input: DrawInput, now: number, usage: PlanUsage): LaidSession[] {
  const started = sessions.filter((s, i) => s.startAt <= now || (usage.perSession[i] ?? 0) > 0 || s.before !== 'none');
  let future = sessions.filter((s) => !started.includes(s));
  const r = future.reduce((a, s) => a + s.budget, 0);
  const share = future.length > 0 ? Math.round(r / (future.length + 1)) : 0;
  const tempo = sessionTempo(plan.seed, plan.sessions.length, input.intent, { mix: 'boost', probation: false }, input.intent.hourlyCap,
    Math.max(1, share));
  for (;;) {
    const budgets = apportion(r, [share, ...future.map((s) => s.budget)]);
    const head = budgets[0];
    const startOfRest = Math.round(now + head * tempo.gap.targetMeanMs + BOUNDARY);
    const sub = { ...input, window: { ...plan.window, startsAt: Math.min(startOfRest, plan.window.endsAt) } };
    const rest = future.map((s, i) => ({ ...s, budget: budgets[i + 1] }));
    const starts = placeSessions(plan.seed, sub, rest.map((s) => s.budget * s.tempo.gap.targetMeanMs), availableBlocks(sub.window, input.intent));
    if (starts !== null || future.length === 0) {
      // The re-laid sessions share the waiting kinds by their new budgets (the inserted one included).
      const totals = { ...NO_MIX, ...sumMix(future), lifecycleUnfollow: 0, slack: 0 };
      const mixes = sessionKinds(budgets, budgets, totals, false);
      const inserted: LaidSession = { idx: 0, startAt: now, expectedEndAt: Math.round(now + head * tempo.gap.targetMeanMs), budget: head,
        mix: mixes[0], tempo, before: 'none' };
      const placed = rest.map((s, i) => ({ ...s, mix: mixes[i + 1], startAt: (starts as number[])[i],
        expectedEndAt: Math.round((starts as number[])[i] + s.budget * s.tempo.gap.targetMeanMs) }));
      return [...started, inserted, ...placed];
    }
    // Two smallest adjacent future sessions merge until the rest fits after the inserted one.
    let pair = 0;
    for (let i = 1; i < future.length - 1; i += 1) if (future[i].budget + future[i + 1].budget < future[pair].budget + future[pair + 1].budget) pair = i;
    future = future.length === 1 ? [] : [...future.slice(0, pair), { ...future[pair], budget: future[pair].budget + future[pair + 1].budget },
      ...future.slice(pair + 2)];
  }
}

/**
 * Apply an active Boost to a plan-day (spec §8.3): every cause ends here. Sessions starting inside the
 * window, the open one and an act-now session get the Boost mix (no unfollows; follows up to P0),
 * the lift fills what H and the gap let each place, and Σ budgets of the remainder = R + lift.
 */
export function applyBoost(prev: DayPlan, input: DrawInput, now: number, usage: PlanUsage): DayPlan {
  const span = boostSpan(input.boost, prev.window);
  if (span === null || isDayOff(prev.window, input.intent.daysOff)) return prev;
  const open = openSessionAt(prev, now, usage);
  let sessions: LaidSession[] = prev.sessions.map(({ reads: _reads, ...s }) => s);
  const nowInWindow = now >= span.t0 && now < span.t1;
  const lifted = Math.max(0, prev.ceilings.automaticMax - prev.volume.drawn);
  const waiting = prev.sessions.reduce((a, s, i) => a + (s.startAt > now && (usage.perSession[i] ?? 0) === 0 ? s.budget : 0), 0);
  if (input.runIntent === 'running' && nowInWindow && open < 0 && waiting + lifted > 0 && insertableAt(input, prev.window, now)) {
    sessions = insertNow(prev, sessions, input, now, usage);
  }
  const openAt = (s: LaidSession): boolean => s.startAt <= now && (s.expectedEndAt > now || (open >= 0 && prev.sessions[open]?.startAt === s.startAt));
  const boosted = sessions.map((s) => s.before === 'none' && (s.budget > 0 || s.startAt === now)
    && ((s.startAt >= span.t0 && s.startAt < span.t1) || (nowInWindow && openAt(s))));
  const done = (s: LaidSession, i: number): boolean => {
    const j = prev.sessions.findIndex((p) => p.startAt === s.startAt);
    return j >= 0 && s.startAt <= now && sessionStatus(prev, j, now, usage).ended && !boosted[i];
  };
  const p0 = input.intent.operatingRate;
  let followsLeft = Math.max(0, p0 - usage.follow - sessions.reduce((a, s, i) => a + (boosted[i] || done(s, i) ? 0 : s.mix.follow), 0));
  // The lift: up to the day's largest automatic volume, placed only where H and the gap allow.
  let lift = lifted;
  const next = sessions.map((s, i) => {
    if (!boosted[i]) return s;
    const windowEnd = sessions[i + 1]?.startAt ?? prev.window.endsAt;
    const fits = Math.max(0, Math.floor((windowEnd - BOUNDARY - s.startAt) / Math.max(1, s.tempo.gap.targetMeanMs)) - s.budget);
    const accept = Math.min(s.mix.accept, s.budget);
    const base = Math.min(s.budget - accept, followsLeft);
    followsLeft -= base;
    const add = Math.min(lift, fits, followsLeft);
    lift -= add;
    followsLeft -= add;
    const budget = s.budget + add;
    return { ...s, budget, mix: { follow: base + add, unfollow: 0, accept }, tempo: { ...s.tempo, mix: 'boost' as const },
      expectedEndAt: Math.round(s.startAt + budget * s.tempo.gap.targetMeanMs) };
  }).map((s, idx) => ({ ...s, idx }));
  const kinds = kindsOf(next, prev.kinds.lifecycleUnfollow);
  const reads = planReads(input, kinds, next);
  const withReads = next.map((s, i) => boosted[i] ? { ...s, reads: { ...reads.sessions[i], checks: Math.min(1, reads.sessions[i].checks), checkPages: 0 } }
    : { ...s, reads: reads.sessions[i] });
  return {
    ...prev, sessions: withReads, kinds,
    reads: { ...reads.plan, census: prev.reads.census, following: prev.reads.following,
      checks: withReads.reduce((a, s) => a + s.reads.checks, 0), checkPages: withReads.reduce((a, s) => a + s.reads.checkPages, 0) },
    volume: { ...prev.volume, planned: withReads.reduce((a, s) => a + s.budget, 0) },
  };
}

/** Sessions the overlay would change: used by previews to report the act-now effect and the lift. */
export function boostDelta(base: DayPlan, boosted: DayPlan): { readonly extraFollows: number; readonly unfollowsWaiting: number; readonly startsSessionNow: boolean } {
  const startsSessionNow = boosted.sessions.length > base.sessions.length;
  return {
    extraFollows: Math.max(0, boosted.kinds.follow - base.kinds.follow),
    unfollowsWaiting: Math.max(0, base.kinds.unfollow - boosted.kinds.unfollow),
    startsSessionNow,
  };
}

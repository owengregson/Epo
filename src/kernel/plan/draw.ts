/**
 * The day plan's draw and re-plans (ADR 0607, spec §5.4, §5.6): `drawDayPlan` is pure and
 * deterministic; `replanRemainder` splices a re-draw onto the started sessions (never re-apportioning
 * prorated volume, never growing the kept remainder) — and both end with the Boost overlay.
 * Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

import { assemble, type DrawOptions, dayCeilings } from './assemble';
import { applyBoost } from './boost';
import { apportion, fitVolume, type LaidSession, layoutSessions, SESSION_BOUNDARY_MS, sessionKinds } from './layout';
import { planSeed } from './seed';
import { NO_USAGE, type PlanUsage, sessionStatus } from './status';
import { sessionTempo } from './tempo';
import type { DayPlan, DrawInput, ReplanCause } from './types';
import { allocateKinds, drawVolume, isDayOff } from './volume';

export type { DrawOptions } from './assemble';

/** The first kept session that owes probation paces against the probation cap and keeps its window. */
function withProbation(seed: number, input: DrawInput, sessions: readonly LaidSession[], opts: DrawOptions): LaidSession[] {
  let marked = false;
  return sessions.map((s, i) => {
    if (marked || s.budget <= 0) return s;
    if (!(opts.upgradeProbation === true || opts.probationAt?.(s.startAt) === true)) return s;
    marked = true;
    const tempo = sessionTempo(seed, s.idx, input.intent, { mix: s.tempo.mix, probation: true }, input.intent.hourlyCap, s.budget);
    const room = (sessions[i + 1]?.startAt ?? input.window.endsAt) - SESSION_BOUNDARY_MS - s.startAt;
    const budget = Math.max(1, Math.min(s.budget, Math.floor(room / tempo.gap.targetMeanMs)));
    const mix = sessionKinds([budget], [1], { ...s.mix, lifecycleUnfollow: 0, slack: 0 }, false)[0];
    return { ...s, tempo, budget, mix, expectedEndAt: Math.round(s.startAt + budget * tempo.gap.targetMeanMs) };
  });
}

/** The plan-day's ideal plan before the Boost overlay (spec §5.4 steps 1–11). */
export function drawBase(input: DrawInput, opts: DrawOptions = {}): DayPlan {
  const seed = planSeed(input.installEntropy, input.window.key);
  if (isDayOff(input.window, input.intent.daysOff)) {
    return assemble(input, seed, opts, { lognormal: 0, band: 0, rest: false, drawn: 0, planned: 0, binding: 'day-off' }, [], 0);
  }
  const drawn = drawVolume(seed, input.intent);
  const capped = Math.min(drawn.drawn, dayCeilings(input).automaticMax);
  const v = fitVolume(seed, input, capped);
  const kinds = allocateKinds(v, input.intent, input.demand, false);
  const followCap = Math.max(0, input.intent.operatingRate - input.demand.followsDoneToday);
  const binding = v < capped ? 'session-time' : kinds.slack > 0 && kinds.follow === followCap ? 'follow-bound' : drawn.binding;
  const laid = withProbation(seed, input, layoutSessions(seed, input, v, kinds), opts);
  return assemble(input, seed, opts, { ...drawn, drawn: v, binding }, laid, kinds.lifecycleUnfollow);
}

/** Draw a plan-day: the ideal plan, then the Boost overlay (spec §5.4 step 12). Pure. */
export function drawDayPlan(input: DrawInput, opts: DrawOptions = {}): DayPlan {
  return applyBoost(drawBase(input, opts), input, opts.now ?? input.firstOpenAt, NO_USAGE);
}

/** Started sessions stay as they ran; the open one keeps max(used, its new budget). */
function frozenPart(prev: DayPlan, next: DayPlan, now: number, usage: PlanUsage): LaidSession[] {
  const out: LaidSession[] = [];
  prev.sessions.forEach((s, i) => {
    if (s.startAt > now && (usage.perSession[i] ?? 0) === 0) return;
    const st = sessionStatus(prev, i, now, usage);
    const fresh = next.sessions.find((n) => n.startAt <= s.expectedEndAt && n.expectedEndAt >= s.startAt);
    const budget = st.open ? Math.max(st.used, Math.min(s.budget, fresh?.budget ?? s.budget)) : s.budget;
    out.push({ ...s, budget, mix: budget === s.budget ? s.mix : sessionKinds([budget], [1], { ...s.mix, lifecycleUnfollow: 0, slack: 0 }, false)[0] });
  });
  return out;
}

/**
 * Re-plan the remainder for a cause (spec §5.6): clock and repair re-derive the window; settings and
 * demand splice a re-draw onto the started sessions; Boost causes keep times and re-derive mixes.
 * Σ future budgets never exceed the kept remainder; the seed and the proration never change.
 */
export function replanRemainder(prev: DayPlan, input: DrawInput, now: number, usage: PlanUsage, cause: ReplanCause,
  opts: DrawOptions = {}): DayPlan {
  const o: DrawOptions = { ...opts, now, cause };
  const keep = { ...input, firstOpenAt: prev.firstOpenAt };
  const fresh = drawBase(keep, o);
  if (cause === 'clock' || cause === 'repair' || cause === 'day-start' || cause === 'first-open') {
    return { ...applyBoost(fresh, keep, now, usage), revision: prev.revision + 1 };
  }
  const frozen = frozenPart(prev, fresh, now, usage);
  const lastEnd = frozen.reduce((a, s) => Math.max(a, s.expectedEndAt), Number.NEGATIVE_INFINITY);
  const source = cause === 'settings' ? fresh.sessions : prev.sessions;
  const future = source.filter((s) => s.startAt > now && s.startAt >= lastEnd + SESSION_BOUNDARY_MS && s.before === 'none');
  const prevFuture = prev.sessions.filter((s, i) => s.startAt > now && (usage.perSession[i] ?? 0) === 0 && s.before === 'none');
  const usedAuto = Math.max(usage.auto, usage.perSession.slice(0, frozen.length).reduce((a, n) => a + n, 0));
  const openLeft = frozen.reduce((a, s, i) => a + (sessionStatus(prev, i, now, usage).open ? s.budget - (usage.perSession[i] ?? 0) : 0), 0);
  const room = Math.max(0, Math.min(prevFuture.reduce((a, s) => a + s.budget, 0), fresh.volume.drawn - usedAuto - openLeft));
  const want = future.reduce((a, s) => a + s.budget, 0);
  const budgets = want <= room ? future.map((s) => s.budget) : apportion(room, future.map((s) => s.budget));
  const kept = future.map((s, i) => ({ ...s, budget: budgets[i] })).filter((s) => s.budget > 0);
  const remainderKinds = allocateKinds(kept.reduce((a, s) => a + s.budget, 0), input.intent, input.demand, false);
  const mixes = sessionKinds(kept.map((s) => s.budget), kept.map((s) => s.budget), remainderKinds, false);
  const laid = [...frozen, ...kept.map((s, i) => ({ ...s, mix: mixes[i], tempo: { ...s.tempo, mix: 'normal' as const } }))]
    .map((s, idx) => ({ ...s, idx }));
  const seed = prev.seed;
  const base = assemble(keep, seed, o, { ...prev.volume, drawn: Math.min(prev.volume.drawn, fresh.volume.drawn) }, laid,
    remainderKinds.lifecycleUnfollow);
  return { ...applyBoost(base, keep, now, usage), revision: prev.revision + 1 };
}

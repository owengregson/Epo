/**
 * Session layout (ADR 0607, spec §5.4 steps 4–8, 10–11): the session count, budgets by largest
 * remainder over log-normal weights (each kind by the same weights, unfollows capped per session
 * with spill), placement on the λ_eff mass strata with separation, quiet hours as hard walls, merges
 * when infeasible, and proration before the first open. Layering: kernel siblings only.
 */

import { EMPIRICAL } from '../fundamentals';
import { MS_PER_MINUTE } from '../units';
import { inQuietHours, localMinuteOf, massCurve, quantileOf } from './circadian';
import { PLAN_BOUNDS } from './policy';
import { u, z } from './seed';
import { sessionTempo } from './tempo';
import type { DayPlan, DrawInput, KindBudgets, PlanDayWindow, PlanIntent, PlannedSession } from './types';
import { unfollowShare } from './volume';

/** A planned session before its reads are attached. */
export type LaidSession = Omit<PlannedSession, 'reads'>;

/** The span between two sessions that keeps them separate sessions. */
export const SESSION_BOUNDARY_MS = EMPIRICAL.HUMAN_SESSION_BOUNDARY_MS.value;

/** Largest-remainder apportionment of `total` by `weights` (ties to the lower index), every share ≥ `each`. */
export function apportion(total: number, weights: readonly number[], each = 0): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const rest = Math.max(0, total - each * n);
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((w) => (sum > 0 ? (w / sum) * rest : rest / n));
  const out = exact.map((x) => each + Math.floor(x));
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % n, left -= 1) out[order[k].i] += 1;
  return out;
}

/** Apportion under per-session caps: the excess spills to sessions with room, then one past the cap. */
export function apportionCapped(total: number, weights: readonly number[], caps: readonly number[]): number[] {
  const out = apportion(total, weights).map((x, i) => Math.min(x, Math.max(0, caps[i])));
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = weights.map((w, i) => ({ w, i })).sort((a, b) => b.w - a.w || a.i - b.i).map((x) => x.i);
  for (const i of order) {
    const add = Math.min(left, Math.max(0, caps[i] - out[i]));
    out[i] += add;
    left -= add;
  }
  for (let k = 0; left > 0 && order.length > 0; k = (k + 1) % order.length, left -= 1) out[order[k]] += 1;
  return out;
}

/** The session count: a uniform rung of the rhythm window, never more than the volume. */
export function sessionCount(seed: number, intent: PlanIntent, volume: number): number {
  if (volume <= 0) return 0;
  const { min, max } = intent.sessions;
  const n = min + Math.floor(u(seed, 'sessions') * (Math.max(min, max) - min + 1));
  return Math.max(1, Math.min(n, volume));
}

/** Session weights w_s = exp(σ_v · z('budget', s)). */
export function sessionWeights(seed: number, intent: PlanIntent, n: number): number[] {
  return Array.from({ length: n }, (_, s) => Math.exp(Math.max(0, intent.volumeSigma) * z(seed, 'budget', s)));
}

/** The kinds per session: unfollows ≤ ⌊b_s·u_max⌋ (spill), then accepts and follows inside what is left. */
export function sessionKinds(budgets: readonly number[], weights: readonly number[], kinds: DayPlan['kinds'], boost: boolean): KindBudgets[] {
  const share = unfollowShare(boost);
  const unfollow = apportionCapped(kinds.unfollow, weights, budgets.map((b) => Math.floor(b * share)));
  const accept = apportionCapped(kinds.accept, weights, budgets.map((b, i) => b - unfollow[i]));
  const follow = apportionCapped(kinds.follow, weights, budgets.map((b, i) => b - unfollow[i] - accept[i]));
  return budgets.map((_, i) => ({ follow: follow[i], unfollow: unfollow[i], accept: accept[i] }));
}

interface Block { readonly from: number; readonly to: number }

/** The window's spans outside quiet hours, on the plan's grid. */
export function availableBlocks(window: PlanDayWindow, intent: PlanIntent): Block[] {
  const step = PLAN_BOUNDS.GRID_MINUTES * MS_PER_MINUTE;
  const blocks: Block[] = [];
  let from: number | null = null;
  for (let t = window.startsAt; t < window.endsAt; t += step) {
    const free = !inQuietHours(localMinuteOf(t), intent.quietHours);
    if (free && from === null) from = t;
    if (!free && from !== null) {
      blocks.push({ from, to: t });
      from = null;
    }
  }
  if (from !== null) blocks.push({ from, to: window.endsAt });
  return blocks;
}

/** Starts for sessions of the given lengths on the λ_eff strata, or null when they cannot all fit. */
export function placeSessions(seed: number, input: DrawInput, lengths: readonly number[], blocks: readonly Block[]): number[] | null {
  const n = lengths.length;
  if (n === 0) return [];
  if (blocks.length === 0) return null;
  const { window, intent } = input;
  const curve = massCurve(window.startsAt, window.endsAt, intent.shape, input.phaseOffsetHours, intent.quietHours);
  const bi: number[] = [];
  const start = lengths.map((len, s) => {
    const c = quantileOf(curve, (s + u(seed, 'start', s)) / n);
    let b = blocks.findIndex((x) => c >= x.from && c < x.to);
    if (b < 0) b = blocks.findIndex((x) => x.from > c);
    if (b < 0) b = blocks.length - 1;
    bi.push(b);
    return Math.min(Math.max(c - len / 2, blocks[b].from), blocks[b].to - len);
  });
  for (let s = 1; s < n; s += 1) {
    start[s] = Math.max(start[s], start[s - 1] + lengths[s - 1] + SESSION_BOUNDARY_MS);
    while (start[s] + lengths[s] > blocks[bi[s]].to && bi[s] < blocks.length - 1) {
      bi[s] += 1;
      start[s] = Math.max(start[s], blocks[bi[s]].from);
    }
  }
  for (let s = n - 1; s >= 0; s -= 1) {
    const next = s === n - 1 ? Number.POSITIVE_INFINITY : start[s + 1] - SESSION_BOUNDARY_MS - lengths[s];
    start[s] = Math.min(start[s], next, blocks[bi[s]].to - lengths[s]);
    while (start[s] < blocks[bi[s]].from && bi[s] > 0) {
      bi[s] -= 1;
      start[s] = Math.min(start[s], blocks[bi[s]].to - lengths[s]);
    }
  }
  const rounded = start.map(Math.round);
  const fits = rounded.every((t, s) => t >= blocks[bi[s]].from && t + lengths[s] <= blocks[bi[s]].to + 1
    && (s === 0 || t >= rounded[s - 1] + lengths[s - 1] + SESSION_BOUNDARY_MS - 1));
  return fits ? rounded : null;
}

/** Sessions' budgets and tempos for a volume: count, weights, apportionment, a tempo per session. */
function sized(seed: number, input: DrawInput, volume: number, boost: boolean) {
  const n = sessionCount(seed, input.intent, volume);
  const weights = sessionWeights(seed, input.intent, n);
  const budgets = apportion(volume, weights, 1);
  const tempos = budgets.map((b, s) =>
    sessionTempo(seed, s, input.intent, { mix: boost ? 'boost' : 'normal', probation: false }, input.intent.hourlyCap, b));
  // L4 bounds a gap plus pre-action work by the boundary; reserve that span beyond the expected length.
  return { weights, budgets, tempos, lengths: budgets.map((b, s) => b * tempos[s].gap.targetMeanMs + SESSION_BOUNDARY_MS) };
}

/** The largest volume ≤ `volume` whose sessions fit the window's free time (spec §5.4 step 10). */
export function fitVolume(seed: number, input: DrawInput, volume: number): number {
  const free = availableBlocks(input.window, input.intent).reduce((a, b) => a + (b.to - b.from), 0);
  let v = volume;
  for (let guard = 0; v > 0 && guard < volume; guard += 1) {
    const { lengths } = sized(seed, input, v, false);
    const need = lengths.reduce((a, b) => a + b, 0) + (lengths.length - 1) * SESSION_BOUNDARY_MS;
    if (need <= free) return v;
    v = Math.min(v - 1, Math.floor((v * Math.max(0, free - (lengths.length - 1) * SESSION_BOUNDARY_MS)) / need));
  }
  return Math.max(0, v);
}

/**
 * Lay out a plan-day's sessions for `volume` and `kinds`: placement with separation and quiet walls;
 * when they cannot fit, the two smallest adjacent sessions merge and the layout repeats. Sessions
 * whose expected end is at or before the first open are prorated to nothing (`before: 'first-open'`).
 */
export function layoutSessions(seed: number, input: DrawInput, volume: number, kinds: DayPlan['kinds']): LaidSession[] {
  if (volume <= 0) return [];
  const boost = false;
  let { weights, budgets, tempos, lengths } = sized(seed, input, volume, boost);
  const blocks = availableBlocks(input.window, input.intent);
  let starts = placeSessions(seed, input, lengths, blocks);
  while (starts === null && budgets.length > 1) {
    let pair = 0;
    for (let s = 1; s < budgets.length - 1; s += 1) if (budgets[s] + budgets[s + 1] < budgets[pair] + budgets[pair + 1]) pair = s;
    budgets = [...budgets.slice(0, pair), budgets[pair] + budgets[pair + 1], ...budgets.slice(pair + 2)];
    weights = [...weights.slice(0, pair), weights[pair] + weights[pair + 1], ...weights.slice(pair + 2)];
    tempos = budgets.map((b, s) => sessionTempo(seed, s, input.intent, { mix: 'normal', probation: false }, input.intent.hourlyCap, b));
    lengths = budgets.map((b, s) => b * tempos[s].gap.targetMeanMs + SESSION_BOUNDARY_MS);
    starts = placeSessions(seed, input, lengths, blocks);
  }
  if (starts === null) return [];
  const mixes = sessionKinds(budgets, weights, kinds, boost);
  return budgets.map((budget, idx) => {
    const startAt = (starts as number[])[idx];
    const expectedEndAt = Math.round(startAt + budget * tempos[idx].gap.targetMeanMs);
    const prorated = expectedEndAt <= input.firstOpenAt;
    return {
      idx, startAt, expectedEndAt, tempo: tempos[idx],
      budget: prorated ? 0 : budget,
      mix: prorated ? { follow: 0, unfollow: 0, accept: 0 } : mixes[idx],
      before: prorated ? 'first-open' : 'none',
    };
  });
}

/** A late join's effective budget: what still fits before the expected end at the session's target gap. */
export function lateJoinBudget(session: Pick<PlannedSession, 'budget' | 'startAt' | 'expectedEndAt' | 'tempo'>, joinAt: number): number {
  if (joinAt <= session.startAt) return session.budget;
  const fit = Math.floor((session.expectedEndAt - joinAt) / Math.max(1, session.tempo.gap.targetMeanMs));
  return Math.max(0, Math.min(session.budget, fit));
}

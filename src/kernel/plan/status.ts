/**
 * Session status from the plan, the clock and the ledger (spec §5.5): one late-join rule. An unjoined
 * session is open until its expected end and a late join never unlocks more than still fits; a joined
 * one is open until it spends its effective budget or closes; missed sessions expire.
 * Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

import { EMPIRICAL } from '../fundamentals';
import type { DayPlan, PlannedSession } from './types';

export type PlanSessionState = 'done' | 'partial' | 'skipped' | 'before-open' | 'now' | 'next' | 'later';

/** The ledger slice the plan reads: automatic mutations and follows today, and per session. */
export interface PlanUsage {
  readonly auto: number;
  readonly follow: number;
  /** Mutations (every writer) inside each session's window, by session position. */
  readonly perSession: readonly number[];
  /** The first mutation inside each session's window, when there is one. */
  readonly joinedAt?: readonly (number | null)[];
}

export const NO_USAGE: PlanUsage = { auto: 0, follow: 0, perSession: [] };

const BOUNDARY = EMPIRICAL.HUMAN_SESSION_BOUNDARY_MS.value;

/** Where session `i`'s window ends: the next session's start, else the plan-day's end. */
export function windowEndOf(plan: Pick<DayPlan, 'sessions' | 'window'>, i: number): number {
  return plan.sessions[i + 1]?.startAt ?? plan.window.endsAt;
}

const lengthOf = (s: PlannedSession): number => s.expectedEndAt - s.startAt;

/** A joined session closes one boundary before the next window, or one expected length past its end. */
export function closesAtOf(plan: Pick<DayPlan, 'sessions' | 'window'>, i: number): number {
  const s = plan.sessions[i];
  return Math.min(windowEndOf(plan, i) - BOUNDARY, s.expectedEndAt + lengthOf(s));
}

/** What still fits from `at` to the expected end at the session's mean gap. */
function fitFrom(s: PlannedSession, at: number): number {
  return Math.max(0, Math.floor((s.expectedEndAt - at) / Math.max(1, s.tempo.gap.targetMeanMs)));
}

export interface SessionStatus {
  readonly state: PlanSessionState;
  /** b'_s: the budget a late join can still spend. */
  readonly budget: number;
  readonly used: number;
  readonly open: boolean;
  /** True once nothing more can run in it (spent, closed, missed or prorated). */
  readonly ended: boolean;
  readonly closesAt: number | null;
}

/** Session `i`'s status at `now` (the caller names the first later session `next`). */
export function sessionStatus(plan: Pick<DayPlan, 'sessions' | 'window'>, i: number, now: number, usage: PlanUsage): SessionStatus {
  const s = plan.sessions[i];
  const used = usage.perSession[i] ?? 0;
  if (s.before === 'first-open') return { state: 'before-open', budget: 0, used, open: false, ended: true, closesAt: null };
  if (now < s.startAt && used === 0) return { state: 'later', budget: s.budget, used, open: false, ended: false, closesAt: null };
  if (used === 0) {
    const fit = Math.min(s.budget, fitFrom(s, now));
    const open = now < s.expectedEndAt && fit > 0;
    return { state: open ? 'now' : 'skipped', budget: open ? fit : 0, used, open, ended: !open, closesAt: open ? s.expectedEndAt : null };
  }
  const joinedAt = usage.joinedAt?.[i] ?? s.startAt;
  const budget = Math.max(used, joinedAt <= s.startAt ? s.budget : Math.min(s.budget, fitFrom(s, joinedAt)));
  const closesAt = closesAtOf(plan, i);
  const open = used < budget && now < closesAt;
  const state: PlanSessionState = open ? 'now' : used >= budget ? 'done' : 'partial';
  return { state, budget, used, open, ended: !open, closesAt };
}

/** R: the kept remainder — what the kept sessions not yet ended may still spend (prorated, skipped: 0). */
export function keptRemainder(plan: Pick<DayPlan, 'sessions' | 'window'>, now: number, usage: PlanUsage): number {
  let r = 0;
  for (let i = 0; i < plan.sessions.length; i += 1) {
    const st = sessionStatus(plan, i, now, usage);
    if (!st.ended) r += Math.max(0, st.budget - st.used);
  }
  return r;
}

/** The open session's position, or -1. */
export function openSessionAt(plan: Pick<DayPlan, 'sessions' | 'window'>, now: number, usage: PlanUsage): number {
  for (let i = 0; i < plan.sessions.length; i += 1) if (sessionStatus(plan, i, now, usage).open) return i;
  return -1;
}

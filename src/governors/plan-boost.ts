/**
 * The Boost as the renderer sees it (ADR 0904, spec §8.5): `EpoStatus.boost` — off, on, waiting (the
 * window is open but no session can use it yet: quiet hours, a day off, nothing left today) or paused
 * (the window is open and run intent is stopped). One definition of the fact; the plan strip reads it.
 */

import type { BoostWindow } from '../kernel/plan/types';
import type { BoostView } from '../shared/boost';
import type { PlanView } from './plan-types';

export interface BoostFacts {
  /** The persisted window, ended or not (its end is `lastEnded`). */
  readonly record: BoostWindow | null;
  /** Follows since the window opened, from the ledger tally; null when unknown. */
  readonly followsDuring: number | null;
}

/** When the Boost mix first runs: now inside a Boost session, else the first Boost session still ahead. */
function effectiveFrom(view: PlanView, now: number): number | null {
  if (view.open !== null && view.open.mix === 'boost') return now;
  const next = view.plan.sessions.find((s, i) => s.tempo.mix === 'boost' && s.budget > 0 && view.sessions[i]?.state !== 'skipped'
    && s.expectedEndAt > now);
  return next === undefined ? null : Math.max(now, next.startAt);
}

export function projectBoost(view: PlanView, now: number, runIntent: 'running' | 'stopped' | 'paused', facts: BoostFacts): BoostView {
  const r = facts.record;
  const lastEnded = r !== null && r.endedAt !== null && r.endReason !== null ? { at: r.endedAt, reason: r.endReason } : null;
  const active = r !== null && r.endedAt === null && now >= r.startedAt && now < r.endsAt;
  if (!active || r === null) {
    return { state: 'off', startedAt: null, endsAt: null, effectiveFrom: null, followsDuring: null, lastEnded };
  }
  const from = effectiveFrom(view, now);
  const state: BoostView['state'] = runIntent !== 'running' ? 'paused' : from === null || from > now ? 'waiting' : 'on';
  return { state, startedAt: r.startedAt, endsAt: r.endsAt, effectiveFrom: from, followsDuring: facts.followsDuring, lastEnded };
}

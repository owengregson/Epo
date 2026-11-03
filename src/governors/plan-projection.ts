/**
 * The plan as the renderer sees it (ADR 0607, spec §5.17): `EpoStatus.plan` from the pure view —
 * the day, totals and kinds as planned/done, the session strip, and "Today's plan in detail" with
 * the values the plan really uses. `dayOff` comes only from the user's own days off.
 */

import { PLAN_BOUNDS } from '../kernel/plan/policy';
import { type PlanProjection, paceLabel } from '../shared/plan-projection';
import type { PlanView } from './plan-types';

/** Reads already spent today, from the read budget (the view holds none of its own). */
export interface ReadsDone {
  readonly profiles: number;
  readonly pages: number;
  readonly checks: number;
}

export function projectPlan(view: PlanView, readsDone: ReadsDone): PlanProjection {
  const { plan, used, open } = view;
  const r = plan.reads;
  return {
    day: {
      key: plan.window.key, startsAt: plan.window.startsAt, endsAt: plan.window.endsAt, quietMinute: plan.window.quietMinute,
      light: plan.volume.rest, lateStart: plan.sessions.some((s) => s.before === 'first-open'),
      binding: plan.volume.binding, dayOff: plan.volume.binding === 'day-off',
    },
    revision: plan.revision,
    cause: plan.cause,
    totals: {
      planned: plan.volume.planned, done: used.auto, remaining: view.remaining,
      automaticMax: plan.ceilings.automaticMax, ceiling: plan.ceilings.day, outside: used.outside,
    },
    kinds: {
      follow: { planned: plan.kinds.follow, done: used.follow },
      unfollow: { planned: plan.kinds.unfollow, done: used.unfollow },
      accept: { planned: plan.kinds.accept, done: used.accept },
    },
    reads: {
      profiles: { planned: r.explore + r.reconcile + r.catchUp.profiles, done: readsDone.profiles },
      pages: { planned: r.explorePages + r.census + r.following + r.checkPages + r.catchUp.pages, done: readsDone.pages },
      checks: { planned: r.checks + r.catchUp.notifications, done: readsDone.checks },
    },
    sessions: plan.sessions.map((s, i) => ({
      idx: s.idx, startAt: s.startAt, endAt: s.expectedEndAt, planned: s.budget, done: view.sessions[i]?.used ?? 0,
      state: view.sessions[i]?.state ?? 'later', mix: s.tempo.mix,
      probation: s.tempo.probation || (open?.idx === i && open.probation),
      censusHost: open?.idx === i && open.censusHost, pace: paceLabel(s.tempo.pace, PLAN_BOUNDS.PACE_WORDS),
    })),
    now: { sessionIdx: open?.idx ?? null, nextAt: view.nextSessionAt, closesAt: open === null ? null : view.sessions[open.idx]?.closesAt ?? null },
    detail: {
      caps: {
        automaticMax: plan.ceilings.automaticMax, day: plan.ceilings.day, hour: plan.ceilings.hour,
        unfollowHour: plan.ceilings.unfollowHour, probationHour: plan.ceilings.probationHour, acceptsPerPass: plan.ceilings.acceptsPerPass,
      },
      sessions: plan.sessions.map((s) => ({
        idx: s.idx, pace: s.tempo.pace, motion: s.tempo.motion, depth: s.tempo.depth,
        gap: { targetMeanMs: s.tempo.gap.targetMeanMs, medianMs: s.tempo.gap.medianMs, floorMs: s.tempo.gap.floorMs,
          capMs: s.tempo.gap.capMs, timeScale: s.tempo.gap.timeScale },
        kinds: { ...s.mix },
        reads: { profiles: s.reads.explore + s.reads.reconcile, pages: s.reads.explorePages + s.reads.checkPages, checks: s.reads.checks },
      })),
    },
  };
}

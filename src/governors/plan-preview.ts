/**
 * Pure previews over the plan (ADR 0607 / 0904, spec §6.5, §8.5): plan-days drawn for an intent (the
 * `PlanPreviewPort` the settings stage reads) and the Boost preview — `applyBoost` on a copy, honest
 * about what it shifts (Q5: the remainder's unfollows, the lift, the act-now session). Nothing writes.
 */

import { boostDelta } from '../kernel/plan/boost';
import { inQuietHours, localMinuteOf, planDayWindow, quietMinute } from '../kernel/plan/circadian';
import { drawBase } from '../kernel/plan/draw';
import { openSessionAt } from '../kernel/plan/status';
import type { DayPlan, PlanDayWindow, PlanDemand, PlanIntent, PlanPreviewDay } from '../kernel/plan/types';
import { unfollowShare } from '../kernel/plan/volume';
import { SETTINGS_POLICY } from '../kernel/settings-policy';
import { MS_PER_HOUR } from '../kernel/units';
import type { BoostPreview } from '../shared/boost';

export interface PreviewContext {
  readonly installEntropy: number;
  readonly phaseOffsetHours: number;
  demand(window: PlanDayWindow, now: number): PlanDemand;
}

/** `days` consecutive plan-days for `intent` from the one holding `at`, whole days, no Boost. */
export function previewDays(ctx: PreviewContext, intent: PlanIntent, at: number, days: number): PlanPreviewDay[] {
  const qm = quietMinute(intent.shape, ctx.phaseOffsetHours, intent.quietHours);
  const out: PlanPreviewDay[] = [];
  let w = planDayWindow(at, qm);
  for (let d = 0; d < days; d += 1) {
    const p = drawBase({ installEntropy: ctx.installEntropy, window: w, intent, demand: ctx.demand(w, at),
      phaseOffsetHours: ctx.phaseOffsetHours, firstOpenAt: w.startsAt, boost: null, runIntent: 'running' }, { now: w.startsAt });
    out.push({
      dayKey: w.key, startAt: w.startsAt, endAt: w.endsAt, restDay: p.volume.rest, dayOff: p.volume.binding === 'day-off',
      total: p.volume.planned, follows: p.kinds.follow, unfollows: p.kinds.unfollow, accepts: p.kinds.accept,
      sessions: p.sessions.filter((s) => s.budget > 0).map((s) => ({ startAt: s.startAt, endAt: s.expectedEndAt, budget: s.budget })),
    });
    w = planDayWindow(w.endsAt, qm);
  }
  return out;
}

/** Hours inside the Boost bounds (the sidebar always sends the saved length). */
export function clampBoostHours(hours: number): number {
  const b = SETTINGS_POLICY.BOOST;
  return Number.isFinite(hours) ? Math.min(b.MAX_HOURS, Math.max(b.MIN_HOURS, hours)) : b.DEFAULT_HOURS;
}

/** True while earlier Boosts' unfollows would not clear within the backlog bound at u_max. */
export function backlogBlocks(plan: DayPlan, demand: PlanDemand): boolean {
  const room = Math.floor(plan.ceilings.automaticMax * unfollowShare(false));
  return demand.lifecycleBacklog > SETTINGS_POLICY.BOOST.MAX_BACKLOG_DAYS * room;
}

export interface BoostPreviewInputs {
  readonly now: number;
  readonly hours: number;
  /** The plan without a Boost (normal mixes) and with the proposed window, both drawn at `now`. */
  readonly base: DayPlan;
  readonly boosted: DayPlan;
  readonly usage: { readonly auto: number; readonly follow: number; readonly perSession: readonly number[] };
  readonly intent: PlanIntent;
  readonly running: boolean;
  /** Automatic work still left today without a Boost (spec §5.7 `remaining`). */
  readonly remaining: number;
}

/** The Boost preview (spec §8.5): what changes, from when, and why not when it would change nothing. */
export function boostPreview(i: BoostPreviewInputs): BoostPreview {
  const hours = clampBoostHours(i.hours);
  const endsAt = i.now + hours * MS_PER_HOUR;
  const delta = boostDelta(i.base, i.boosted);
  const open = openSessionAt(i.base, i.now, i.usage) >= 0;
  const firstBoosted = i.boosted.sessions.find((s) => s.tempo.mix === 'boost' && s.expectedEndAt > i.now)?.startAt ?? i.now;
  const effectiveFrom = open || delta.startsSessionNow ? i.now : Math.max(i.now, firstBoosted);
  const lift = Math.max(0, i.base.ceilings.automaticMax - i.base.volume.drawn);
  const quiet = inQuietHours(localMinuteOf(i.now), i.intent.quietHours);
  const why: BoostPreview['why'] = i.base.volume.binding === 'day-off' ? 'day-off'
    : backlogBlocks(i.base, i.base.demand) ? 'backlog'
    : quiet ? 'quiet-hours'
    : !i.running ? 'engine-stopped'
    : delta.unfollowsWaiting === 0 && lift === 0 && !delta.startsSessionNow && open ? 'nothing-to-shift'
    : i.remaining <= 0 && lift === 0 ? 'limit-reached-today'
    : 'ready';
  return {
    hours, endsAt, effectiveFrom, startsSessionNow: delta.startsSessionNow,
    extraFollowsToday: delta.extraFollows, unfollowsWaiting: delta.unfollowsWaiting, why,
  };
}

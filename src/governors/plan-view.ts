/**
 * The plan at an instant (ADR 0607, spec §5.5, §5.7, §5.8.3): a PURE function of the persisted plan,
 * the ledger tally, the clock and Boost. Session states with the one late-join rule, R and the
 * remaining automatic work, admission with typed refusals and exact `until`s, the check and census
 * predicates. Nothing here writes; the plan service is the only writer of the plan.
 */

import { CENSUS_POLICY } from '../kernel/census-policy';
import { inQuietHours, localMinuteOf } from '../kernel/plan/circadian';
import { velocityWakeAt } from '../kernel/plan/gap';
import { probationOwed } from '../kernel/plan/probation';
import { censusWalkMax, checkSpacingMs } from '../kernel/plan/reads';
import { u } from '../kernel/plan/seed';
import { keptRemainder, sessionStatus } from '../kernel/plan/status';
import type { BoostWindow, DayPlan, KindBudgets, MutationKind, PlanIntent, SessionTempo, Writer } from '../kernel/plan/types';
import type { Admission, AdmitRefusal, PlanView, SessionState, UsageTally } from './plan-types';

export interface PlanViewInputs {
  readonly now: number;
  readonly used: UsageTally;
  readonly boost: BoostWindow | null;
  readonly runIntent: 'running' | 'stopped' | 'paused';
  readonly hourly: { readonly lastHour: number; readonly recentTimes: readonly number[] };
  readonly deadline: number | null;
  /** The next plan-day's plan (a pure draw of the next key; the service caches it). */
  tomorrow(): DayPlan | null;
  readonly journal: { blocks(pk: string, exceptIntentId?: string): boolean };
  lastMutationBefore(t: number): number | null;
  readonly unconfirmed: { readonly kind: 'follow' | 'unfollow'; readonly streak: number } | null;
  surfacePaused(a: 'unfollows' | 'exploration'): boolean;
  /** The live intent's masks and census rules (quiet hours, cleanup, patience, check spacing). */
  readonly intent: PlanIntent;
  /** The ambient tempo (no open session) and a session's probation tempo, from the service. */
  readonly ambient: SessionTempo;
  probationTempo(idx: number): SessionTempo;
  /** The plan-day window holding `t` (the plan-backed clock). */
  windowOf(t: number): { readonly startsAt: number; readonly endsAt: number };
  readonly provisional: boolean;
  readonly upgradeProbation: boolean;
  /** The first mutation inside each session's window (the late-join rule), when the service knows it. */
  readonly joinedAt?: readonly (number | null)[];
}

const AUTOMATIC: readonly Writer[] = ['growth', 'woven', 'cleanup-run', 'accept-pass'];
const refuse = (reason: AdmitRefusal, until: number | null): Admission => ({ ok: false, reason, until });
const OK: Admission = { ok: true };
const ZERO_KINDS: KindBudgets = { follow: 0, unfollow: 0, accept: 0 };

/** True while a Boost window that has not ended covers `t`. */
export function boostActiveAt(boost: BoostWindow | null, t: number): boolean {
  return boost !== null && boost.endedAt === null && t >= boost.startedAt && t < boost.endsAt;
}

/** The plan at `inputs.now`: pure, read-only. */
export function viewPlan(plan: DayPlan, inputs: PlanViewInputs): PlanView {
  const { now, used, intent } = inputs;
  const usage = { auto: used.auto, follow: used.follow, perSession: used.perSession, joinedAt: inputs.joinedAt };
  const statuses = plan.sessions.map((_, i) => sessionStatus(plan, i, now, usage, intent.quietHours));
  const firstLater = statuses.findIndex((s) => s.state === 'later');
  const sessions = statuses.map((s, idx) => ({
    idx, state: (idx === firstLater ? 'next' : s.state) as SessionState, used: s.used, budget: s.budget, closesAt: s.closesAt,
  }));
  const openIdx = statuses.findIndex((s) => s.open);
  const openPlanned = openIdx >= 0 ? plan.sessions[openIdx] : null;
  const firstKept = plan.sessions.findIndex((s) => s.budget > 0);
  const probation = openPlanned !== null && (openPlanned.tempo.probation || (inputs.upgradeProbation && openIdx === firstKept)
    || probationOwed(inputs.lastMutationBefore(openPlanned.startAt), openPlanned.startAt, inputs.windowOf));
  const boostOn = boostActiveAt(inputs.boost, now);
  const mixOf = openPlanned?.tempo.mix ?? (boostOn ? 'boost' : 'normal');
  const share = (kind: keyof KindBudgets): number => {
    if (openPlanned === null || openPlanned.budget <= 0) return 0;
    const st = statuses[openIdx];
    const spent = used.perSessionKinds?.[openIdx]?.[kind] ?? st.used;
    return Math.max(0, Math.min(st.budget - st.used, Math.round((openPlanned.mix[kind] * st.budget) / openPlanned.budget) - spent));
  };
  const mixLeft: KindBudgets = openPlanned === null ? ZERO_KINDS : { follow: share('follow'), unfollow: share('unfollow'), accept: share('accept') };
  const tempo = openPlanned === null ? inputs.ambient : probation && !openPlanned.tempo.probation ? inputs.probationTempo(openIdx) : openPlanned.tempo;
  const tomorrowFirst = (): number | null => inputs.tomorrow()?.sessions.find((s) => s.budget > 0)?.startAt ?? null;
  const nextSessionAt = firstLater >= 0 ? plan.sessions[firstLater].startAt : tomorrowFirst();
  const dayVolume = Math.min(plan.ceilings.automaticMax, plan.volume.planned);
  const R = keptRemainder(plan, now, usage, intent.quietHours);
  const remaining = Math.max(0, Math.min(R, dayVolume - used.auto, plan.ceilings.day - used.all - used.outside));
  const hourCap = probation ? plan.ceilings.probationHour : plan.ceilings.hour;
  const nextOrEdge = nextSessionAt ?? plan.window.endsAt;
  const censusEligible = openPlanned !== null && mixOf === 'normal' && !probation;

  const manualOpen = (): Admission => {
    if (used.all + used.outside >= plan.ceilings.day) return refuse('ceiling', plan.window.endsAt);
    if (inputs.hourly.lastHour >= plan.ceilings.hour) return refuse('hourly-cap', velocityWakeAt(inputs.hourly.recentTimes, plan.ceilings.hour, now));
    return OK;
  };

  const kindSpent = (kind: MutationKind): boolean => {
    if (kind === 'follow') return used.follow >= plan.ceilings.followDay;
    if (kind === 'unfollow') return used.unfollow >= plan.kinds.unfollow;
    return used.accept >= plan.kinds.accept + plan.kinds.slack + Math.max(0, plan.kinds.follow - used.follow);
  };

  const admits = (kind: MutationKind, writer: Writer, subject?: { pk: string; intentId?: string }, ownedDeadline?: number): Admission => {
    if (subject !== undefined && inputs.journal.blocks(subject.pk, subject.intentId)) return refuse('journal', null);
    if (kind !== 'accept' && inputs.unconfirmed !== null && inputs.unconfirmed.kind === kind) return refuse('unconfirmed', null);
    if (!AUTOMATIC.includes(writer)) return manualOpen();
    if (plan.volume.binding === 'day-off') return refuse('day-off', plan.window.endsAt);
    if (inQuietHours(localMinuteOf(now), intent.quietHours)) return refuse('quiet-hours', nextOrEdge);
    const manual = manualOpen();
    if (!manual.ok) return manual;
    if (probation && inputs.hourly.lastHour >= hourCap) {
      return refuse('probation', velocityWakeAt(inputs.hourly.recentTimes, hourCap, now));
    }
    const passOwnsGap = kind === 'accept' && writer === 'accept-pass' && inputs.deadline === ownedDeadline;
    if (inputs.deadline !== null && inputs.deadline > now && !passOwnsGap) return refuse('deadline', inputs.deadline);
    if (used.auto >= dayVolume || (remaining <= 0 && firstLater < 0)) return refuse('day-done', tomorrowFirst() ?? plan.window.endsAt);
    if (kind === 'unfollow' && (boostOn || mixOf === 'boost')) return refuse('deferred-by-boost', inputs.boost?.endsAt ?? null);
    if (openPlanned === null) return refuse('session-closed', nextOrEdge);
    if (kindSpent(kind)) return refuse('kind-spent', plan.window.endsAt);
    if (kind === 'unfollow' && mixLeft.unfollow <= 0) return refuse('kind-spent', nextOrEdge);
    return OK;
  };

  const spacing = openPlanned === null ? 0 : checkSpacingMs(tempo, intent);
  return {
    plan, provisional: inputs.provisional, at: now, window: plan.window, sessions,
    open: openPlanned === null ? null : {
      idx: openIdx, mixLeft, readsLeft: openPlanned.reads, mix: mixOf, probation,
      censusHost: censusEligible,
    },
    nextSessionAt,
    nextCheckAt: openPlanned === null ? nextSessionAt : null,
    used, remaining, R,
    boost: inputs.boost !== null && inputs.boost.endedAt === null ? inputs.boost : null,
    freshSince: plan.window.startsAt,
    tempo,
    admits,
    admitsAcceptDuringPass: (ownedDeadline) => admits('accept', 'accept-pass', undefined, ownedDeadline),
    manualOpen,
    checkDue: (lastSweepEndedAt) => openPlanned !== null && (lastSweepEndedAt === null || lastSweepEndedAt < openPlanned.startAt
      || (mixOf === 'normal' && now - lastSweepEndedAt >= spacing)),
    checkLight: () => mixOf === 'boost',
    censusDue: (census) => {
      if (!censusEligible || intent.cleanupShare <= 0 || census.walkPages > CENSUS_POLICY.maxWalkPages) return false;
      const stale = census.lastCompleteAt === null || now - census.lastCompleteAt >= intent.patienceWaitMs
        || plan.demand.pruneStock < plan.kinds.unfollow - plan.kinds.lifecycleUnfollow;
      const st = statuses[openIdx];
      return stale && census.walkPages <= censusWalkMax({ remainingMs: (st.closesAt ?? now) - now, tempo });
    },
    acceptsAllowed: (pending, lastHour) => openPlanned === null ? 0 : Math.max(0, Math.min(pending,
      mixLeft.accept + plan.kinds.slack + mixLeft.follow, plan.ceilings.acceptsPerPass, plan.ceilings.hour - lastHour - 1)),
    mixDraw: (k) => openPlanned !== null && mixLeft.follow > 0 && mixLeft.unfollow > 0 ? u(plan.seed, 'mix', openIdx, k) : null,
    planDayStartAfter: (k) => {
      let w = { startsAt: plan.window.startsAt, endsAt: plan.window.endsAt };
      for (let i = 0; i < k; i += 1) w = inputs.windowOf(w.endsAt);
      return w.startsAt;
    },
  };
}

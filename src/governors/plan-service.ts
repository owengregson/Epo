/**
 * The plan service (ADR 0607, spec §5.1, §5.6, §8.2): the ONLY writer of `meta.plan_state`. `view`
 * is pure — it computes the plan a write would hold and marks it provisional; `ensure` writes only
 * on a §5.6 cause (a new window, the clock, settings, a repair, a Boost edge), in one `setPlanState`.
 */

import { planDayWindow, quietMinute, transitionDay } from '../kernel/plan/circadian';
import { intentDigest } from '../kernel/plan/digest';
import { type DrawOptions, drawBase, drawDayPlan, replanRemainder } from '../kernel/plan/draw';
import { typicalSessionBudget } from '../kernel/plan/gap';
import { probationOwed } from '../kernel/plan/probation';
import type { PlanReadFacts } from '../kernel/plan/reads';
import { windowEndOf } from '../kernel/plan/status';
import { ambientTempo, sessionTempo } from '../kernel/plan/tempo';
import type {
  BoostWindow, DayPlan, DrawInput, PlanDayClock, PlanDayWindow, PlanIntent, PlanPreviewDay, ReplanCause,
} from '../kernel/plan/types';
import type { TempoSource } from '../kernel/tempo';
import { CLOCK_TOLERANCE_MS } from '../kernel/tempo-policy';
import { MS_PER_HOUR } from '../kernel/units';
import type { BoostPreview } from '../shared/boost';
import { planTempoSource } from '../timing/tempo-source';
import { planBackedDayClock } from './plan-day-clock';
import { boostPreview, clampBoostHours, previewDays } from './plan-preview';
import {
  initialPlanState,
  migratedPhase,
  type PlanStateV1,
  parsePlanState,
  repairPlanState,
  serializePlanState,
} from './plan-state';
import type { PlanServiceDeps, PlanView, UsageTally } from './plan-types';
import { viewPlan } from './plan-view';

export interface PlanServiceOptions {
  /** Surface facts the reads need (the following list's composed pages). */
  readonly readFacts?: PlanReadFacts;
  readonly log?: { warn(message: string, context?: Record<string, unknown>): void };
}

/** One pure step: the state a write would hold at `now`, and why. */
export interface PlanStep {
  readonly state: PlanStateV1;
  readonly plan: DayPlan;
  readonly cause: ReplanCause | null;
  /** True when the persisted value differs from `state` (a cause, a Boost edge, a cleared flag). */
  readonly dirty: boolean;
  readonly intent: PlanIntent;
}

/** The Boost clock rules: a backward clock ends it, an over-long window is clamped, a past one expires. */
export function clockBoost(boost: BoostWindow | null, now: number): BoostWindow | null {
  if (boost === null || boost.endedAt !== null) return boost;
  if (now < boost.startedAt - CLOCK_TOLERANCE_MS) return { ...boost, endedAt: now, endReason: 'clock' };
  const endsAt = Math.min(boost.endsAt, boost.startedAt + boost.durationMs);
  if (now >= endsAt) return { ...boost, endsAt, endedAt: endsAt, endReason: 'expired' };
  return endsAt === boost.endsAt ? boost : { ...boost, endsAt };
}

export class PlanService {
  private readonly tomorrowCache = new Map<string, DayPlan>();

  constructor(private readonly deps: PlanServiceDeps, private readonly opts: PlanServiceOptions = {}) {}

  private at(now?: number): number {
    return now ?? this.deps.clock.now();
  }

  /** The persisted state, repaired or initialized in memory (a pure read). */
  private current(): { state: PlanStateV1; problem: string | null; fresh: boolean } {
    const raw = this.deps.store.getPlanState();
    const parsed = parsePlanState(raw);
    if (parsed.state !== null) return { state: parsed.state, problem: null, fresh: false };
    if (raw === null) {
      const phase = migratedPhase(this.deps.store.getPacingState(), this.deps.installEntropy);
      return { state: initialPlanState(phase.phase, this.deps.store.hasAnyMutation()), problem: phase.problem, fresh: true };
    }
    return { state: repairPlanState(parsed, this.deps.installEntropy), problem: parsed.problem, fresh: false };
  }

  /** The plan-day holding `t`: the plan's own window, a transition day after a boundary change, then the new days. */
  private qmMemo = { key: '', qm: 0 };

  /** The quiet minute for the intent's shape at the install's phase (memoized: a 1440-minute scan). */
  private quietMinuteOf(state: PlanStateV1, intent: PlanIntent): number {
    const key = `${intentDigest(intent)}|${state.phaseOffsetHours}`;
    if (this.qmMemo.key !== key) this.qmMemo = { key, qm: quietMinute(intent.shape, state.phaseOffsetHours, intent.quietHours) };
    return this.qmMemo.qm;
  }

  windowAt(t: number, state: PlanStateV1, intent: PlanIntent): PlanDayWindow {
    const qm = this.quietMinuteOf(state, intent);
    const w = state.plan?.window;
    if (w === undefined) return planDayWindow(t, qm);
    if (t >= w.startsAt && t < w.endsAt) return w;
    if (t >= w.endsAt && w.quietMinute !== qm) {
      const tr = transitionDay(w.endsAt, qm);
      if (t < tr.endsAt) return { key: tr.key, startsAt: tr.startsAt, endsAt: tr.endsAt, quietMinute: tr.quietMinute };
    }
    return planDayWindow(t, qm);
  }

  private input(state: PlanStateV1, window: PlanDayWindow, intent: PlanIntent, now: number, firstOpenAt: number,
    boost: BoostWindow | null): DrawInput {
    return {
      installEntropy: this.deps.installEntropy, window, intent, demand: this.deps.demand(window, now),
      phaseOffsetHours: state.phaseOffsetHours, firstOpenAt, boost, runIntent: this.deps.runIntent(),
    };
  }

  private drawOptions(state: PlanStateV1, intent: PlanIntent, now: number, cause: ReplanCause): DrawOptions {
    return {
      now, cause, readFacts: this.opts.readFacts, upgradeProbation: state.upgradeProbation,
      probationAt: (start) => probationOwed(this.deps.lastMutationBefore(start), start, (t) => this.windowAt(t, state, intent)),
    };
  }

  /** The ledger slice of a plan at `now`: today's tally, mutations per session window, outside actions. */
  usage(plan: DayPlan, now: number): UsageTally & { readonly joinedAt: readonly (number | null)[] } {
    const tally = this.deps.store.tallySince(plan.window.startsAt);
    const times = this.deps.store.recentMutationTimes(plan.window.startsAt).filter((t) => t < plan.window.endsAt && t <= now);
    const inside = plan.sessions.map((s, i) => times.filter((t) => t >= s.startAt && t < windowEndOf(plan, i)));
    return {
      ...tally, perSession: inside.map((ts) => ts.length), joinedAt: inside.map((ts) => (ts.length > 0 ? Math.min(...ts) : null)),
      outside: this.deps.outsideSince(plan.window.startsAt),
    };
  }

  /** The state a write would hold at `now`, computed in memory (never writes). */
  step(now?: number, forced: ReplanCause | null = null, boostOverride?: BoostWindow | null): PlanStep {
    const t = this.at(now);
    const { state: loaded, problem, fresh } = this.current();
    const intent = this.deps.intent();
    const boost = clockBoost(boostOverride === undefined ? loaded.boost : boostOverride, t);
    const state = { ...loaded, boost };
    const window = this.windowAt(t, state, intent);
    const prev = state.plan;
    const newWindow = prev === null || prev.window.startsAt !== window.startsAt || prev.window.key !== window.key;
    const ended = loaded.boost !== null && loaded.boost.endedAt === null && boost !== null && boost.endedAt !== null;
    let cause: ReplanCause | null = forced;
    if (cause === null) {
      if (problem !== null && !fresh) cause = 'repair';
      else if (newWindow) cause = prev !== null && prev.window.endsAt === window.startsAt ? 'day-start' : 'first-open';
      else if (t < prev.drawnAt - CLOCK_TOLERANCE_MS) cause = 'clock';
      else if (ended) cause = 'boost-end';
      else if (intentDigest(intent) !== prev.intentDigest) cause = 'settings';
    }
    let plan = prev as DayPlan;
    if (cause !== null) {
      const opts = this.drawOptions(state, intent, t, cause);
      if (prev === null || newWindow) {
        const firstOpenAt = cause === 'repair' ? Math.min(t, this.deps.store.recentMutationTimes(window.startsAt)[0] ?? t) : t;
        plan = drawDayPlan(this.input(state, window, intent, t, firstOpenAt, boost), opts);
      } else {
        plan = replanRemainder(prev, this.input(state, window, intent, t, prev.firstOpenAt, boost), t, this.usage(prev, t), cause, opts);
      }
    }
    const firstKept = plan.sessions.findIndex((s) => s.budget > 0);
    const clearFlag = state.upgradeProbation && firstKept >= 0 && t >= windowEndOf(plan, firstKept);
    const next: PlanStateV1 = { ...state, plan, upgradeProbation: state.upgradeProbation && !clearFlag };
    const dirty = cause !== null || fresh || boost !== loaded.boost || clearFlag;
    return { state: next, plan, cause, dirty, intent };
  }

  private viewOf(s: PlanStep, now: number, provisional: boolean): PlanView {
    const { plan, intent, state } = s;
    const used = this.usage(plan, now);
    const recentTimes = this.deps.store.recentMutationTimes(now - MS_PER_HOUR);
    return viewPlan(plan, {
      now, used, boost: state.boost, runIntent: this.deps.runIntent(),
      hourly: { lastHour: recentTimes.filter((t) => t > now - MS_PER_HOUR && t <= now).length, recentTimes },
      deadline: this.deps.deadline(), tomorrow: () => this.tomorrow(s, now), journal: this.deps.journal,
      lastMutationBefore: (t) => this.deps.lastMutationBefore(t), unconfirmed: this.deps.unconfirmed(),
      surfacePaused: (a) => this.deps.surfaceGate.paused(a), intent,
      ambient: ambientTempo(plan.seed, intent, typicalSessionBudget(intent)),
      probationTempo: (i) => sessionTempo(plan.seed, plan.sessions[i].idx, intent, { mix: plan.sessions[i].tempo.mix, probation: true },
        intent.hourlyCap, Math.max(1, plan.sessions[i].budget)),
      windowOf: (t) => this.windowAt(t, state, intent), provisional, upgradeProbation: state.upgradeProbation, joinedAt: used.joinedAt,
    });
  }

  /** The next plan-day's ideal plan (a pure draw of the next key), cached in memory by key. */
  private tomorrow(s: PlanStep, now: number): DayPlan {
    const w = this.windowAt(s.plan.window.endsAt, s.state, s.intent);
    const key = `${w.key}|${w.startsAt}|${intentDigest(s.intent)}`;
    const hit = this.tomorrowCache.get(key);
    if (hit !== undefined) return hit;
    const plan = drawBase(this.input(s.state, w, s.intent, now, w.startsAt, null), { now: w.startsAt, cause: 'day-start' });
    this.tomorrowCache.clear();
    this.tomorrowCache.set(key, plan);
    return plan;
  }

  /** PURE: the plan at `now`; provisional when `ensure` would write. */
  view(now?: number): PlanView {
    const t = this.at(now);
    const s = this.step(t);
    return this.viewOf(s, t, s.dirty);
  }

  private commit(s: PlanStep, now: number): PlanView {
    if (s.dirty) {
      if (s.cause === 'repair') this.opts.log?.warn('plan: plan_state failed validation; re-derived the current window');
      this.deps.store.setPlanState(serializePlanState(s.state));
    }
    const v = this.viewOf(s, now, false);
    if (s.cause !== null) this.deps.onChanged?.(v, s.cause);
    return v;
  }

  /** THE writer: re-plans and writes only on a §5.6 cause. */
  ensure(now?: number): PlanView {
    const t = this.at(now);
    return this.commit(this.step(t), t);
  }

  /** A settings change: the digest check inside `ensure` decides whether it re-plans. */
  onSettings(now?: number): PlanView {
    return this.ensure(now);
  }

  /** A census completed: the remainder's kinds re-derive from the new demand. */
  onDemand(now?: number): PlanView {
    const t = this.at(now);
    const base = this.step(t);
    return this.commit(base.cause !== null ? base : this.step(t, 'demand'), t);
  }

  /** Open a Boost window and re-plan, in one write (spec §8.2). */
  startBoost(durationMs: number, now?: number): PlanView {
    const t = this.at(now);
    this.ensure(t);
    const boost: BoostWindow = { v: 1, startedAt: t, endsAt: t + durationMs, durationMs, endedAt: null, endReason: null };
    return this.commit(this.step(t, 'boost-start', boost), t);
  }

  /** End the Boost now (the safe direction; no confirm) and re-plan, in one write. */
  endBoost(_reason: 'user', now?: number): PlanView {
    const t = this.at(now);
    const s = this.step(t);
    const boost = s.state.boost;
    if (boost === null || boost.endedAt !== null) return this.commit(s, t);
    return this.commit(this.step(t, 'boost-end', { ...boost, endedAt: t, endReason: 'user' }), t);
  }

  /** The next instant the plan changes on its own: the boundary, the Boost end or the next session start. */
  nextEdgeAt(now?: number): number {
    const t = this.at(now);
    const s = this.step(t);
    const next = s.plan.sessions.find((x) => x.startAt > t && x.budget > 0)?.startAt ?? Number.POSITIVE_INFINITY;
    const boostEnd = s.state.boost !== null && s.state.boost.endedAt === null ? s.state.boost.endsAt : Number.POSITIVE_INFINITY;
    return Math.min(s.plan.window.endsAt, boostEnd, next);
  }

  /** The current plan-day's start (the rate governor's provider). */
  dayStart(now?: number): number {
    return this.step(this.at(now)).plan.window.startsAt;
  }

  /** The plan-backed TempoSource: the open session's tempo, else the ambient one; overrides only slow. */
  tempo(): TempoSource {
    return planTempoSource({ current: () => this.view().tempo, overrides: () => this.deps.intent().tempoOverrides }, this.deps.launchSeed);
  }

  /** The plan-backed one boundary every day counter reads (swapped in at plan-wiring). */
  planDayClock(): PlanDayClock {
    return planBackedDayClock((t) => {
      const s = this.step(this.at());
      return this.windowAt(t, s.state, s.intent);
    }, { now: () => this.deps.clock.now() });
  }

  /** The Boost preview (spec §8.5): `applyBoost` on a copy of the remainder, nothing written. */
  previewBoost(hours: number, now?: number): BoostPreview {
    const t = this.at(now);
    const durationMs = clampBoostHours(hours) * MS_PER_HOUR;
    const boost: BoostWindow = { v: 1, startedAt: t, endsAt: t + durationMs, durationMs, endedAt: null, endReason: null };
    const base = this.step(t, 'boost-end', null);
    const boosted = this.step(t, 'boost-start', boost);
    return boostPreview({
      now: t, hours, base: base.plan, boosted: boosted.plan, usage: this.usage(base.plan, t), intent: base.intent,
      running: this.deps.runIntent() === 'running', remaining: this.viewOf(base, t, true).remaining,
    });
  }

  /** The PlanPreviewPort: plan-days drawn for an intent at this install's phase, nothing written. */
  previewDays(intent: PlanIntent, at: number, days: number): readonly PlanPreviewDay[] {
    const { state } = this.current();
    return previewDays({ installEntropy: this.deps.installEntropy, phaseOffsetHours: state.phaseOffsetHours,
      demand: (w, n) => this.deps.demand(w, n) }, intent, at, days);
  }

  /** The persisted state at `now` as `step` sees it (for previews and projections). */
  snapshot(now?: number): PlanStep {
    return this.step(this.at(now));
  }
}

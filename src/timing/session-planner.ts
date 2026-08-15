/**
 * SessionPlanner — the two-level stochastic pacing authority.
 *
 * Level 1 (sessions): each day draws a target volume and a session COUNT, then lays out
 * that many session start times sampled from the circadian field λ(t) across the whole
 * day (so they spread morning/midday/evening, clustered in active hours), and distributes
 * the day's target across them as per-session budgets. Distributing a fixed daily target
 * — rather than summing independent session budgets and capping — is what makes realized
 * daily volume track the configured mean (capping independent budgets gives
 * E[min(sum,target)] < target, a ~⅓ under-delivery). Laying starts out up front — rather
 * than scheduling each within the shrinking remainder of the day — keeps them circadian
 * instead of cramming later sessions into the late hours.
 *
 * Level 2 (within-session actions): inter-action gaps are log-normal, floored for IG
 * velocity safety, divided by a decaying Hawkes self-excitation term so a session
 * clusters then winds down. See the plan §3–§4.
 *
 * The planner owns *pacing*; engines own *actions*. Pure and renderer-safe (the settings
 * live-preview drives it directly); `rng` is injected for determinism. All "catch-up"
 * (day roll, session open/close, hour pruning) happens in one idempotent `sync(now)` that
 * every method calls first, so a hydrated snapshot resumes exactly (§3 durable schedules).
 */

import { type CircadianProfile, intensityAt } from './circadian';
import { SESSION } from './config';
import { clamp, logNormal, normal01 } from './distributions';
import { type Rng, sample } from './primitives';
import { MS_PER_HOUR } from './units';

/** A gap larger than this ends the session — one home: the timing registry. */
const SESSION_BOUNDARY_MS = SESSION.SESSION_BOUNDARY_MS;

export type PlannerActionKind = 'follow' | 'unfollow' | 'read-burst';

/** One planned session: when it starts and how many actions it carries. */
export interface PlannedSession {
  startAt: number;
  budget: number;
}

/** Settings-derived pacing knobs (see the plan §4.3 / §5.4 `toPacingConfig`). */
export interface SessionPlannerConfig {
  dailyMeanActions: number;
  dailyHardCeiling: number;
  dayVolumeSigma: number;
  restDayProbability: number;
  restDayMaxFraction: number;
  sessionsPerDayMin: number;
  sessionsPerDayMax: number;
  gapMedianMs: number;
  gapSigma: number;
  gapFloorMs: number;
  gapCapMs: number;
  hawkesAlpha: number;
  hawkesTauMs: number;
  maxActionsPerRollingHour: number;
}

/** Durable state; persisted through store meta and hydrated at construction. */
export interface PlannerSnapshot {
  v: 1;
  dayKey: string;
  dayTarget: number;
  dayUsed: number;
  dayPlan: PlannedSession[];
  nextPlanIdx: number;
  session: { startedAt: number; budget: number; used: number } | null;
  recentActions: { at: number; kind: PlannerActionKind }[];
  phaseOffsetHours: number;
}

export interface SessionPlannerDeps {
  rng?: Rng;
  profile: CircadianProfile;
  cfg: SessionPlannerConfig;
  snapshot?: PlannerSnapshot | null;
}

/** The structural port the engine depends on (implemented by SessionPlanner). */
export interface PacingPlanner {
  advance(now: number): void;
  isSessionOpen(now: number): boolean;
  sessionEndsAt(now: number): number | null;
  nextSessionStartAt(now: number): number;
  nextActionGapMs(now: number): number;
  recordAction(now: number, kind: PlannerActionKind): void;
  dailyTarget(now: number): number;
  sessionsToday(now: number): number;
  serialize(): PlannerSnapshot;
}

/** Local 'YYYY-M-D' key — the scope of one day's volume draw. Exported for tests/wiring. */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export class SessionPlanner implements PacingPlanner {
  private readonly rng: Rng;
  private cfg: SessionPlannerConfig;
  private readonly baseProfile: CircadianProfile;

  private dayKey: string;
  private dayTarget: number;
  private dayUsed: number;
  private dayPlan: PlannedSession[];
  private nextPlanIdx: number;
  private session: { startedAt: number; budget: number; used: number } | null;
  private recentActions: { at: number; kind: PlannerActionKind }[];
  private readonly phaseOffsetHours: number;

  constructor(deps: SessionPlannerDeps) {
    this.rng = deps.rng ?? Math.random;
    this.cfg = deps.cfg;
    this.baseProfile = deps.profile;
    const snap = deps.snapshot ?? null;
    this.phaseOffsetHours = snap?.phaseOffsetHours ?? deps.profile.phaseOffsetHours;
    this.dayKey = snap?.dayKey ?? '';
    this.dayTarget = snap?.dayTarget ?? 0;
    this.dayUsed = snap?.dayUsed ?? 0;
    this.dayPlan = snap?.dayPlan ? snap.dayPlan.map((s) => ({ ...s })) : [];
    this.nextPlanIdx = snap?.nextPlanIdx ?? 0;
    this.session = snap?.session ? { ...snap.session } : null;
    this.recentActions = snap?.recentActions ? snap.recentActions.map((a) => ({ ...a })) : [];
  }

  /**
   * Swap the live config (used when Settings change at runtime). The current day's
   * already-drawn plan keeps its budgets/starts; new knobs take effect at the next day
   * roll (and immediately for the gap draw and velocity cap).
   */
  applyConfig(cfg: SessionPlannerConfig): void {
    this.cfg = cfg;
  }

  // --- Public API (all sync first) -------------------------------------------------

  advance(now: number): void {
    this.sync(now);
  }

  isSessionOpen(now: number): boolean {
    this.sync(now);
    return (
      this.session !== null &&
      this.session.used < this.session.budget &&
      this.dayUsed < this.dayTarget
    );
  }

  sessionEndsAt(now: number): number | null {
    this.sync(now);
    if (this.session === null) return null;
    const remaining = Math.max(0, this.session.budget - this.session.used);
    return now + remaining * this.cfg.gapMedianMs; // display estimate only
  }

  nextSessionStartAt(now: number): number {
    this.sync(now);
    if (this.session !== null) return this.session.startedAt;
    if (this.nextPlanIdx < this.dayPlan.length) return this.dayPlan[this.nextPlanIdx].startAt;
    return this.nextLocalMidnight(now);
  }

  nextActionGapMs(now: number): number {
    this.sync(now);
    const hourAgo = now - MS_PER_HOUR;
    const recentAccount = this.recentActions.filter((a) => a.kind !== 'read-burst' && a.at > hourAgo);
    if (recentAccount.length >= this.cfg.maxActionsPerRollingHour) {
      const oldest = Math.min(...recentAccount.map((a) => a.at));
      const wait = oldest + MS_PER_HOUR - now + this.cfg.gapFloorMs;
      return Math.max(this.cfg.gapFloorMs, Math.round(wait));
    }
    const base = sample(
      clamp(logNormal(this.cfg.gapMedianMs, this.cfg.gapSigma), this.cfg.gapFloorMs, this.cfg.gapCapMs),
      this.rng,
    );
    let excitation = 1;
    for (const a of this.recentActions) {
      if (a.at <= now) excitation += this.cfg.hawkesAlpha * Math.exp(-(now - a.at) / this.cfg.hawkesTauMs);
    }
    return Math.max(this.cfg.gapFloorMs, Math.round(base / excitation));
  }

  recordAction(now: number, kind: PlannerActionKind): void {
    this.sync(now);
    this.recentActions.push({ at: now, kind });
    // Only FOLLOWS spend the daily/session budget — the daily target is a follow plan.
    // Unfollows (lifecycle + woven prune) and reads are weaved in on top: they are still
    // recorded for the Hawkes clustering and the rolling-hour velocity guard, but they do
    // not consume the follow plan (they are bounded by the velocity guard + prune cap).
    if (kind === 'follow') {
      this.dayUsed += 1;
      if (this.session !== null) this.session.used += 1;
    }
    this.pruneRecent(now);
  }

  dailyTarget(now: number): number {
    this.sync(now);
    return this.dayTarget;
  }

  sessionsToday(now: number): number {
    this.sync(now);
    return this.nextPlanIdx;
  }

  serialize(): PlannerSnapshot {
    return {
      v: 1,
      dayKey: this.dayKey,
      dayTarget: this.dayTarget,
      dayUsed: this.dayUsed,
      dayPlan: this.dayPlan.map((s) => ({ ...s })),
      nextPlanIdx: this.nextPlanIdx,
      session: this.session ? { ...this.session } : null,
      recentActions: this.recentActions.map((a) => ({ ...a })),
      phaseOffsetHours: this.phaseOffsetHours,
    };
  }

  // --- The one idempotent catch-up ------------------------------------------------

  private sync(now: number): void {
    // 1. Day roll — lay out a fresh day plan at the local-midnight change.
    const key = localDayKey(now);
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.drawDayPlan(now);
      this.dayUsed = 0;
      this.session = null;
    }

    // 2. Close a spent or long-idle session (a >30 min gap ends it — the engine may have
    //    parked mid-session, in which case the next due session takes over).
    if (this.session !== null) {
      const lastAt =
        this.recentActions.length > 0
          ? this.recentActions[this.recentActions.length - 1].at
          : this.session.startedAt;
      if (this.session.used >= this.session.budget || now - lastAt > SESSION_BOUNDARY_MS) {
        this.session = null;
      }
    }

    // 3. Open the next planned session once it is due and the day has budget left.
    if (
      this.session === null &&
      this.nextPlanIdx < this.dayPlan.length &&
      now >= this.dayPlan[this.nextPlanIdx].startAt &&
      this.dayUsed < this.dayTarget
    ) {
      this.openSession(now);
    }

    // 4. Keep only the trailing hour (Hawkes + velocity window).
    this.pruneRecent(now);
  }

  // --- Internals ------------------------------------------------------------------

  private effectiveProfile(): CircadianProfile {
    return { ...this.baseProfile, phaseOffsetHours: this.phaseOffsetHours };
  }

  private drawDayPlan(now: number): void {
    const mean = this.cfg.dailyMeanActions;
    let target: number;
    if (this.rng() < this.cfg.restDayProbability) {
      target = Math.round(mean * (this.rng() * this.cfg.restDayMaxFraction));
    } else {
      target = Math.round(mean * Math.exp(this.cfg.dayVolumeSigma * normal01(this.rng)));
    }
    this.dayTarget = Math.max(0, Math.min(this.cfg.dailyHardCeiling, target));

    const span = Math.max(0, this.cfg.sessionsPerDayMax - this.cfg.sessionsPerDayMin);
    const drawn = this.cfg.sessionsPerDayMin + Math.floor(this.rng() * (span + 1));
    const count = this.dayTarget <= 0 ? 0 : Math.max(1, Math.min(drawn, this.dayTarget));

    const from = now;
    // Leave a tail before midnight so a late session finishes today rather than
    // being cut off by the day roll (which would drop its remaining actions).
    const to = Math.max(from + 1, this.nextLocalMidnight(now) - 20 * 60_000);
    const starts = Array.from({ length: count }, () => this.sampleTimeByIntensity(from, to)).sort(
      (a, b) => a - b,
    );
    const budgets = this.distributeBudgets(this.dayTarget, count);
    this.dayPlan = starts.map((startAt, i) => ({ startAt, budget: budgets[i] }));
    this.nextPlanIdx = 0;
  }

  /** Split `target` into `n` jittered per-session budgets that sum to `target`. */
  private distributeBudgets(target: number, n: number): number[] {
    const out: number[] = [];
    let remaining = target;
    let rs = n;
    for (let i = 0; i < n; i += 1) {
      let b: number;
      if (rs <= 1) {
        b = remaining;
      } else {
        const fair = remaining / rs;
        b = Math.round(fair * (0.6 + 0.8 * this.rng()));
        b = Math.max(1, Math.min(b, remaining - (rs - 1))); // leave ≥1 for each later session
      }
      out.push(Math.max(1, b));
      remaining -= out[i];
      rs -= 1;
    }
    return out;
  }

  /** Rejection-sample a time in [from, to) with acceptance ∝ intensityAt. */
  private sampleTimeByIntensity(from: number, to: number): number {
    if (to <= from) return from;
    const profile = this.effectiveProfile();
    let maxI = 0.02;
    for (let i = 0; i <= 24; i += 1) maxI = Math.max(maxI, intensityAt(from + ((to - from) * i) / 24, profile));
    for (let i = 0; i < 200; i += 1) {
      const t = from + this.rng() * (to - from);
      if (this.rng() < intensityAt(t, profile) / maxI) return Math.round(t);
    }
    return Math.round((from + to) / 2);
  }

  private openSession(now: number): void {
    const entry = this.dayPlan[this.nextPlanIdx];
    const remaining = this.dayTarget - this.dayUsed;
    const budget = Math.max(1, Math.min(entry.budget, remaining));
    this.session = { startedAt: now, budget, used: 0 };
    this.nextPlanIdx += 1;
  }

  private pruneRecent(now: number): void {
    const cutoff = now - MS_PER_HOUR;
    this.recentActions = this.recentActions.filter((a) => a.at > cutoff);
  }

  private nextLocalMidnight(now: number): number {
    const d = new Date(now);
    d.setHours(24, 0, 0, 0);
    return d.getTime();
  }
}

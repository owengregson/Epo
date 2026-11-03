/**
 * The plan-facing engine ports: the rate governor slice and the plan the loop
 * consults (re-exported by `ports.ts`, so consumers may import from either).
 */

import type { PlanView } from '../governors/plan-types';
import type { TempoSource } from '../kernel/tempo';

/** The tempo the loop's wait bases resolve from; the plan's source is swapped in at wiring (default: reference). */
export interface EngineTempo {
  readonly tempo?: TempoSource;
}

/** The Rate Governor slice the Engine consults for gating, pacing, and status. */
export interface EngineRate {
  withinActiveHours(): boolean;
  atHardCeiling(): boolean;
  /** True once today's actions reach the USER's operating rate — the engine's
   *  real daily stop; the hard ceiling is only the uncrossable backstop. */
  atOperatingRate(): boolean;
  nextDelayMs(): number;
  actionsToday(): number;
  remainingToday(): number;
  /** The plan's automatic volume for today — a fluctuating draw just under the
   *  operating rate; where {@link atOperatingRate} actually trips. */
  plannedToday(): number;
  /** The current plan-day's start: the one boundary every "today" counts from. */
  dayStart(): number;
  /** ms until the action counter resets (the next plan-day) — the legacy
   *  metronome's park horizon once a daily cap is hit. */
  msUntilCycleReset(): number;
  /** Real IG actions (both ledgers) in the trailing hour — the durable velocity signal. */
  actionsInLastHour(): number;
}

/** The plan the loop consults (spec §5.15): the pure view, an ensure only while provisional, a wake for its parks. */
export interface EnginePlan {
  view(now: number): PlanView;
  ensureIfProvisional(now: number): PlanView;
  wake(): void;
}

/**
 * The plan as the loop's pacing dep while the pace is unchanged (spec §5.13 S1): the gap armed after
 * each action is the reference shape's draw at time-scale 1 (today's planner gap); the cadence
 * switch arms the plan's own deadline at dispatch instead.
 */
export interface EnginePlanPacing extends EnginePlan {
  gapAfter(at: number): number;
}

/** The loop's plan dep, under the name the dep and the fact group keep. */
export type EnginePacing = EnginePlanPacing;

/** The `pacing` fact group's plan-backed type (the group name is kept; the rules are untouched). */
export interface PlanFacts {
  readonly sessionOpen: boolean;
  /** `until` is always finite: a null next session parks to the next plan-day boundary. */
  readonly park: { readonly key: 'engine:session-park' | 'engine:daily-ceiling-park' | 'engine:velocity-park'
    | 'engine:read-budget-park'; readonly until: number } | null;
  readonly admits: { readonly follow: boolean; readonly unfollow: boolean; readonly accept: boolean; readonly explore: boolean };
  readonly mix: 'normal' | 'boost';
  readonly probation: boolean;
  readonly reads: { readonly exploreLeft: number; readonly reconcileLeft: number };
  /** censusDue holds only when this session hosts the census. */
  readonly checkDue: boolean;
  readonly checkLight: boolean;
  readonly censusDue: boolean;
}

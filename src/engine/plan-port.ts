/**
 * The plan-facing engine ports: the rate governor slice and the pacing planner the
 * loop consults (re-exported by `ports.ts`, so consumers may import from either).
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
  /** The volume planned for this cycle — a fluctuating draw just under the
   *  operating rate; where {@link atOperatingRate} actually trips. */
  plannedToday(): number;
  /** ms until the action counter resets (the next active-hours cycle start) —
   *  the park horizon once a daily cap is hit. */
  msUntilCycleReset(): number;
  /** Real IG actions (both ledgers) in the trailing hour — the durable velocity signal. */
  actionsInLastHour(): number;
}

/**
 * The organic pacing planner (SessionPlanner) the Engine consults when
 * `EngineDeps.pacing` is injected. Its presence selects the organic model
 * (`Settings.pacingModel === 'organic'`); absent, the Engine runs the legacy
 * active-hours + operating-rate metronome. Structurally satisfied by
 * `timing/session-planner.PacingPlanner`.
 */
export interface EnginePacing {
  advance(now: number): void;
  isSessionOpen(now: number): boolean;
  sessionEndsAt(now: number): number | null;
  nextSessionStartAt(now: number): number;
  nextActionGapMs(now: number): number;
  recordAction(now: number, kind: 'follow' | 'unfollow' | 'read-burst'): void;
  dailyTarget(now: number): number;
  sessionsToday(now: number): number;
  /** Durable snapshot for persistence; optional so plain test fakes can omit it. */
  serialize?(): unknown;
}

/** The plan the loop consults once the plan core lands (unconsumed in Phase F; replaces EnginePacing). */
export interface EnginePlan {
  view(now: number): PlanView;
  ensureIfProvisional(now: number): PlanView;
  wake(): void;
}

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

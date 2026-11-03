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

/** The Rate Governor slice the Engine consults: the durable counters and the hard ceiling (spec §5.13 S2). */
export interface EngineRate {
  atHardCeiling(): boolean;
  actionsToday(): number;
  /** Real IG actions (both ledgers) in the trailing hour — the durable velocity signal. */
  actionsInLastHour(): number;
}

/** The kinds of write the loop performs and the plan's breaker watches. */
export type EngineWriteKind = 'follow' | 'unfollow';

/**
 * The plan the loop consults (spec §5.15): the pure view, an ensure only while provisional, a wake
 * for its parks; the exact velocity window; the practice-mode gap; and the unconfirmed-actions breaker.
 */
export interface EnginePlan {
  view(now: number): PlanView;
  ensureIfProvisional(now: number): PlanView;
  wake(): void;
  /** When a full rolling hour has room again plus one gap draw, or null while it has room (spec §5.10). */
  velocityParkUntil(now: number): number | null;
  /** A practice-mode write dispatched nothing: the same gap is owed as after a dispatch (practice works as usual). */
  practiced(at: number): void;
  /** A dispatched write's evidence (spec §11.1 F7): the kind's unverified streak after it. */
  noteOutcome(kind: EngineWriteKind, unverified: boolean, at: number): number;
}

/** The loop's plan dep, under the name the dep and the fact group keep. */
export type EnginePacing = EnginePlan;

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

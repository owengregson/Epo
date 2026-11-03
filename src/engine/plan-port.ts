/**
 * The plan-facing engine ports: the rate governor slice and the pacing planner the
 * loop consults (re-exported by `ports.ts`, so consumers may import from either).
 */

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

/**
 * The Engine's ports: the narrow, structural slices of each collaborator it
 * needs, plus the status projection and the dependency bundle the composition
 * root fills in. The real components (ChurnScheduler, Scanner, ChainController,
 * FollowbackWatcher, RateGovernor, Sentinel) satisfy these by structural
 * subtyping; tests inject plain fakes without touching the concrete classes.
 *
 * `engine.ts` re-exports every name here, so consumers may import from either.
 */

import type { SentinelStatus } from '../adapter/sentinel';
import type { Clock } from '../governors/clock';
import type { EffectReconciliationResult } from '../rim/effect-reconciliation';
import type { AcquireEndReason } from '../rim/follower-acquisition';
import type { Settings } from '../settings/settings';
import type { KnowledgeStore } from '../store/knowledge-store';
import type { FollowRecord } from '../store/types';
import type { DelayManager } from '../timing/delay-manager';
import type { AdvanceResult } from './chain-controller';
import type { ChurnActionOutcome } from './churn-scheduler';
import type { ReentrySupervisor } from './reentry';
import type { ScanPlan } from './scanner';
import type { SourceFrontier, SourceVisitEndReason } from './source-frontier';
import type { EngineStatus } from './status';

/** What a single loop iteration did — exactly one of these per `stepOnce()`. */
export type StepResult =
  | 'aborted'
  | 'halted'
  | 'waited-active-hours'
  | 'waited-session'
  | 'waited-ceiling'
  | 'swept-followback'
  | 'acquired'
  | 'acted'
  | 'advanced-chain'
  | 'recovering'
  | 'idle';

export type EngineState = 'idle' | 'running' | 'paused' | 'halted';

/** The follow-back sweep's due-by-timestamp port (see {@link EngineDeps.sweepCadence}). */
export interface SweepCadence {
  isDue(now: number, everyMs: number): boolean;
  markRun(now: number): void;
}

// ---------------------------------------------------------------------------------
// Ports: the narrow, structural slices of each collaborator the Engine needs.
// The real components (ChurnScheduler, Scanner, ChainController, FollowbackWatcher,
// RateGovernor, Sentinel) satisfy these by structural subtyping;
// tests inject plain fakes without touching the concrete classes.
// ---------------------------------------------------------------------------------

/** The Churn Scheduler's split API: timers / pick one / execute one. */
export interface EngineChurn {
  lastActionOutcome?(): ChurnActionOutcome | null;
  advanceTimers(now: number): void;
  nextDue(now: number): FollowRecord | null;
  /**
   * Perform the one record's action and report its outcome: the Engine routes
   * `'blocked'` to a short park (never a full-pace re-drive of the same
   * record), feeds the streak counters into the recovery ladder, and treats
   * `'noop'` (nothing touched Instagram) as an ordinary acted step.
   */
  execute(rec: FollowRecord, now: number): Promise<ChurnActionOutcome['status'] | 'noop'>;
  /**
   * The consecutive-outcome windows the recovery ladder reads:
   * `failed` is the systemic-breakage signal (broken input pipeline, drifted
   * selector) that enters the ladder past {@link ACTIONS_FAILING_HALT},
   * `drift` is how much of that window was drift-caused, and `blocked` is the
   * rate-wall streak. Required: production always has them, and an absent
   * reading would silently read as "no streak".
   */
  streaks(): { failed: number; drift: number; blocked: number };
  /** Open fresh windows — each recovery rung burns one. */
  resetStreaks(): void;
  /**
   * The most recent blocked outcome's classification: `'rate-limited'` means
   * Instagram's own response refused the mutation as throttling — definitive,
   * so the engine ladders up on it at once instead of waiting for a streak.
   */
  lastBlockedCause(): ChurnActionOutcome['cause'] | null;
}

/**
 * The tab-diagnostics port the recovery ladder consults on entry (diagnose
 * FIRST, wait second): the input probe + rAF canary decide tab-vs-rate-wall,
 * and `recoverTab` is the repair for a sick tab. The composition root wires
 * the real `InstagramTab`; absent (plain test fakes), the tab is presumed
 * healthy and every entry takes the rate-limit hold path.
 */
export interface EngineTabDiagnostics {
  /** Input-pipeline probe: whether dispatched events reach the page. */
  probeInput(): Promise<boolean>;
  /** Renderer-health canary (rAF ticks + evaluate round-trip). */
  checkHealth(): Promise<{ healthy: boolean }>;
  /** Recover a wedged tab (reload + debugger re-attach), deadline-bounded. */
  recoverTab(): Promise<void>;
}

/** The Scanner's planning surface: rank + enqueue one target's candidates. */
export interface EngineScanner {
  reconsiderTarget?(targetPk: string, now?: number): void;
  planTarget(targetPk: string): ScanPlan;
  /**
   * Backfill scores for queued records that predate score persistence, so the
   * follow order (and its display) is the ranking, not pk order. Optional so
   * plain test fakes keep working; called once per `start()`.
   */
  rescoreQueued?(): number;
}

/** The Chain Controller's single verb: advance past an exhausted target. */
export interface EngineChain {
  advance(currentTargetPk: string, reason?: SourceVisitEndReason): Promise<AdvanceResult>;
}

/**
 * The acquisition slice the Engine consumes: the rim port's `{observed,
 * targetPk}` PLUS the typed {@link AcquireEndReason}. The end reason is
 * REQUIRED here — the Engine may only latch a target exhausted on positive
 * evidence, and a result that cannot say WHY the read ended is not evidence —
 * an `observed: 0` from a FAILED read says nothing about the audience.
 * `AdapterBackedAcquisition` satisfies this structurally.
 */
export interface EngineAcquisition {
  acquire(
    targetUsername: string,
  ): Promise<{ observed: number; targetPk: string | null; endReason: AcquireEndReason; retryAt?: number; globallyNew?: number }>;
}

/**
 * The GENUINE end reasons that are positive evidence a target's USABLE pool is
 * done: 'no-more-pages' verified the end of the list, and 'coverage-cap' means
 * the coverage policy is deliberately satisfied (scraping deeper is a quality
 * dead-end by design — the target is finished for our purposes). Every other
 * genuine reason ('target-reached' / 'page-budget' / 'no-new-for-caller' /
 * 'stagnant') merely BOUNDS A SLICE — the persisted cursor resumes where it
 * stopped — so a zero under one of those must reopen acquisition, never latch
 * exhaustion. Failure reasons never reach this set (see the refill path).
 */
export const ACQUIRE_DRAIN_REASONS: ReadonlySet<AcquireEndReason> = new Set([
  'no-more-pages',
  'coverage-cap',
]);

/** The Follow-back Watcher's single verb: one request-bounded sweep. */
export interface EngineFollowback {
  check(opts?: { requireFresh?: boolean; freshSinceAt?: number }): Promise<{
    detected: string[];
    outcome?: 'complete' | 'partial' | 'failed';
    deferred?: 'read-budget' | 'pending-requests' | 'reconciliation-progress';
    retryAt?: number;
    reconciledAt?: number | null;
  }>;
}

/**
 * The profile-enricher port: fetch profile stats (follower/following counts)
 * for the given usernames and write them into the store as observations, returning
 * how many profiles were successfully enriched. The real `ProfileEnricher` (rim)
 * is sentinel-gated and paced internally; tests inject a fake.
 */
export interface EngineEnricher {
  budgetResumeAt?(): number | null;
  enrich(usernames: string[]): Promise<number>;
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

/**
 * The woven prune-unfollow feed: the growth loop drains prune candidates
 * from the completed census as ONE interleaved action stream (so unfollows never burst
 * and the follow→unfollow batch-correlation signal is defeated). Implemented by the
 * PruneEngine over its scanned candidate set; only consulted in the organic model with
 * `Settings.weaveEnabled`. `nextCandidate` is pure selection (live whitelist + live-graph
 * follows-us guard + freshness + daily cap; consumes only leading skips) and mutates
 * nothing actionable until `executeUnfollow`, which does the DOM unfollow + ledger row +
 * edge reconcile and returns the outcome.
 */
export interface EngineUnfollowFeed {
  lastActionOutcome?(): ChurnActionOutcome | null;
  nextCandidate(now: number): { pk: string; username: string } | null;
  executeUnfollow(
    cand: { pk: string; username: string },
    now: number,
  ): Promise<'ok' | 'failed' | 'simulated' | 'blocked'>;
  atDailyCap(now: number): boolean;
}

/** The Sentinel slice: classify the tab before anything else each iteration. */
export interface EngineSentinel {
  check(): Promise<SentinelStatus>;
}

export type { EngineStatus } from './status';

/** Everything the Engine composes, already constructed (composition root's job). */
export interface EngineDeps {
  frontier?: SourceFrontier;
  reentry?: ReentrySupervisor;
  validateIdentity?: () => Promise<boolean>;
  onProgress?: (phase: string) => void;
  reconcileEffects?: () => Promise<boolean | EffectReconciliationResult>;
  store: KnowledgeStore;
  clock: Clock;
  rate: EngineRate;
  sentinel: EngineSentinel;
  churn: EngineChurn;
  scanner: EngineScanner;
  chain: EngineChain;
  followback: EngineFollowback;
  acquisition: EngineAcquisition;
  /**
   * The profile enricher the pool-refill step uses to fetch counts for
   * candidates the followers-list left count-less (the real adapter-backed
   * `ProfileEnricher` in production; tests inject a fake).
   */
  enricher: EngineEnricher;
  settings: Settings;
  /**
   * The organic pacing planner. When injected, the loop
   * runs the session-driven model (circadian sessions, log-normal gaps, daily-volume
   * distribution) and persists its snapshot to store meta; when absent, the legacy
   * active-hours + operating-rate metronome runs unchanged. The composition root
   * injects it only when `Settings.pacingModel === 'organic'`.
   */
  pacing?: EnginePacing;
  /**
   * The woven prune-unfollow feed. Injected by the composition root (the
   * PruneEngine); the loop weaves its candidates into the action stream only in the
   * organic model when `Settings.weaveEnabled`. Absent → no woven unfollows.
   */
  unfollowFeed: EngineUnfollowFeed;
  /**
   * The shared wait owner: ONE DelayManager, shared with the prune engine (keys
   * are namespaced `engine:` / `prune:`), so every wait in the app passes the
   * same gate. Tests build one over a fake sleep (`tests/kit/engine-harness.ts`).
   */
  delays: DelayManager;
  /** Randomness for the jittered pacing draw; injectable for deterministic tests. */
  rng?: () => number;
  /**
   * Per-install noise entropy (store meta `install_entropy`, drawn once and
   * persisted): seeds the DEDICATED timing-noise rng and the restart-stable
   * daily-boundary jitter, so no two installs share wake offsets while one
   * install's offset survives a mid-park relaunch. Absent (plain test
   * fakes pass 0), keeping every noise draw deterministic under a fake clock.
   */
  installEntropy: number;
  /**
   * Due-by-timestamp cadence for the follow-back sweep. The composition root
   * injects a PERSISTED cadence (Settings.sweepLastRunAt) so the 4h rhythm
   * survives restarts (PRINCIPLES §3); the test kit supplies an in-memory one
   * that starts due, so a fresh Engine's first eligible step catches up.
   */
  sweepCadence: SweepCadence;
  /**
   * The tab-diagnostics port the recovery ladder consults on entry (see
   * {@link EngineTabDiagnostics}). A healthy no-op port routes every ladder
   * entry down the rate-limit hold path.
   */
  tabDiag: EngineTabDiagnostics;
  /** Called with a fresh status projection after every step and lifecycle change. */
  onStatus: (s: EngineStatus) => void;
  /** Called exactly once per halt with the reason (e.g. `sentinel:challenge`). */
  onHalt: (reason: string) => void;
}

/** The chain target the loop is currently working, as the Engine holds it. */
export interface CurrentTarget {
  pk: string;
  username: string | null;
}

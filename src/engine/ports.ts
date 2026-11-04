/**
 * The Engine's ports: the narrow, structural slices of each collaborator it
 * needs, plus the status projection and the dependency bundle the composition
 * root fills in. The real components (ChurnScheduler, Scanner, ChainController,
 * FrontierSweep, RateGovernor, Sentinel) satisfy these by structural
 * subtyping; tests inject plain fakes without touching the concrete classes.
 *
 * `engine.ts` re-exports every name here, so consumers may import from either.
 */

import type { SentinelStatus } from '../adapter/sentinel';
import type { Clock } from '../governors/clock';
import type { AcquireEndReason } from '../rim/follower-acquisition';
import type { Settings } from '../settings/settings';
import type { KnowledgeStore } from '../store/knowledge-store';
import type { FollowRecord } from '../store/types';
import type { DelayManager } from '../timing/delay-manager';
import type { AdvanceResult } from './chain-controller';
import type { ChurnActionOutcome } from './churn-scheduler';
import type { EnginePacing, EngineRate } from './plan-port';
import type { ScanPlan } from './scanner';
import type { SourceFrontier, SourceVisitEndReason } from './source-frontier';
import type { EngineStatus } from './status';

// The plan-facing ports live in `plan-port.ts`; named here so `engine.ts` re-exports them too.
export type { EnginePacing, EngineRate };

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

/** The follow-back sweep's cadence port (see {@link EngineDeps.sweepCadence}). */
export interface SweepCadence {
  /** Due when no plan is consulted (the legacy model): `everyMs` since the last sweep ended. */
  isDue(now: number, everyMs: number): boolean;
  /** A sweep ended (the in-memory kit records it; production's frontier sweep persists its own end). */
  markRun(now: number): void;
  /** The last sweep's end, the plan's check anchor (spec C11); absent in kits that keep the legacy cadence. */
  lastSweepEndedAt?(): number | null;
}

// ---------------------------------------------------------------------------------
// Ports: the narrow, structural slices of each collaborator the Engine needs.
// The real components (ChurnScheduler, Scanner, ChainController, FrontierSweep,
// RateGovernor, Sentinel) satisfy these by structural subtyping;
// tests inject plain fakes without touching the concrete classes.
// ---------------------------------------------------------------------------------

/** The Churn Scheduler's split API: timers / pick one / execute one. */
export interface EngineChurn {
  lastActionOutcome?(): ChurnActionOutcome | null;
  advanceTimers(now: number): void;
  nextDue(now: number, kind?: 'follow' | 'unfollow'): FollowRecord | null;
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

/**
 * The frontier sweep's verb (spec §9.6): one sweep in session or check mode. A step's failure ends that
 * step only, so a sweep always resolves; it persists its own frontiers and its end.
 */
export interface EngineFollowback {
  run(mode: 'session' | 'check', signal: AbortSignal): Promise<unknown>;
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
  ): Promise<'ok' | 'failed' | 'simulated' | 'blocked' | 'reviewed'>;
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
  validateIdentity?: () => Promise<boolean>;
  onProgress?: (phase: string) => void;
  /** The journal's step: settle the oldest due intent with one read (spec §9.8). */
  settleJournal?: () => Promise<{ outcome: 'settled' | 'parked' | 'expired' | 'none' | 'aborted' | 'walled' }>;
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
   * The plan (spec §5.15): the one pacing model. The loop parks exactly where the plan says
   * (sessions, the day done, the rolling hour) and serves the deadline the dispatch armed.
   */
  pacing: EnginePacing;
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
   * persisted): seeds the dedicated timing-noise stream and stable plan-day draws.
   * Test rigs pass zero to keep their draws deterministic.
   */
  installEntropy: number;
  /**
   * The follow-back sweep's cadence: production anchors it on the frontier sweep's persisted end, so
   * the plan's check is due from the last sweep (PRINCIPLES §3); the test kit supplies an in-memory
   * one that starts due, so a fresh Engine's first eligible step catches up.
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

/**
 * Engine runtime (v3 engine-architecture §3) — the conductor.
 *
 * Composes the pure engine components (Churn Scheduler, Scanner, Chain Controller,
 * Follow-back Watcher) and the rim ports (FollowerAcquisition, Sentinel) into one
 * safe, paced, interruptible running system. The Engine is the ONLY place that owns
 * wall-clock time: every wait goes through one interruptible `sleep`, and every
 * Instagram action is separated from the next by a paced delay (`rate.nextDelayMs`).
 *
 * One loop iteration ({@link Engine.stepOnce}) performs AT MOST ONE major thing, in
 * a fixed precedence (§3.1) — which makes bursts structurally impossible and lets
 * `stop()`/`pause()` interrupt *between* actions instantly (E1).
 *
 * Everything is injected (ports, clock, sleep), so the whole runtime is unit-testable
 * with fakes: no browser, no wall-clock, no real timers.
 */

import type { SentinelStatus } from '../adapter/sentinel';
import type { Clock } from '../governors/clock';
import type { FollowerAcquisition } from '../rim/types';
import type { Settings } from '../settings/settings';
import type { KnowledgeStore } from '../store/knowledge-store';
import type { FollowRecord } from '../store/types';
import {
  ENGINE as ENGINE_TIMING,
  PATTERN,
  PRUNE as PRUNE_TIMING,
  RECOVERY as RECOVERY_TIMING,
} from '../timing/config';
import { DelayManager, type WaitResult } from '../timing/delay-manager';
import { clamp, logNormal } from '../timing/distributions';
import {
  boundarySeedKey,
  cadenceFactor,
  jitterBoundary,
  mulberry32,
  noisify,
  type WaitClass,
} from '../timing/noise';
import {
  type DelayPolicy,
  type Rng,
  type SleepFn,
  TIMED_OUT,
  sleep as timingSleep,
  uniform,
  withTimeout,
} from '../timing/primitives';
import { startOfLocalDay } from '../timing/units';
import * as log from '../utils/logger';
import type { AdvanceResult } from './chain-controller';
import type { ChurnActionOutcome } from './churn-scheduler';
import { type FailureKind, RecoverySupervisor } from './recovery';
import type { ScanPlan } from './scanner';

// ---------------------------------------------------------------------------------
// Ports: the narrow, structural slices of each collaborator the Engine needs.
// The real components (ChurnScheduler, Scanner, ChainController, FollowbackWatcher,
// RateGovernor, Sentinel) satisfy these by structural subtyping;
// tests inject plain fakes without touching the concrete classes.
// ---------------------------------------------------------------------------------

/** The Churn Scheduler's split API (§3.2): timers / pick one / execute one. */
export interface EngineChurn {
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
   * Consecutive `'failed'` outcomes across records — the systemic-breakage
   * signal (broken input pipeline, drifted selector). Optional so plain test
   * fakes keep working; when present the engine enters the recovery ladder
   * once it crosses {@link ACTIONS_FAILING_HALT} instead of burning the queue.
   */
  consecutiveFailureCount?(): number;
  /** Clear the failure window (the engine calls this when the ladder enters). */
  resetConsecutiveFailures?(): void;
  /** Consecutive `'blocked'` outcomes across records — the rate-wall streak. */
  consecutiveBlockedCount?(): number;
  /** Clear the blocked window (the engine calls this when the ladder enters). */
  resetConsecutiveBlocked?(): void;
  /** How many of the current failure window's fails were drift-caused. */
  consecutiveDriftFailureCount?(): number;
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
  advance(currentTargetPk: string): Promise<AdvanceResult>;
}

/** The Follow-back Watcher's single verb: one request-bounded sweep. */
export interface EngineFollowback {
  check(): Promise<{ detected: string[] }>;
}

/**
 * The profile-enricher port (R1): fetch profile stats (follower/following counts)
 * for the given usernames and write them into the store as observations, returning
 * how many profiles were successfully enriched. The real `ProfileEnricher` (rim)
 * is sentinel-gated and paced internally; tests inject a fake.
 */
export interface EngineEnricher {
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
 * The woven prune-unfollow feed (§5.2/§6.1): the growth loop drains prune candidates
 * from the completed census as ONE interleaved action stream (so unfollows never burst
 * and the follow→unfollow batch-correlation signal is defeated). Implemented by the
 * PruneEngine over its scanned candidate set; only consulted in the organic model with
 * `Settings.weaveEnabled`. `nextCandidate` is pure selection (live whitelist + live-graph
 * follows-us guard + freshness + daily cap; consumes only leading skips) and mutates
 * nothing actionable until `executeUnfollow`, which does the DOM unfollow + ledger row +
 * edge reconcile and returns the outcome.
 */
export interface EngineUnfollowFeed {
  nextCandidate(now: number): { pk: string; username: string } | null;
  executeUnfollow(
    cand: { pk: string; username: string },
    now: number,
  ): Promise<'ok' | 'failed' | 'simulated' | 'blocked' | 'skipped'>;
  atDailyCap(now: number): boolean;
}

/** The Sentinel slice: classify the tab before anything else each iteration. */
export interface EngineSentinel {
  check(): Promise<SentinelStatus>;
}

export type { SleepFn } from '../timing/primitives';
// Back-compat re-exports: the canonical interruptible sleep + its signature now
// live in timing/primitives (E1 — nothing in the Engine can wait un-interruptibly).
export { sleep as defaultSleep } from '../timing/primitives';

/** How long an iteration idles when nothing is due yet (§3.1, final branch). */
export const ENGINE_IDLE_MS = ENGINE_TIMING.IDLE_MS;

/** f10: bounds of the short jittered pause ending every branch that issued IG traffic. */
export const REFILL_PACING_MIN_MS = ENGINE_TIMING.REFILL_PACING_MIN_MS;
export const REFILL_PACING_MAX_MS = ENGINE_TIMING.REFILL_PACING_MAX_MS;

/** R1: at most this many candidate usernames are enriched per pass. */
export const ENRICH_BATCH_SIZE = 20;

/**
 * R1.5: at most this many enrichment passes per refill cycle. Once exhausted, the
 * cycle plans with whatever counts it has; a plan that enqueues nothing then marks
 * the target exhausted — enrichment can never spin unboundedly on a dry target.
 *
 * Sized with {@link ENRICH_BATCH_SIZE} so a cycle profiles up to ~80 candidates
 * before its final plan: the Scanner then picks a plan's worth from a real
 * pool instead of rubber-stamping a shallow batch of whatever ratios arrived.
 */
export const MAX_ENRICH_PASSES_PER_CYCLE = 4;

/**
 * Step 7 skips acquisition while the raw not-yet-acted-on pool already holds
 * this many PLANS' worth of prospects (pool ≥ factor × dailyPlanSize) —
 * scraping more pages while un-scored candidates sit locally is request waste,
 * but the bar is a multiple of a plan so selection never runs pool-starved.
 */
export const ACQUIRE_SKIP_POOL_FACTOR = 4;

/**
 * Consecutive failed actions (ACROSS records) that ENTER the recovery ladder
 * from a standing start. One dead account produces at most `maxRetries + 1`
 * (= 4) fails before abandoning; a systemic breakage — input events not
 * landing, a rate wall, selector drift the health checks missed — fails
 * everything identically. Two full records' worth means the second candidate
 * in a row burned out, at which point continuing spends the daily ledger
 * budget clicking into the void (the 2026-08-13 overnight run abandoned ~20
 * candidates that way). While the ladder is PROBING after a served hold, the
 * re-entry threshold drops to `RECOVERY.REENTRY_FAILS`.
 */
export const ACTIONS_FAILING_HALT = 8;

// ---------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------

export type EngineState = 'idle' | 'running' | 'paused' | 'halted';

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

/**
 * Why a LONG park is holding the loop — the closed set of reasons a running
 * engine deliberately waits minutes-to-hours between steps. Surfaced as
 * {@link EngineStatus.parkReason} so a parked engine is distinguishable from
 * an idle one for the whole hold (§2 — the UI mirrors the state, live).
 */
export type EngineParkReason =
  | 'active-hours'
  | 'daily-ceiling'
  | 'session'
  | 'velocity'
  | 'enrich-backoff'
  | 'recovery';

/**
 * Every DelayManager key the Engine waits under — the closed set the noise
 * registry classifies. Adding an `engineWait` call site with a new key REQUIRES
 * adding it here and to {@link ENGINE_WAIT_CLASS}, or tsc fails.
 */
export type EngineWaitKey =
  | 'engine:active-hours-park'
  | 'engine:daily-ceiling-park'
  | 'engine:session-park'
  | 'engine:velocity-park'
  | 'engine:enrich-backoff'
  | 'engine:prune-park'
  | 'engine:blocked-park'
  | 'engine:idle'
  | 'engine:transient-backoff'
  | 'engine:action-delay'
  | 'engine:refill-pacing'
  | 'engine:recovery-hold';

/**
 * The per-key noise classification (timing/noise.ts) `engineWait` applies —
 * the deterministic-scheduling fix. 'exact' keys already draw their own jitter
 * at the call site (paced action delay, refill band, session/velocity parks,
 * the recovery hold's clamped log-normal) — noising them again would be a
 * double-jitter bug. The `satisfies` makes an unclassified new key a tsc error.
 */
export const ENGINE_WAIT_CLASS = {
  'engine:active-hours-park': 'daily-boundary',
  'engine:daily-ceiling-park': 'daily-boundary',
  'engine:enrich-backoff': 'retry-backoff',
  'engine:prune-park': 'retry-backoff',
  'engine:blocked-park': 'retry-backoff',
  'engine:idle': 'local-beat',
  'engine:transient-backoff': 'local-beat',
  'engine:action-delay': 'exact',
  'engine:refill-pacing': 'exact',
  'engine:session-park': 'exact',
  'engine:velocity-park': 'exact',
  'engine:recovery-hold': 'exact',
} as const satisfies Record<EngineWaitKey, WaitClass>;

/**
 * DelayManager keys whose waits are LONG parks the status must surface. The
 * short operational waits (idle beat, refill pacing, transient backoff, the
 * brief prune-park retry) stay unlisted — they are step-scale, not hold-scale;
 * the paced action delay surfaces separately through `nextActionAt`.
 */
const PARK_REASON_BY_KEY = new Map<string, EngineParkReason>([
  ['engine:active-hours-park', 'active-hours'],
  ['engine:daily-ceiling-park', 'daily-ceiling'],
  ['engine:session-park', 'session'],
  ['engine:velocity-park', 'velocity'],
  ['engine:enrich-backoff', 'enrich-backoff'],
  ['engine:recovery-hold', 'recovery'],
]);

/** Status projection over the store + governors + Engine state (§5). */
export interface EngineStatus {
  state: EngineState;
  currentTargetPk: string | null;
  currentTargetUsername: string | null;
  chainIndex: number | null;
  actionsToday: number;
  remainingToday: number;
  /** Today's planned volume (the fluctuating per-cycle stop, under the rate). */
  plannedToday: number;
  atHardCeiling: boolean;
  queued: number;
  pendingFollowback: number;
  followedBackHeld: number;
  unfollowDue: number;
  lastStep: StepResult | null;
  lastSentinel: SentinelStatus | null;
  lastActionAt: number | null;
  sessionStartedAt: number | null;
  /** Deadline (epoch ms) of the in-flight paced action delay, else null. */
  nextActionAt: number | null;
  /**
   * Deadline (epoch ms) of the in-flight LONG park (outside active hours,
   * today's plan done, between sessions, velocity hold, enrich backoff).
   * Registered — and pushed — the moment the park starts, BEFORE it is
   * awaited, and null once the wait resolves. Optional only because the
   * pre-build status literal predates it; the Engine always sets it.
   */
  parkedUntil?: number | null;
  /** Why the engine is parked while `parkedUntil` is set; null otherwise. */
  parkReason?: EngineParkReason | null;
  netToday: number;
  /** Whether the connectivity monitor last reported the internet reachable. */
  online: boolean;
  /** Why the engine halted (`sentinel:*`, `chain-exhausted`, `recovery-exhausted`,
   *  …) while `state` is `'halted'`; null otherwise. */
  haltReason: string | null;
  /**
   * The recovery ladder's live posture (§2): `holding` while a long backoff is
   * armed (`resumeAt` is its absolute deadline), `probing` while the next real
   * actions decide whether the wall lifted. Null when the ladder is inactive.
   */
  recovery: {
    phase: 'holding' | 'probing';
    attempt: number;
    maxAttempts: number;
    resumeAt: number | null;
  } | null;
  /** Organic-pacing session status (null in legacy mode). */
  pacing: {
    sessionOpen: boolean;
    sessionEndsAt: number | null;
    nextSessionAt: number | null;
    sessionsToday: number;
    dailyTarget: number;
  } | null;
}

/** Everything the Engine composes, already constructed (composition root's job). */
export interface EngineDeps {
  store: KnowledgeStore;
  clock: Clock;
  rate: EngineRate;
  sentinel: EngineSentinel;
  churn: EngineChurn;
  scanner: EngineScanner;
  chain: EngineChain;
  followback: EngineFollowback;
  acquisition: FollowerAcquisition;
  /**
   * R1: the profile enricher the pool-refill step uses to fetch counts for
   * candidates the followers-list left count-less. The composition root injects
   * the real adapter-backed `ProfileEnricher`; when absent (e.g. a wiring that
   * predates enrichment) a warn-and-noop fallback is used — the refill guard
   * still terminates, the target is just planned with whatever counts exist.
   */
  enricher?: EngineEnricher;
  settings: Settings;
  /**
   * The organic pacing planner (§macro-timing-realism). When injected, the loop
   * runs the session-driven model (circadian sessions, log-normal gaps, daily-volume
   * distribution) and persists its snapshot to store meta; when absent, the legacy
   * active-hours + operating-rate metronome runs unchanged. The composition root
   * injects it only when `Settings.pacingModel === 'organic'`.
   */
  pacing?: EnginePacing;
  /**
   * The woven prune-unfollow feed (§5.2). Injected by the composition root (the
   * PruneEngine); the loop weaves its candidates into the action stream only in the
   * organic model when `Settings.weaveEnabled`. Absent → no woven unfollows.
   */
  unfollowFeed?: EngineUnfollowFeed;
  /** Injected sleep; defaults to a real interruptible setTimeout. */
  sleep?: SleepFn;
  /**
   * The shared wait owner. When absent the Engine constructs a private one over
   * its own clock/sleep/rng — existing tests that inject `sleep` keep working.
   * The composition root injects ONE DelayManager shared with the prune engine
   * (keys are namespaced `engine:` / `prune:`).
   */
  delays?: DelayManager;
  /** Randomness for the jittered pacing draw; injectable for deterministic tests. */
  rng?: () => number;
  /**
   * Per-install noise entropy (store meta `install_entropy`, drawn once and
   * persisted): seeds the DEDICATED timing-noise rng and the restart-stable
   * daily-boundary jitter, so no two installs share wake offsets while one
   * install's offset survives a mid-park relaunch (§3). Absent (plain test
   * fakes) → 0, keeping every noise draw deterministic under a fake clock.
   */
  installEntropy?: number;
  /**
   * Due-by-timestamp cadence for the follow-back sweep. The composition root
   * injects a persisted cadence (Settings.sweepLastRunAt) so the 4h rhythm
   * survives restarts; the default is the old in-memory behavior (last run
   * starts at 0 → a fresh Engine's first eligible step performs a cheap
   * catch-up sweep, then the configured cadence applies).
   */
  sweepCadence?: SweepCadence;
  /**
   * The tab-diagnostics port the recovery ladder consults on entry (see
   * {@link EngineTabDiagnostics}). Absent → the tab is presumed healthy and
   * every ladder entry takes the rate-limit hold path.
   */
  tabDiag?: EngineTabDiagnostics;
  /** Called with a fresh status projection after every step and lifecycle change. */
  onStatus?: (s: EngineStatus) => void;
  /** Called exactly once per halt with the reason (e.g. `sentinel:challenge`). */
  onHalt?: (reason: string) => void;
}

const MS_PER_HOUR = 3_600_000;

/** The follow-back sweep's due-by-timestamp port (see {@link EngineDeps.sweepCadence}). */
export interface SweepCadence {
  isDue(now: number, everyMs: number): boolean;
  markRun(now: number): void;
}

interface CurrentTarget {
  pk: string;
  username: string | null;
}

// ---------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------

export class Engine {
  private readonly deps: EngineDeps;
  /** The shared wait owner: every Engine wait is a named `engine:*` entry here. */
  private readonly delays: DelayManager;
  /** Live settings — swapped by {@link applySettings} when the user saves changes. */
  private settings: Settings;

  private engineState: EngineState = 'idle';
  /** Epoch ms of the current run's idle→running transition; null when not running. */
  private sessionStartedAt: number | null = null;
  private runAbort = new AbortController();
  /** Resolvers parked by the run loop while paused; released by resume()/stop(). */
  private resumeWaiters: Array<() => void> = [];
  /**
   * True while the run loop is actually PARKED at the pause gate — i.e. the
   * in-flight step has finished and the loop is waiting in `waitForResume`, so
   * nothing is driving the tab. Distinct from `engineState === 'paused'`, which
   * flips the instant `pause()` is called even if a step is still mid-flight.
   * The prune hand-off ({@link awaitParked}) waits for THIS, so a prune never
   * touches the shared tab while a growth step is still running.
   */
  private parkedNow = false;
  /** One-shot resolvers awaiting the loop reaching the pause gate (see {@link awaitParked}). */
  private parkAckWaiters: Array<() => void> = [];
  /** Last connectivity reported via {@link setOnline}; the loop parks while false. */
  private online = true;
  /** Resolvers parked by the run loop while offline; released by setOnline(true)/pause()/stop(). */
  private onlineWaiters: Array<() => void> = [];

  private current: CurrentTarget | null = null;
  /**
   * Refill-cycle guards (R1.5). A "cycle" is one bounded attempt to refill the
   * current target's queue: at most ONE acquisition, at most
   * {@link MAX_ENRICH_PASSES_PER_CYCLE} enrichment passes, then a final plan.
   * All three reset when the chain advances (new target) or when a plan actually
   * enqueues candidates (real forward progress, so a later refill is allowed).
   *
   * - `acquiredThisCycle`: `acquisition.acquire` has been attempted this cycle.
   * - `enrichPassesThisCycle`: how many enrichment passes ran this cycle.
   * - `targetExhausted`: the cycle's FINAL plan enqueued nothing — there is no
   *   scorable candidate left (un-enriched ones were given their bounded chance),
   *   so step 7 must not fire again and step 9 (chain advance) becomes reachable.
   *
   * Together these make step 7's IG traffic per cycle provably bounded
   * (1 acquire + K enrich passes), and a new cycle requires a plan that enqueued
   * > 0 — so the loop can never hammer Instagram on a dry/rejected target.
   */
  private acquiredThisCycle = false;
  private enrichPassesThisCycle = 0;
  /** Profiles successfully enriched this cycle — distinguishes "pool being
   *  worked through" (keep cycling promptly) from "enrichment walled" (long
   *  backoff, target NOT exhausted). */
  private enrichedThisCycle = 0;
  private targetExhausted = false;

  /**
   * Sweep cadence port. Injected (persisted) by the composition root; the
   * default preserves the old behavior — in-memory, starting due, so a fresh
   * Engine's first eligible step performs a cheap catch-up sweep.
   */
  private readonly sweepCadence: SweepCadence;

  /**
   * The in-flight LONG park ({@link PARK_REASON_BY_KEY}): why the loop is
   * deliberately holding and until when. Set synchronously as the park's wait
   * registers — with a status emit BEFORE the await, so the renderer shows the
   * hold the moment it starts (a fresh start at 23:00 must not read as idle
   * for nine hours) — and cleared when the wait resolves, completed or
   * interrupted.
   */
  private park: { reason: EngineParkReason; until: number } | null = null;

  private lastStep: StepResult | null = null;
  private lastSentinel: SentinelStatus | null = null;
  private lastActionAt: number | null = null;
  /** Why the engine last halted; cleared on the next `start()`. */
  private haltReason: string | null = null;
  /**
   * The most recent halt, kept STICKY across restarts (unlike {@link haltReason},
   * which a fresh start clears): the scheduled-prune cool-down (amendment A)
   * must still see a rate-limit halt after the user restarts growth.
   */
  private lastHalt: { reason: string; at: number } | null = null;

  /**
   * The classified, durable recovery ladder (see {@link RecoverySupervisor}):
   * entered instead of the old terminal `actions-failing` halt, hydrated from
   * store meta at construction so a relaunch mid-hold serves the remainder.
   */
  private readonly recovery: RecoverySupervisor;

  /**
   * Consecutive WALLED enrichment cycles (a refill whose enrichment delivered
   * nothing while un-enriched candidates remain). The first two take the flat
   * enrich-backoff park; the third enters the recovery ladder — a read-side
   * wall that survives two long backoffs is the same rate wall the action side
   * ladders on. Reset by any cycle that makes real progress or a target change.
   */
  private walledCycles = 0;

  /**
   * Deadline (epoch ms) of the inter-action paced delay that is still OWED.
   * Armed the moment an action completes; disarmed only when the delay fully
   * elapses. A pause/offline hold aborts the in-flight wait WITHOUT disarming,
   * so on resume step 8 waits out the remainder before the next action instead
   * of firing immediately (the "resume acts instantly" bug).
   *
   * DURABLE: mirrored into the store (meta `action_delay_deadline_at`) on every
   * change and hydrated at construction, so a stop — or a full app quit +
   * relaunch — resumes the remaining wait exactly like pause/resume does. Being
   * an absolute deadline, time spent closed counts: relaunching after it passed
   * acts immediately. `null` when no delay is owed.
   */
  private actionDelayDeadline: number | null = null;

  /** The injected enricher, or the warn-and-noop fallback (see {@link EngineDeps}). */
  private readonly enricher: EngineEnricher;

  /** The organic pacing planner, or undefined in legacy mode (see {@link EngineDeps.pacing}). */
  private readonly pacing?: EnginePacing;

  /** The woven prune-unfollow feed, or undefined when prune weaving is off. */
  private readonly unfollowFeed?: EngineUnfollowFeed;

  /** Randomness for the weave interleave draw; injectable for deterministic tests. */
  private readonly rng: () => number;

  /** Per-install noise entropy (see {@link EngineDeps.installEntropy}). */
  private readonly installEntropy: number;

  /**
   * The DEDICATED timing-noise rng — NEVER {@link rng}: the seeded engine rng
   * feeds the weave interleave draw (and injected DelayManagers sample 'exact'
   * policies with their own), so drawing noise from it would shift every
   * downstream draw and churn seeded tests. Seeded from the install entropy ⊕
   * construction time: per-install, fresh per run, deterministic under a fake
   * clock. Restart-STABLE draws (daily boundaries) bypass this via
   * {@link jitterBoundary}'s own seed material instead.
   */
  private readonly noiseRng: Rng;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.delays =
      deps.delays ??
      new DelayManager({ clock: deps.clock, rng: deps.rng, sleep: deps.sleep ?? timingSleep });
    this.installEntropy = deps.installEntropy ?? 0;
    this.noiseRng = mulberry32(((this.installEntropy >>> 0) ^ (deps.clock.now() & 0xffffffff)) >>> 0);
    this.sweepCadence =
      deps.sweepCadence ??
      ((): SweepCadence => {
        // In-memory fallback (starts due, catch-up sweep on the first eligible
        // step) — with the same watcher-cadence factor treatment the persisted
        // cadence gets: each completed sweep redraws a bounded interval factor
        // so the fallback never ticks on a bare hourly grid either.
        let last = 0;
        let factor = 1;
        return {
          isDue: (now, everyMs) => now - last >= everyMs * factor,
          markRun: (now) => {
            last = now;
            factor = cadenceFactor(this.noiseRng);
          },
        };
      })();
    this.settings = deps.settings;
    this.pacing = deps.pacing;
    this.unfollowFeed = deps.unfollowFeed;
    this.rng = deps.rng ?? Math.random;
    // Hydrate the owed inter-action delay from the store so an app relaunch
    // resumes the remaining wait rather than acting on the first step.
    this.actionDelayDeadline = deps.store.getActionDelayDeadline();
    // The recovery ladder hydrates its own durable state (store meta
    // `recovery_state`) — a relaunch mid-hold serves the REMAINDER (§3).
    this.recovery = new RecoverySupervisor({
      clock: deps.clock,
      store: deps.store,
      rng: deps.rng,
    });
    this.enricher = deps.enricher ?? {
      enrich: (usernames: string[]): Promise<number> => {
        log.warn('engine: no enricher injected — candidates keep lacking counts', {
          requested: usernames.length,
        });
        return Promise.resolve(0);
      },
    };
  }

  /**
   * Swap the Engine's own settings-derived knobs at runtime (seed, active-hours,
   * follow-back cadence, low-water). The governor/component configs are reloaded
   * separately by the composition root; this only covers what the Engine reads
   * directly. Applied between steps, so an in-flight iteration is never torn.
   */
  applySettings(settings: Settings): void {
    this.settings = settings;
  }

  /** The state as a wide type — sidesteps literal narrowing across awaits. */
  private stateNow(): EngineState {
    return this.engineState;
  }

  // --- Lifecycle -----------------------------------------------------------------

  /**
   * Run the loop until stopped or halted. Resolves when the loop exits — `stop()`
   * aborts any in-flight sleep so resolution is prompt (E1). Restartable from
   * `idle` or `halted`; a second concurrent `start()` is a no-op.
   *
   * R2 — exactly one concurrent loop: each run captures its own AbortController as
   * a GENERATION TOKEN, and the loop condition checks THAT token's `signal.aborted`
   * (by identity), never the current `this.runAbort`. A `stop()`+`start()` around an
   * in-flight step creates a fresh token for the new loop; the stale loop, waking
   * from its await, sees its OWN token aborted and exits without touching the new
   * run's state — two loops can never proceed together. The STEP body carries the
   * same token (see stepOnce/`superseded`), so a stale step waking from a
   * non-signal-linked await bails before re-driving pacing or deadlines.
   */
  async start(): Promise<void> {
    if (this.engineState === 'running' || this.engineState === 'paused') return;
    this.runAbort = new AbortController();
    const token = this.runAbort; // this run's generation token (R2)
    this.engineState = 'running';
    // User ack: a manual Start from a RECOVERY halt clears the persisted ladder
    // and the streak counters — the user has looked at the session and chosen
    // to try again. A ladder that is merely mid-hold/probing (a stop, or an app
    // relaunch during a hold) is deliberately KEPT: stop/start is not a way
    // around a rate-wall backoff, exactly like the inter-action deadline.
    const recoveryHalt =
      this.haltReason === 'recovery-exhausted' || this.haltReason === 'adapter-drift';
    if (recoveryHalt || this.recovery.phase() === 'exhausted') {
      this.recovery.reset();
      this.deps.churn.resetConsecutiveFailures?.();
      this.deps.churn.resetConsecutiveBlocked?.();
      log.info('engine: recovery ladder cleared by manual start (user ack)');
    }
    this.haltReason = null; // a fresh start clears the previous halt's cause
    this.sessionStartedAt = this.deps.clock.now();
    // Legacy-queue hygiene: score any queued records that predate score
    // persistence so nextDue (and the queue display) rank instead of falling
    // back to pk order. Store-only, idempotent, no IG traffic.
    this.deps.scanner.rescoreQueued?.();
    log.info('engine: started');
    this.emitStatus();

    try {
      for (;;) {
        // The identity check: a restart replaced `this.runAbort`, but THIS loop
        // lives and dies with its own token.
        if (token.signal.aborted) break;
        // Read through a method: control commands mutate the state concurrently,
        // so literal narrowing from the assignment above must not apply here.
        const state = this.stateNow();
        if (state === 'paused') {
          await this.waitForResume();
          continue;
        }
        // Offline hold: paused takes precedence (checked above); a running loop
        // with no connectivity parks between steps until back online (or a
        // pause/stop wakes it to re-evaluate).
        if (!this.online) {
          await this.waitForOnline();
          continue;
        }
        if (state !== 'running') break;
        const result = await this.stepOnce();
        if (result === 'aborted' || result === 'halted') break;
      }
    } finally {
      // Only the CURRENT generation may reset the engine state — a stale loop
      // exiting after a restart must not clobber the new run's 'running'.
      if (token === this.runAbort) {
        const state = this.stateNow();
        if (state === 'running' || state === 'paused') {
          this.engineState = 'idle';
        }
        // No loop is running past this point, whatever the terminal state —
        // a HALTED engine must not keep advertising a live session.
        this.sessionStartedAt = null;
      }
      log.info('engine: loop ended', { state: this.engineState });
      this.emitStatus();
    }
  }

  /** Pause between actions: aborts the in-flight sleep; the loop parks until resume(). */
  pause(): void {
    if (this.engineState !== 'running') return;
    this.engineState = 'paused';
    this.delays.cancelAll('engine:');
    // A loop parked for offline must wake to re-evaluate and park as paused.
    this.releaseOnlineWaiters();
    log.info('engine: paused');
    this.emitStatus();
  }

  /** Resume a paused Engine. */
  resume(): void {
    if (this.engineState !== 'paused') return;
    this.engineState = 'running';
    this.releaseResumeWaiters();
    log.info('engine: resumed');
    this.emitStatus();
  }

  /**
   * Stop: abort the run signal AND any in-flight sleep, release a paused loop, and
   * let `start()` resolve cleanly (E1). A halted Engine keeps its `halted` state
   * (the reason stays visible); otherwise the Engine returns to `idle`.
   */
  stop(): void {
    this.runAbort.abort();
    this.delays.cancelAll('engine:');
    // The owed inter-action delay deliberately SURVIVES a stop (and, being
    // store-mirrored, an app quit): a later start() serves the remainder before
    // its first action — stop/start is not a way around the pacing.
    if (this.engineState !== 'halted') this.engineState = 'idle';
    this.sessionStartedAt = null;
    // Forget the in-memory target: the next start() re-adopts the store's
    // ACTIVE front, so store-side chain edits between runs (restart-from-seed
    // retiring targets) take effect instead of resuming a retired target.
    this.current = null;
    this.releaseResumeWaiters();
    // A loop parked for offline must wake to observe the abort and exit cleanly.
    this.releaseOnlineWaiters();
    log.info('engine: stopped');
    this.emitStatus();
  }

  /**
   * Report connectivity (wired to the main-process ConnectivityMonitor). Going
   * OFFLINE aborts the in-flight sleep so the loop re-evaluates promptly and parks
   * (no `stepOnce` runs while offline); coming back ONLINE releases the parked
   * loop. Does not touch `sessionStartedAt` — an offline hold is not a stop.
   */
  setOnline(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    if (!online) {
      this.delays.cancelAll('engine:');
    } else {
      this.releaseOnlineWaiters();
    }
    log.info(online ? 'engine: back online' : 'engine: offline, holding', { online });
    this.emitStatus();
  }

  status(): EngineStatus {
    const { store, rate, clock } = this.deps;
    const chainIndex =
      this.current === null ? null : (store.getTarget(this.current.pk)?.chainIndex ?? null);
    const startOfToday = startOfLocalDay(clock.now());
    const pnow = clock.now();
    const pacing = this.pacing
      ? {
          sessionOpen: this.pacing.isSessionOpen(pnow),
          sessionEndsAt: this.pacing.sessionEndsAt(pnow),
          nextSessionAt: this.pacing.isSessionOpen(pnow)
            ? null
            : this.pacing.nextSessionStartAt(pnow),
          sessionsToday: this.pacing.sessionsToday(pnow),
          dailyTarget: this.pacing.dailyTarget(pnow),
        }
      : null;
    return {
      state: this.engineState,
      currentTargetPk: this.current?.pk ?? null,
      currentTargetUsername: this.current?.username ?? null,
      chainIndex,
      actionsToday: rate.actionsToday(),
      remainingToday: rate.remainingToday(),
      plannedToday: rate.plannedToday(),
      atHardCeiling: rate.atHardCeiling(),
      queued: store.followRecordsByState('queued').length,
      pendingFollowback: store.followRecordsByState('pending_followback').length,
      followedBackHeld: store.followRecordsByState('followed_back').length,
      unfollowDue: store.followRecordsByState('unfollow_queued').length,
      lastStep: this.lastStep,
      lastSentinel: this.lastSentinel,
      lastActionAt: this.lastActionAt,
      sessionStartedAt: this.sessionStartedAt,
      // The live wait's deadline when one is pending; otherwise the OWED
      // deadline a pause/offline hold interrupted (so the countdown survives a
      // hold and reflects the remainder that will be served on resume).
      nextActionAt:
        this.delays.nextDeadline('engine:action-delay') ?? this.actionDelayDeadline,
      parkedUntil: this.park?.until ?? null,
      parkReason: this.park?.reason ?? null,
      netToday: store.netFollowersSince(startOfToday),
      online: this.online,
      haltReason: this.engineState === 'halted' ? this.haltReason : null,
      recovery: this.recoveryProjection(),
      pacing,
    };
  }

  /** The ladder's status slice (see {@link EngineStatus.recovery}). */
  private recoveryProjection(): EngineStatus['recovery'] {
    const phase = this.recovery.phase();
    if (phase === 'holding') {
      return {
        phase: 'holding',
        attempt: this.recovery.attemptNow(),
        maxAttempts: this.recovery.maxAttempts(),
        resumeAt: this.recovery.holdDeadline(),
      };
    }
    if (phase === 'probing') {
      return {
        phase: 'probing',
        attempt: this.recovery.attemptNow(),
        maxAttempts: this.recovery.maxAttempts(),
        resumeAt: null,
      };
    }
    return null;
  }

  // --- The loop body ---------------------------------------------------------------

  /**
   * ONE loop iteration — the unit tests drive. Performs at most ONE major thing,
   * in the §3.1 precedence:
   *
   *  1. aborted/stopped → `'aborted'`.
   *  2. Sentinel non-`ok` → halt (`sentinel:<status>`) → `'halted'`.
   *  3. Outside active hours → sleep until the window opens → `'waited-active-hours'`.
   *  4. At the hard ceiling → sleep until local midnight → `'waited-ceiling'`.
   *  5. `churn.advanceTimers(now)` — cheap, no IG traffic; always runs, then the
   *     step CONTINUES (this is not the step's one major thing).
   *     (Current-target resolution happens here too: adopt the active store target,
   *     or bootstrap the seed — the latter costs the step, returning `'acquired'`.)
   *  6. Follow-back sweep due → `followback.check()`, paced → `'swept-followback'`.
   *  7. Candidate pool low (and target not exhausted) → one bounded refill-cycle
   *     slice: acquire once / enrich count-less candidates (capped) / plan — every
   *     IG-traffic path paced → `'acquired'` (see {@link Engine.refillPool}).
   *     Otherwise a due record → `churn.execute` then sleep `rate.nextDelayMs()` —
   *     THE paced delay between actions → `'acted'`.
   *  9. Target exhausted (refill cycle closed on an empty plan, queue drained) →
   *     `chain.advance`; adopt the next target → `'advanced-chain'`, or halt
   *     (`chain-exhausted`) → `'halted'`.
   * 10. Nothing due → short idle sleep → `'idle'`.
   *
   * Emits `onStatus` after every step, whatever the branch.
   */
  async stepOnce(): Promise<StepResult> {
    // R2 — the step body carries its OWN generation token: a stop()+start()
    // around a non-signal-linked await (churn.execute / the woven unfollow)
    // must not let the stale step resume against the NEW runAbort, re-drive
    // pacing, or overwrite the new run's durable deadline (see step 8b).
    const token = this.runAbort;
    let result: StepResult;
    try {
      result = await this.step(token);
    } catch (err) {
      // f9 — per-step resilience: a transient rejection (a flaky `evaluate`, a
      // navigation race — including the bare `sentinel.check()` itself) must not
      // silently drop the whole loop. Log, back off one idle beat, and retry on
      // the next iteration. Halting is reserved for a VERIFIED block, which the
      // Sentinel reports as a non-'ok' status (step 2), never as a rejection.
      log.warn('engine: step failed transiently, treating as idle', { error: String(err) });
      await this.engineWait('engine:transient-backoff', ENGINE_IDLE_MS);
      result = 'idle';
    }
    this.lastStep = result;
    this.emitStatus();
    // Durable pacing snapshot (§3): persist after every step so a relaunch resumes the
    // current day plan, owed within-session state, and the trailing-hour ring exactly.
    // Only the CURRENT generation persists — a superseded step's snapshot is stale.
    if (token === this.runAbort && this.pacing?.serialize !== undefined) {
      this.deps.store.setPacingState(JSON.stringify(this.pacing.serialize()));
    }
    return result;
  }

  /** Whether `token`'s generation has been superseded (stop()/restart) — the
   *  step must then bail without mutating pacing or durable deadlines. */
  private superseded(token: AbortController): boolean {
    return token !== this.runAbort || token.signal.aborted;
  }

  private async step(token: AbortController): Promise<StepResult> {
    // 1. Stopped or halted: never touch anything.
    if (this.superseded(token) || this.engineState === 'halted') return 'aborted';

    // 2. Sentinel gate — the hard safety stop, checked before anything else.
    //    AUTH states (challenge / logged-out) stay terminal exactly as before:
    //    only the user can repair the session. 'action-blocked' is a definitive
    //    RATE-LIMIT signal and enters the recovery ladder instead of halting.
    const sentinelStatus = await this.deps.sentinel.check();
    this.lastSentinel = sentinelStatus;
    if (sentinelStatus === 'challenge' || sentinelStatus === 'logged-out') {
      return this.halt(`sentinel:${sentinelStatus}`);
    }

    // 2b. An armed recovery hold — from this run, an interrupted (paused/
    //     offline/stopped) wait, or a PREVIOUS app launch (the deadline is
    //     absolute and durable, §3) — is served before any other work: the
    //     whole point of the hold is to stay off Instagram.
    if (this.recovery.phase() === 'holding') {
      return this.serveRecoveryHold();
    }

    if (sentinelStatus === 'action-blocked') {
      return this.enterRecovery(token, 'rate-limited');
    }

    const now = this.deps.clock.now();

    if (this.pacing !== undefined) {
      // --- Organic pacing model (SessionPlanner-driven, §macro-timing-realism). ---
      // 3. Hard-ceiling backstop — the only daily cap now; the operating-rate stop is
      //    superseded by the planner's daily-volume distribution (isSessionOpen goes
      //    false once the day's drawn target is spent).
      if (this.deps.rate.atHardCeiling()) {
        await this.engineWait('engine:daily-ceiling-park', this.deps.rate.msUntilCycleReset());
        return 'waited-ceiling';
      }
      // 4. Session gate — park until the next circadian session when none is open
      //    (this subsumes active-hours: overnight intensity tapers to ~0, so no
      //    session is scheduled there). Reads (sweep/refill below) are thereby
      //    session-gated for free.
      this.pacing.advance(now);
      if (!this.pacing.isSessionOpen(now)) {
        await this.engineWait(
          'engine:session-park',
          Math.max(0, this.pacing.nextSessionStartAt(now) - now),
        );
        return 'waited-session';
      }
      // 4b. Velocity backstop (defense-in-depth with the planner's own ring): a
      //     ledger-backed rolling-hour cap that survives even a lost planner snapshot.
      if (this.deps.rate.actionsInLastHour() >= this.settings.hourlyVelocityCap) {
        await this.engineWait(
          'engine:velocity-park',
          clamp(
            logNormal(ENGINE_TIMING.VELOCITY_PARK_MEDIAN_MS, ENGINE_TIMING.VELOCITY_PARK_SIGMA),
            ENGINE_TIMING.VELOCITY_PARK_MIN_MS,
            ENGINE_TIMING.VELOCITY_PARK_MAX_MS,
          ),
        );
        return 'waited-session';
      }
    } else {
      // --- Legacy model (flat active-hours + operating-rate metronome). ---
      // 3. Active-hours gate.
      if (!this.deps.rate.withinActiveHours()) {
        await this.engineWait('engine:active-hours-park', this.msUntilActiveWindow());
        return 'waited-active-hours';
      }
      // 4. Daily-volume gate — the operating rate is the engine's real daily stop;
      //    the hard ceiling is the uncrossable backstop.
      if (this.deps.rate.atHardCeiling() || this.deps.rate.atOperatingRate()) {
        await this.engineWait('engine:daily-ceiling-park', this.deps.rate.msUntilCycleReset());
        return 'waited-ceiling';
      }
    }

    // 5. Timer-driven churn transitions: cheap, no IG traffic, always run.
    this.deps.churn.advanceTimers(now);

    // Current-target resolution (lazy, so `stepOnce` is self-sufficient in tests):
    // adopting an existing active target is free; bootstrapping the seed costs the
    // step (it is an acquisition — real IG traffic).
    if (this.current === null) {
      if (!this.adoptActiveTargetFromStore()) {
        return this.bootstrapSeedTarget();
      }
    }
    const current = this.current;
    if (current === null) return this.halt('no-current-target'); // unreachable guard

    // 6. Follow-back sweep on its slow cadence (IG traffic → paced, f10). The
    //    cadence is persisted by the composition root (Settings.sweepLastRunAt),
    //    so a restart no longer resets the rhythm to sweep-immediately.
    const sweepDueMs = this.settings.followbackSweepHours * MS_PER_HOUR;
    if (this.sweepCadence.isDue(now, sweepDueMs)) {
      await this.deps.followback.check();
      this.sweepCadence.markRun(now);
      await this.pacingSleep();
      return 'swept-followback';
    }

    // 7. Candidate pool low → one bounded slice of the refill cycle (R1): acquire
    //    once → enrich the count-less candidates (capped) → plan. `targetExhausted`
    //    latches when the cycle's FINAL plan enqueues nothing, so this branch can
    //    never fire unboundedly on a dry/rejected target (R1.5).
    const queuedForTarget = this.queuedCountFor(current.pk);
    if (queuedForTarget < this.settings.lowWaterCandidates && !this.targetExhausted) {
      return this.refillPool(current, token);
    }

    // 8. Exactly ONE Instagram action — a growth/lifecycle churn action or, in the
    //    organic model with prune woven in (§5.2), an interleaved prune unfollow drawn
    //    from the same stream. Preceded by any inter-action delay a pause/offline hold
    //    interrupted, so resuming never fires early.
    const due = this.deps.churn.nextDue(now);
    const pruneCand = this.selectPruneCandidate(now);
    const action = this.pickAction(due, pruneCand);
    if (action !== null) {
      // (8a) Pay down an OWED remainder first (armed by a previous action whose
      // delay a pause/offline aborted). Interruptible: a fresh pause during the
      // remainder leaves the deadline armed and parks without acting.
      if (this.actionDelayDeadline !== null) {
        const remaining = this.actionDelayDeadline - now;
        if (remaining > 0) {
          const res = await this.engineWait('engine:action-delay', remaining);
          // Aborted by pause/stop with the remainder still owed: NOTHING was
          // acted on — report 'idle' so lastStep/lastActionAt stay truthful.
          if (!res.completed) return 'idle';
        }
        this.setActionDeadline(null);
      }

      // (8b) The action itself.
      const actAt = this.deps.clock.now();
      let kind: 'follow' | 'unfollow';
      if (action === 'prune') {
        // A woven prune unfollow: the feed owns the ledger row + edge reconcile.
        const status = await (this.unfollowFeed as EngineUnfollowFeed).executeUnfollow(
          pruneCand as { pk: string; username: string },
          actAt,
        );
        // A stop()+start() landed during the await: the new generation owns
        // pacing now — bail before recording, arming, or serving anything.
        if (this.superseded(token)) return 'aborted';
        if (status === 'blocked') {
          // The rim closed before any click: the candidate was NOT consumed. Park
          // briefly and retry it next step (a persistently blocked feed self-suppresses,
          // so growth keeps going rather than the whole engine halting).
          await this.engineWait('engine:prune-park', PRUNE_TIMING.PARK_MS);
          return 'idle';
        }
        if (status === 'skipped') {
          // Bio filter: the candidate was consumed WITHOUT an action — no ledger
          // row, nothing to pace or park; the next step just picks the next thing.
          return 'idle';
        }
        kind = 'unfollow';
      } else {
        const outcome = await this.deps.churn.execute(due as FollowRecord, actAt);
        // A stop()+start() landed during the await: the new generation owns
        // pacing now — the superseded step's owed gap is deliberately dropped
        // rather than allowed to overwrite the new run's deadline.
        if (this.superseded(token)) return 'aborted';
        if (outcome === 'blocked') {
          // Nothing was clicked and the record is untouched. Re-driving the
          // SAME record at full pace hammered the wall invisibly — park
          // briefly instead, and ladder up once the streak proves a wall.
          this.recovery.noteOutcome('rate-limited');
          const blockedStreak = this.deps.churn.consecutiveBlockedCount?.() ?? 0;
          if (blockedStreak >= RECOVERY_TIMING.BLOCKED_STREAK_ENTRY) {
            return this.enterRecovery(token, 'rate-limited');
          }
          log.info('engine: action blocked — short park before the next attempt', {
            blockedStreak,
          });
          await this.engineWait('engine:blocked-park', PRUNE_TIMING.PARK_MS);
          return 'idle';
        }
        // Systemic-breakage breaker: when every action fails identically across
        // records, the problem is the machinery (a rate wall, the input
        // pipeline, drift) — enter the recovery ladder instead of burning the
        // queue on clicks that do nothing. A failure window that is ALL
        // drift-caused carries drift evidence; anything ambiguous is presumed
        // rate-limited (owner directive: waiting is cheap and reversible).
        const failing = this.deps.churn.consecutiveFailureCount?.() ?? 0;
        if (failing >= this.recovery.failingEntryThreshold(ACTIONS_FAILING_HALT)) {
          const driftFails = this.deps.churn.consecutiveDriftFailureCount?.() ?? 0;
          const failKind: FailureKind = driftFails >= failing ? 'drift' : 'rate-limited';
          return this.enterRecovery(token, failKind);
        }
        if (outcome === 'ok' || outcome === 'simulated') {
          // A verified success IS the probe's verdict: the ladder clears.
          this.recovery.noteRecovered();
        }
        kind = (due as FollowRecord).state === 'unfollow_queued' ? 'unfollow' : 'follow';
      }
      this.lastActionAt = actAt;

      // Arm the delay deadline BEFORE waiting: if a pause/stop/quit lands during the
      // action (or the wait), the persisted deadline survives so the next resume — or
      // app launch — serves the remainder. Organic mode draws the within-session gap
      // from the planner (and records the action for its Hawkes + velocity ring); legacy
      // uses the flat paced delay.
      let nextGapMs: number;
      if (this.pacing !== undefined) {
        this.pacing.recordAction(actAt, kind);
        nextGapMs = this.pacing.nextActionGapMs(actAt);
      } else {
        nextGapMs = this.deps.rate.nextDelayMs();
      }
      this.setActionDeadline(actAt + nextGapMs);
      if (this.stateNow() !== 'paused' && !this.superseded(token)) {
        const remaining = (this.actionDelayDeadline ?? 0) - this.deps.clock.now();
        const res = await this.engineWait('engine:action-delay', remaining);
        if (res.completed) this.setActionDeadline(null);
      }
      return 'acted';
    }

    // 9. Target exhausted: nothing queued for it and the refill cycle closed with
    //    an empty plan (every remaining candidate was either scored-and-rejected —
    //    now role='skipped' — or given its bounded enrichment chance) → advance.
    if (queuedForTarget === 0 && this.targetExhausted) {
      const advance = await this.deps.chain.advance(current.pk);
      if (advance.nextTargetPk !== null) {
        const from = current.pk;
        this.adoptTarget(advance.nextTargetPk);
        log.info('engine: advanced chain', {
          from,
          to: advance.nextTargetPk,
          source: advance.source,
        });
        // f10: the next step will typically re-acquire for the new target right
        // away — interpose the jittered pacing pause before it can.
        if (this.queuedCountFor(advance.nextTargetPk) < this.settings.lowWaterCandidates) {
          await this.pacingSleep();
        }
        return 'advanced-chain';
      }
      return this.halt('chain-exhausted');
    }

    // 10. Nothing due yet (records waiting on follow-back/holds): short idle.
    await this.engineWait('engine:idle', ENGINE_IDLE_MS);
    return 'idle';
  }

  // --- Target resolution -------------------------------------------------------

  /**
   * Adopt the store's active target with the highest chainIndex (the front of the
   * chain), if any. Free — no IG traffic. Returns whether a target was adopted.
   */
  private adoptActiveTargetFromStore(): boolean {
    const active = this.deps.store.listTargets().filter((t) => t.status === 'active');
    if (active.length === 0) return false;
    const front = active.reduce((best, t) => {
      const bi = best.chainIndex ?? -1;
      const ti = t.chainIndex ?? -1;
      if (ti !== bi) return ti > bi ? t : best;
      return t.accountPk < best.accountPk ? t : best; // deterministic tie-break
    });
    this.adoptTarget(front.accountPk);
    return true;
  }

  /**
   * First run ever: resolve `settings.seed` to a pk via one acquisition pass, record
   * it as the chain's target #0, and plan its candidates. Costs the step (it IS an
   * acquisition), so it returns `'acquired'` — or halts when the seed is missing or
   * cannot be resolved (there is nothing safe to do without a target).
   */
  private async bootstrapSeedTarget(): Promise<StepResult> {
    const seed = this.settings.seed.trim();
    if (seed === '') return this.halt('seed-missing');

    const { targetPk } = await this.deps.acquisition.acquire(seed);
    if (targetPk === null) return this.halt('seed-unresolved');

    // NEVER silently resurrect a burned-out chain: with no ACTIVE target and
    // the seed already exhausted (a prior chain ran it dry), re-adding it at
    // index 0 would re-acquire, re-exhaust, and corrupt the chain lineage on
    // every restart. Halting keeps the state visible; an explicit
    // restart-from-seed (the Settings action) is the sanctioned way back in.
    if (this.deps.store.getTarget(targetPk)?.status === 'exhausted') {
      return this.halt('chain-exhausted');
    }

    this.deps.store.addTarget({
      accountPk: targetPk,
      source: 'seed',
      status: 'active',
      chainIndex: 0,
    });
    this.current = {
      pk: targetPk,
      username: this.deps.store.getAccount(targetPk)?.username ?? seed,
    };
    this.acquiredThisCycle = true;
    this.enrichPassesThisCycle = 0;
    this.targetExhausted = false;
    const plan = this.deps.scanner.planTarget(targetPk);
    if (plan.queued.length > 0) this.acquiredThisCycle = false;
    log.info('engine: seed target bootstrapped', { seed, targetPk, queued: plan.queued.length });
    await this.pacingSleep(); // f10: the bootstrap IS an acquisition — pace it.
    return 'acquired';
  }

  /** Make `pk` the current target and reset the refill-cycle guards for it. */
  private adoptTarget(pk: string): void {
    this.current = { pk, username: this.deps.store.getAccount(pk)?.username ?? null };
    this.acquiredThisCycle = false;
    this.enrichPassesThisCycle = 0;
    this.enrichedThisCycle = 0;
    this.walledCycles = 0;
    this.targetExhausted = false;
  }

  // --- Pool refill (R1) -------------------------------------------------------------

  /**
   * Step 7's body — ONE bounded slice of the refill cycle per firing:
   *
   *  1. `acquisition.acquire` at most ONCE per cycle (a target whose username is
   *     unknown cannot be scraped; the guard is set anyway so the cycle terminates).
   *  2. Candidates the followers-list left count-less (`enrichment !== 'profiled'`)
   *     get an enrichment pass: up to {@link ENRICH_BATCH_SIZE} usernames, at most
   *     {@link MAX_ENRICH_PASSES_PER_CYCLE} passes per cycle → return; the NEXT
   *     firing sees their counts and plans.
   *  3. Otherwise the cycle closes with a plan. A plan that enqueues candidates
   *     RESETS the guards (real progress, a later refill may run a new cycle); a
   *     plan that enqueues nothing latches `targetExhausted` — planning was final,
   *     step 7 stops firing, and step 9 (chain advance) becomes reachable.
   *
   * Livelock-proof by construction: a cycle spends at most 1 acquisition + K
   * enrichment passes of IG traffic, and only demonstrated progress (queued > 0)
   * can open another cycle. f10: every path that issued IG traffic ends with the
   * short jittered pacing sleep, so no branch hammers back-to-back.
   */
  private async refillPool(current: CurrentTarget, token: AbortController): Promise<StepResult> {
    let issuedTraffic = false;

    // (1) At most one acquisition per cycle — and NONE when the store already
    // holds several plans' worth of raw not-yet-acted-on followers for this
    // target: scraping more pages while un-scored prospects sit locally is
    // pure request waste. The bar is a MULTIPLE of a plan (not one plan) so
    // the Scanner always selects from a deep pool — a bar of exactly one plan
    // starved selection and queued whatever ratios the last shallow batch had.
    if (!this.acquiredThisCycle) {
      this.acquiredThisCycle = true;
      const rawPool = this.deps.store.candidatePksForTarget(current.pk).length;
      if (rawPool >= this.settings.dailyPlanSize * ACQUIRE_SKIP_POOL_FACTOR) {
        log.info('engine: raw pool sufficient, skipping acquisition', {
          pk: current.pk,
          rawPool,
        });
      } else if (current.username === null) {
        log.warn('engine: cannot acquire, target username unknown', { pk: current.pk });
      } else {
        await this.deps.acquisition.acquire(current.username);
        issuedTraffic = true;
      }
    }

    // (2) Select up to a batch of candidate usernames still lacking counts.
    const usernames = this.unenrichedUsernames(current.pk, ENRICH_BATCH_SIZE);

    // (3) Enrich them (bounded per cycle); the next firing scores what came back.
    if (usernames.length > 0 && this.enrichPassesThisCycle < MAX_ENRICH_PASSES_PER_CYCLE) {
      this.enrichPassesThisCycle += 1;
      const enriched = await this.enricher.enrich(usernames);
      this.enrichedThisCycle += enriched;
      issuedTraffic = true;
      log.info('engine: enriched candidates', {
        target: current.pk,
        requested: usernames.length,
        enriched,
        pass: this.enrichPassesThisCycle,
      });
      await this.pacingSleep();
      return 'acquired';
    }

    // (4) Plan — final for this cycle when it enqueues nothing.
    const plan = this.deps.scanner.planTarget(current.pk);
    if (plan.queued.length > 0) {
      this.acquiredThisCycle = false;
      this.enrichPassesThisCycle = 0;
      // Reset with its sibling guards: a stale positive count from THIS cycle
      // would otherwise make the NEXT cycle's rate wall read as "progressing"
      // and skip the long backoff exactly when it is needed (walls typically
      // land right after a burst of successful requests).
      this.enrichedThisCycle = 0;
      this.walledCycles = 0; // real progress — the read side is not walled
    } else if (this.unenrichedUsernames(current.pk, 1).length > 0) {
      // NOT exhaustion: candidates remain that were never successfully
      // enriched. Two very different situations land here:
      //  - enrichment IS delivering but everything scored so far was rejected
      //    (a deep pool being worked through) → open the next cycle promptly;
      //  - enrichment delivered NOTHING (rate wall / sentinel window) →
      //    latching `targetExhausted` here used to burn the whole chain
      //    (`chain.advance` marks targets exhausted IRREVERSIBLY) during a
      //    transient outage — instead park LONG and retry the cycle; the
      //    THIRD walled cycle in a row escalates to the recovery ladder (a
      //    read wall that outlives two long backoffs is the same rate wall
      //    the action side ladders on — the flat 10-minute loop ran forever).
      const walled = this.enrichedThisCycle === 0;
      this.enrichPassesThisCycle = 0;
      this.enrichedThisCycle = 0;
      if (walled) {
        this.walledCycles += 1;
        if (this.walledCycles >= RECOVERY_TIMING.WALLED_CYCLES_ENTRY) {
          this.walledCycles = 0;
          log.warn('engine: enrichment walled repeatedly — entering recovery', {
            target: current.pk,
          });
          return this.enterRecovery(token, 'rate-limited');
        }
        log.warn('engine: refill starved by failed enrichment, backing off (target NOT exhausted)', {
          target: current.pk,
          walledCycles: this.walledCycles,
        });
        await this.engineWait('engine:enrich-backoff', ENGINE_TIMING.ENRICH_BACKOFF_MS);
        return 'idle';
      }
      this.walledCycles = 0;
      this.acquiredThisCycle = false;
      log.info('engine: pool not exhausted, opening next enrichment cycle', {
        target: current.pk,
      });
    } else {
      this.targetExhausted = true;
    }
    log.info('engine: refill planned', {
      target: current.pk,
      queued: plan.queued.length,
      exhausted: this.targetExhausted,
    });
    if (issuedTraffic) await this.pacingSleep();
    return 'acquired';
  }

  /**
   * Up to `cap` usernames from the target's raw pool that still lack counts and
   * are worth an enrichment fetch: not yet `profiled`, username known, and not
   * marked permanently un-enrichable (`enrichFailedAt` — deleted/suspended
   * accounts used to head-of-line-block every pass of every cycle).
   */
  private unenrichedUsernames(targetPk: string, cap: number): string[] {
    const usernames: string[] = [];
    for (const pk of this.deps.store.candidatePksForTarget(targetPk)) {
      if (usernames.length >= cap) break;
      const acc = this.deps.store.getAccount(pk);
      if (acc === null || acc.enrichment === 'profiled') continue;
      if (acc.username === undefined) continue; // no username → no profile fetch possible
      if (acc.enrichFailedAt !== undefined) continue; // permanently un-enrichable
      usernames.push(acc.username);
    }
    return usernames;
  }

  /**
   * Set the owed inter-action deadline in memory AND the store in one move —
   * the durable mirror is what lets an app relaunch resume the remaining wait.
   */
  private setActionDeadline(at: number | null): void {
    this.actionDelayDeadline = at;
    this.deps.store.setActionDelayDeadline(at);
  }

  /**
   * The next woven prune-unfollow candidate, or null. Only in the organic model with
   * `weaveEnabled`, a feed injected, and the prune daily cap not hit. Pure selection —
   * consumes only leading skips (whitelisted / followed-back-since / no-username).
   */
  private selectPruneCandidate(now: number): { pk: string; username: string } | null {
    if (this.pacing === undefined || !this.settings.weaveEnabled) return null;
    const feed = this.unfollowFeed;
    if (feed === undefined || feed.atDailyCap(now)) return null;
    return feed.nextCandidate(now);
  }

  /**
   * Which action to take this step. Lifecycle churn (follow / due unfollow) and woven
   * prune unfollows share one stream; when both are available they interleave with a
   * bounded probability (≤ `maxUnfollowFractionPerSession`) so a session is never
   * unfollow-dominated — but a due LIFECYCLE unfollow is never displaced (it is
   * time-sensitive). There is deliberately no aggregate follow:unfollow ratio (the churn
   * lifecycle legitimately runs ~1:1; §10 R1) — temporal spreading defeats correlation.
   */
  private pickAction(
    due: FollowRecord | null,
    pruneCand: { pk: string; username: string } | null,
  ): 'lifecycle' | 'prune' | null {
    if (due !== null && pruneCand !== null) {
      if (due.state !== 'unfollow_queued') {
        const p = Math.min(
          this.settings.maxUnfollowFractionPerSession,
          PATTERN.MAX_UNFOLLOW_FRACTION_PER_SESSION,
        );
        if (this.rng() < p) return 'prune';
      }
      return 'lifecycle';
    }
    if (due !== null) return 'lifecycle';
    if (pruneCand !== null) return 'prune';
    return null;
  }

  /** How many `queued` follow-records aim at this target. */
  private queuedCountFor(targetPk: string): number {
    return this.deps.store
      .followRecordsByState('queued')
      .filter((r) => r.targetPk === targetPk).length;
  }

  // --- Recovery ladder (see {@link RecoverySupervisor}) -------------------------------

  /**
   * Enter the recovery ladder with a classified failure `kind`: diagnose the
   * tab FIRST (a sick tab is a machinery problem — recover it, consuming no
   * rung and touching no records), then presume a rate wall and serve the next
   * rung's long jittered hold. Terminal outcomes: `recovery-exhausted` after
   * {@link RecoverySupervisor.maxAttempts} failed rungs; `adapter-drift` once
   * drift is CONFIRMED (two drift-classified windows with clean diagnostics,
   * after the first hold — ambiguity always defaults to rate-limited).
   */
  private async enterRecovery(token: AbortController, kind: FailureKind): Promise<StepResult> {
    // Defensive: an already-armed hold is served, never double-entered.
    if (this.recovery.phase() === 'holding') return this.serveRecoveryHold(token);

    this.recovery.noteOutcome(kind);
    // Each rung burns a fresh window of ledger rows — clear both streaks.
    this.deps.churn.resetConsecutiveFailures?.();
    this.deps.churn.resetConsecutiveBlocked?.();
    log.warn('engine: recovery ladder entered', {
      kind,
      attempt: this.recovery.attemptNow(),
      tally: this.recovery.tally(),
    });

    // Diagnose first, wait second.
    this.recovery.beginDiagnosis();
    const diag = await this.diagnoseTab();
    log.info('engine: recovery diagnosis', diag);
    if (this.superseded(token)) {
      this.recovery.abortDiagnosis();
      return 'aborted';
    }
    if (!diag.healthy) {
      // The TAB is the problem: recover it — no rung consumed, no records touched.
      this.recovery.abortDiagnosis();
      this.recovery.noteOutcome('tab-unhealthy');
      await this.recoverTabOnce();
      return 'recovering';
    }

    if (this.recovery.driftConfirmed()) {
      // Waiting cannot fix a reshaped interface.
      this.recovery.abortDiagnosis();
      return this.halt('adapter-drift');
    }

    const hold = this.recovery.beginHold(this.deps.clock.now());
    if (hold === null) {
      return this.halt('recovery-exhausted');
    }
    log.warn('engine: recovery hold begins', {
      attempt: hold.attempt,
      maxAttempts: this.recovery.maxAttempts(),
      holdMs: hold.holdMs,
      resumesAt: new Date(this.deps.clock.now() + hold.holdMs).toISOString(),
    });
    return this.serveRecoveryHold(token);
  }

  /**
   * Serve the armed hold's REMAINDER (an absolute deadline — durable across
   * pause/offline/stop and app relaunches, §3). A wait interrupted by a
   * control command leaves the deadline armed for the next opportunity; a wait
   * served to completion moves the ladder to probing — the next real actions
   * ARE the probe. Registered as `engine:recovery-hold`, so it surfaces as a
   * long park (status emitted at registration) and shields the step watchdog.
   */
  private async serveRecoveryHold(token: AbortController = this.runAbort): Promise<StepResult> {
    const remaining = this.recovery.holdRemainingMs(this.deps.clock.now());
    if (remaining > 0) {
      const res = await this.engineWait('engine:recovery-hold', remaining);
      if (!res.completed || this.superseded(token)) return 'recovering';
    }
    this.recovery.completeHold();
    log.warn('engine: recovery hold served — probing with the next real actions', {
      attempt: this.recovery.attemptNow(),
      maxAttempts: this.recovery.maxAttempts(),
    });
    this.emitStatus(); // probing is visible immediately, not at step end
    return 'recovering';
  }

  /**
   * The entry diagnosis: input probe + renderer canary. Either failing means
   * the MACHINERY is sick (route to tab recovery, never the wait ladder);
   * both passing means the tab is fine and the failures are Instagram-side —
   * presume a rate wall. No diagnostics port injected → presumed healthy.
   */
  private async diagnoseTab(): Promise<{
    healthy: boolean;
    inputOk: boolean | null;
    canaryOk: boolean | null;
  }> {
    const diag = this.deps.tabDiag;
    if (diag === undefined) return { healthy: true, inputOk: null, canaryOk: null };
    try {
      const inputOk = await diag.probeInput();
      const health = await diag.checkHealth();
      return { healthy: health.healthy && inputOk, inputOk, canaryOk: health.healthy };
    } catch (e) {
      log.warn('engine: tab diagnosis failed — treating the tab as unhealthy', {
        error: String(e),
      });
      return { healthy: false, inputOk: null, canaryOk: null };
    }
  }

  /** Recover the tab (reload + debugger re-attach) and re-check the sentinel. */
  private async recoverTabOnce(): Promise<void> {
    const diag = this.deps.tabDiag;
    if (diag === undefined) return;
    log.warn('engine: recovering tab (diagnosis failed the canary)');
    try {
      await diag.recoverTab();
    } catch (e) {
      log.error('engine: tab recovery failed', { error: String(e) });
    }
    try {
      this.lastSentinel = await this.deps.sentinel.check();
      log.info('engine: post-recovery sentinel', { status: this.lastSentinel });
    } catch (e) {
      log.warn('engine: post-recovery sentinel check failed', { error: String(e) });
    }
  }

  // --- Halt / status ----------------------------------------------------------------

  private halt(reason: string): 'halted' {
    this.engineState = 'halted';
    this.haltReason = reason;
    this.lastHalt = { reason, at: this.deps.clock.now() };
    log.warn('engine: halted', { reason });
    this.deps.onHalt?.(reason);
    return 'halted';
  }

  /**
   * The most recent halt (reason + when), STICKY across restarts — the
   * scheduled-prune rate-limit cool-down (amendment A) reads this even after
   * the user has started growth again. Null when no halt has happened yet.
   */
  lastHaltInfo(): { reason: string; at: number } | null {
    return this.lastHalt === null ? null : { ...this.lastHalt };
  }

  /**
   * The recovery ladder's diagnostic snapshot (phase, rung, failure-kind
   * tally) — logged once by the composition root's halt diagnostics.
   */
  recoverySnapshot(): { phase: string; attempt: number; kindTally: Record<string, number> } {
    return {
      phase: this.recovery.phase(),
      attempt: this.recovery.attemptNow(),
      kindTally: this.recovery.tally() as Record<string, number>,
    };
  }

  /**
   * An EXTERNAL tab recovery happened (the main-process step watchdog reloaded
   * a wedged tab): note it in the ladder's tally so the halt-time diagnostics
   * carry the full history. A note, never an entry — no hold is armed.
   */
  noteExternalTabRecovery(): void {
    this.recovery.noteOutcome('tab-unhealthy');
    log.warn('engine: external tab recovery noted in the recovery tally');
  }

  private emitStatus(): void {
    this.deps.onStatus?.(this.status());
  }

  // --- Time & sleep -----------------------------------------------------------------

  /**
   * Wait through the shared DelayManager under a namespaced key, linked to the
   * CURRENT run-generation token (E1/R2: no wait outlives a control command, and
   * the manager's per-key replace guard mirrors the old activeSleep identity
   * check — a stale generation's wait can never shadow the new run's). The
   * `engine:action-delay` wait additionally emits a status right after
   * registration, so the renderer sees the REAL next-action deadline
   * (`nextActionAt`) while the wait is pending — and every LONG park
   * ({@link PARK_REASON_BY_KEY}) does the same for `parkedUntil`/`parkReason`,
   * so a multi-hour hold is visible the moment it starts, not after it ends.
   * The remaining short keys stay quiet to avoid doubling every step's push.
   */
  private async engineWait(key: EngineWaitKey, policyOrMs: DelayPolicy | number): Promise<WaitResult> {
    const wait = this.delays.wait(key, this.applyWaitNoise(key, policyOrMs), {
      signal: this.runAbort.signal,
    });
    // Registration is synchronous (before the wait's first internal await), so
    // the real deadline is readable — and emittable — before awaiting.
    const parkReason = PARK_REASON_BY_KEY.get(key);
    if (parkReason !== undefined) {
      const until = this.delays.nextDeadline(key) ?? this.deps.clock.now();
      this.park = { reason: parkReason, until };
      // Log + emit at REGISTRATION: a fresh start that parks immediately must
      // say so now — the step result only lands after the hold completes.
      log.info('engine: holding', { reason: parkReason, resumesAt: new Date(until).toISOString() });
      this.emitStatus();
    } else if (key === 'engine:action-delay') {
      this.emitStatus();
    }
    try {
      return await wait;
    } finally {
      // The hold is over however the wait ended (elapsed, pause, offline,
      // stop); the step's own status emit publishes the cleared state.
      if (parkReason !== undefined) this.park = null;
    }
  }

  /**
   * The noise gate every engine wait passes through (the deterministic-
   * scheduling fix, per {@link ENGINE_WAIT_CLASS}):
   *
   *  - 'daily-boundary': the exact ms-to-boundary gets a POSITIVE-ONLY offset
   *    seeded by the RESUME day's key (computed from now + base — a park armed
   *    tonight for tomorrow 08:00 and a restart re-arming it after midnight
   *    derive the SAME key) ⊕ the wait key ⊕ the install entropy: stable
   *    within a day and across a mid-park restart (§3), different per day,
   *    per key, and per install. Applied BEFORE the wait registers, so
   *    `parkedUntil` (and the pushed status) carry the REAL jittered deadline.
   *  - 'retry-backoff' / 'local-beat': a noisified policy whose draws come
   *    from the dedicated noise rng — the seeded engine rng stream stays
   *    byte-identical with or without noise.
   *  - 'exact': untouched (the call site already draws its own jitter).
   */
  private applyWaitNoise(key: EngineWaitKey, policyOrMs: DelayPolicy | number): DelayPolicy | number {
    const cls = ENGINE_WAIT_CLASS[key];
    if (cls === 'exact') return policyOrMs;
    if (cls === 'daily-boundary') {
      const base =
        typeof policyOrMs === 'number' ? policyOrMs : policyOrMs.sample(this.noiseRng);
      const resumeAt = this.deps.clock.now() + base;
      return jitterBoundary(base, boundarySeedKey(resumeAt, key), this.installEntropy);
    }
    return noisify(cls, policyOrMs, this.noiseRng);
  }

  /** The CURRENT run-generation abort signal (adapter waits link to this). */
  runSignal(): AbortSignal {
    return this.runAbort.signal;
  }

  /**
   * f10: the short jittered pause ending every branch that issued Instagram traffic
   * outside step 8 (acquire / enrich / sweep / chain-advance-into-refill), so no
   * branch can hammer back-to-back. Step 8 keeps `rate.nextDelayMs()` as the paced
   * delay between ACTIONS; this is merely the between-reads floor. Drawn through
   * the DelayManager's injected rng (deterministic tests — no raw Math.random).
   */
  private async pacingSleep(): Promise<void> {
    await this.engineWait(
      'engine:refill-pacing',
      uniform(REFILL_PACING_MIN_MS, REFILL_PACING_MAX_MS),
    );
  }

  /** Ms until the next local `activeHoursStart` o'clock (always strictly future). */
  private msUntilActiveWindow(): number {
    const now = this.deps.clock.now();
    const next = new Date(now);
    next.setHours(this.settings.activeHoursStart, 0, 0, 0);
    if (next.getTime() <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now;
  }

  // --- Pause gate --------------------------------------------------------------------

  private waitForResume(): Promise<void> {
    // Reaching here means the loop has quiesced at the pause gate — the in-flight
    // step is done and nothing is driving the tab. Signal any prune hand-off.
    this.parkedNow = true;
    this.notifyParked();
    return new Promise<void>((resolve) => {
      this.resumeWaiters.push(() => {
        this.parkedNow = false;
        resolve();
      });
    });
  }

  private releaseResumeWaiters(): void {
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const w of waiters) w();
  }

  private notifyParked(): void {
    const waiters = this.parkAckWaiters;
    this.parkAckWaiters = [];
    for (const w of waiters) w();
  }

  /**
   * Resolve once the loop has QUIESCED at the pause gate: the in-flight step (if
   * any) has finished and the loop is parked in {@link waitForResume}. Resolves
   * `true` immediately when the engine isn't driving the tab (idle/halted, or
   * already parked); otherwise waits for the loop to reach the gate, up to
   * `timeoutMs`, resolving `false` on timeout. The composition root calls this
   * AFTER {@link pause} so a prune never drives the shared tab while a growth
   * step is still in flight. Caller must have requested the pause first — this
   * only observes; it never pauses.
   */
  async awaitParked(timeoutMs: number): Promise<boolean> {
    const state = this.stateNow();
    // Not running and not paused → the loop isn't driving the tab at all.
    if (state === 'idle' || state === 'halted') return true;
    // Paused AND the loop has already reached the gate → quiesced.
    if (state === 'paused' && this.parkedNow) return true;
    let waiter: (() => void) | null = null;
    const parked = new Promise<true>((resolve) => {
      waiter = (): void => resolve(true);
      this.parkAckWaiters.push(waiter);
    });
    const result = await withTimeout(parked, timeoutMs);
    if (result === TIMED_OUT) {
      // Remove the orphaned resolver — repeated failed hand-offs must not
      // accumulate waiters forever.
      this.parkAckWaiters = this.parkAckWaiters.filter((w) => w !== waiter);
      return false;
    }
    return true;
  }

  /**
   * Whether the loop may be driving the tab RIGHT NOW. `pause()` flips the
   * state synchronously and returns while the in-flight step (a follow click,
   * an acquisition scroll) keeps running — only reaching the pause gate proves
   * quiescence. Callers granting the tab to another driver (prune, manual ops)
   * must gate on THIS, never on `status().state !== 'running'`.
   */
  isDrivingTab(): boolean {
    const state = this.stateNow();
    if (state === 'running') return true;
    return state === 'paused' && !this.parkedNow;
  }

  // --- Offline gate (mirrors the pause gate) -------------------------------------------

  private waitForOnline(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.onlineWaiters.push(resolve);
    });
  }

  private releaseOnlineWaiters(): void {
    const waiters = this.onlineWaiters;
    this.onlineWaiters = [];
    for (const w of waiters) w();
  }
}

/** Pure factory for the composition root (a later task); no wiring lives here. */
export function createEngine(deps: EngineDeps): Engine {
  return new Engine(deps);
}

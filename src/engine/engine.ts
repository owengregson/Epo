/**
 * Engine runtime (v3 engine-architecture §3) — the conductor.
 *
 * Composes the pure engine components (Churn Scheduler, Scanner, Chain Controller,
 * Follow-back Watcher) and the rim ports (FollowerAcquisition, Sentinel) into one
 * safe, paced, interruptible running system. The Engine is the ONLY place that owns
 * wall-clock time: every wait goes through one interruptible `sleep`, and every
 * Instagram action is separated from the next by a human delay (`rate.nextDelayMs`).
 *
 * One loop iteration ({@link Engine.stepOnce}) performs AT MOST ONE major thing, in
 * a fixed precedence (§3.1) — which makes bursts structurally impossible and lets
 * `stop()`/`pause()` interrupt *between* actions instantly (E1).
 *
 * Everything is injected (ports, clock, sleep), so the whole runtime is unit-testable
 * with fakes: no browser, no wall-clock, no real timers.
 */

import type { KnowledgeStore } from '../store/knowledge-store';
import type { FollowRecord } from '../store/types';
import type { Clock } from '../governors/clock';
import type { SentinelStatus } from '../adapter/sentinel';
import type { ScanPlan } from './scanner';
import type { AdvanceResult } from './chain-controller';
import type { FollowerAcquisition } from '../rim/types';
import type { Settings } from '../settings/settings';
import { DelayManager } from '../timing/delay-manager';
import {
  type DelayPolicy,
  type SleepFn,
  TIMED_OUT,
  sleep as timingSleep,
  uniform,
  withTimeout,
} from '../timing/primitives';
import { ENGINE as ENGINE_TIMING } from '../timing/config';
import * as log from '../utils/logger';

// ---------------------------------------------------------------------------------
// Ports: the narrow, structural slices of each collaborator the Engine needs.
// The real components (ChurnScheduler, Scanner, ChainController, FollowbackWatcher,
// RateGovernor, RequestBudget, Sentinel) satisfy these by structural subtyping;
// tests inject plain fakes without touching the concrete classes.
// ---------------------------------------------------------------------------------

/** The Churn Scheduler's split API (§3.2): timers / pick one / execute one. */
export interface EngineChurn {
  advanceTimers(now: number): void;
  nextDue(now: number): FollowRecord | null;
  execute(rec: FollowRecord, now: number): Promise<void>;
}

/** The Scanner's planning surface: rank + enqueue one target's candidates. */
export interface EngineScanner {
  planTarget(targetPk: string): ScanPlan;
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
 * is budget/sentinel-gated and paced internally; tests inject a fake.
 */
export interface EngineEnricher {
  enrich(usernames: string[]): Promise<number>;
}

/** The Rate Governor slice the Engine consults for gating, pacing, and status. */
export interface EngineRate {
  withinActiveHours(): boolean;
  atHardCeiling(): boolean;
  nextDelayMs(): number;
  actionsToday(): number;
  remainingToday(): number;
}

/** The Request Budget slice the Engine consults for gating and projects into status. */
export interface EngineRequestBudget {
  remaining(): number;
  /** R4: whether at least one request may be spent now (pre-checked before acting). */
  canSpend(): boolean;
}

/** The Sentinel slice: classify the tab before anything else each iteration. */
export interface EngineSentinel {
  check(): Promise<SentinelStatus>;
}

// Back-compat re-exports: the canonical interruptible sleep + its signature now
// live in timing/primitives (E1 — nothing in the Engine can wait un-interruptibly).
export { sleep as defaultSleep } from '../timing/primitives';
export type { SleepFn } from '../timing/primitives';

/** How long an iteration idles when nothing is due yet (§3.1, final branch). */
export const ENGINE_IDLE_MS = ENGINE_TIMING.IDLE_MS;

/** f10: bounds of the short jittered pause ending every branch that issued IG traffic. */
export const REFILL_PACING_MIN_MS = ENGINE_TIMING.REFILL_PACING_MIN_MS;
export const REFILL_PACING_MAX_MS = ENGINE_TIMING.REFILL_PACING_MAX_MS;

/** R1: at most this many candidate usernames are enriched per pass. */
export const ENRICH_BATCH_SIZE = 10;

/**
 * R1.5: at most this many enrichment passes per refill cycle. Once exhausted, the
 * cycle plans with whatever counts it has; a plan that enqueues nothing then marks
 * the target exhausted — enrichment can never spin unboundedly on a dry target.
 */
export const MAX_ENRICH_PASSES_PER_CYCLE = 3;

// ---------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------

export type EngineState = 'idle' | 'running' | 'paused' | 'halted';

/** What a single loop iteration did — exactly one of these per `stepOnce()`. */
export type StepResult =
  | 'aborted'
  | 'halted'
  | 'waited-active-hours'
  | 'waited-ceiling'
  | 'swept-followback'
  | 'acquired'
  | 'acted'
  | 'advanced-chain'
  | 'idle';

/** Status projection over the store + governors + Engine state (§5). */
export interface EngineStatus {
  state: EngineState;
  currentTargetPk: string | null;
  currentTargetUsername: string | null;
  chainIndex: number | null;
  actionsToday: number;
  remainingToday: number;
  atHardCeiling: boolean;
  requestBudgetRemaining: number;
  queued: number;
  pendingFollowback: number;
  followedBackHeld: number;
  unfollowDue: number;
  lastStep: StepResult | null;
  lastSentinel: SentinelStatus | null;
  lastActionAt: number | null;
  sessionStartedAt: number | null;
  /** Deadline (epoch ms) of the in-flight humanized action delay, else null. */
  nextActionAt: number | null;
  netToday: number;
  /** Whether the connectivity monitor last reported the internet reachable. */
  online: boolean;
}

/** Everything the Engine composes, already constructed (composition root's job). */
export interface EngineDeps {
  store: KnowledgeStore;
  clock: Clock;
  rate: EngineRate;
  requestBudget: EngineRequestBudget;
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
   * Due-by-timestamp cadence for the follow-back sweep. The composition root
   * injects a persisted cadence (Settings.sweepLastRunAt) so the 4h rhythm
   * survives restarts; the default is the old in-memory behavior (last run
   * starts at 0 → a fresh Engine's first eligible step performs a cheap
   * catch-up sweep, then the configured cadence applies).
   */
  sweepCadence?: SweepCadence;
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
  private targetExhausted = false;

  /**
   * Sweep cadence port. Injected (persisted) by the composition root; the
   * default preserves the old behavior — in-memory, starting due, so a fresh
   * Engine's first eligible step performs a cheap catch-up sweep.
   */
  private readonly sweepCadence: SweepCadence;

  private lastStep: StepResult | null = null;
  private lastSentinel: SentinelStatus | null = null;
  private lastActionAt: number | null = null;

  /** The injected enricher, or the warn-and-noop fallback (see {@link EngineDeps}). */
  private readonly enricher: EngineEnricher;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.delays =
      deps.delays ??
      new DelayManager({ clock: deps.clock, rng: deps.rng, sleep: deps.sleep ?? timingSleep });
    this.sweepCadence =
      deps.sweepCadence ??
      ((): SweepCadence => {
        let last = 0;
        return {
          isDue: (now, everyMs) => now - last >= everyMs,
          markRun: (now) => {
            last = now;
          },
        };
      })();
    this.settings = deps.settings;
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
   * run's state — two loops can never proceed together.
   */
  async start(): Promise<void> {
    if (this.engineState === 'running' || this.engineState === 'paused') return;
    this.runAbort = new AbortController();
    const token = this.runAbort; // this run's generation token (R2)
    this.engineState = 'running';
    this.sessionStartedAt = this.deps.clock.now();
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
          this.sessionStartedAt = null;
        }
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
    if (this.engineState !== 'halted') this.engineState = 'idle';
    this.sessionStartedAt = null;
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
    const { store, rate, requestBudget, clock } = this.deps;
    const chainIndex =
      this.current === null ? null : (store.getTarget(this.current.pk)?.chainIndex ?? null);
    const startOfToday = new Date(clock.now()).setHours(0, 0, 0, 0);
    return {
      state: this.engineState,
      currentTargetPk: this.current?.pk ?? null,
      currentTargetUsername: this.current?.username ?? null,
      chainIndex,
      actionsToday: rate.actionsToday(),
      remainingToday: rate.remainingToday(),
      atHardCeiling: rate.atHardCeiling(),
      requestBudgetRemaining: requestBudget.remaining(),
      queued: store.followRecordsByState('queued').length,
      pendingFollowback: store.followRecordsByState('pending_followback').length,
      followedBackHeld: store.followRecordsByState('followed_back').length,
      unfollowDue: store.followRecordsByState('unfollow_queued').length,
      lastStep: this.lastStep,
      lastSentinel: this.lastSentinel,
      lastActionAt: this.lastActionAt,
      sessionStartedAt: this.sessionStartedAt,
      nextActionAt: this.delays.nextDeadline('engine:action-delay'),
      netToday: store.netFollowersSince(startOfToday),
      online: this.online,
    };
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
   *  8. R4 pre-check: request budget saturated → park on the idle sleep → `'idle'`.
   *     Otherwise a due record → `churn.execute` then sleep `rate.nextDelayMs()` —
   *     THE human delay between actions → `'acted'`.
   *  9. Target exhausted (refill cycle closed on an empty plan, queue drained) →
   *     `chain.advance`; adopt the next target → `'advanced-chain'`, or halt
   *     (`chain-exhausted`) → `'halted'`.
   * 10. Nothing due → short idle sleep → `'idle'`.
   *
   * Emits `onStatus` after every step, whatever the branch.
   */
  async stepOnce(): Promise<StepResult> {
    let result: StepResult;
    try {
      result = await this.step();
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
    return result;
  }

  private async step(): Promise<StepResult> {
    // 1. Stopped or halted: never touch anything.
    if (this.runAbort.signal.aborted || this.engineState === 'halted') return 'aborted';

    // 2. Sentinel gate — the hard safety stop, checked before anything else.
    const sentinelStatus = await this.deps.sentinel.check();
    this.lastSentinel = sentinelStatus;
    if (sentinelStatus !== 'ok') return this.halt(`sentinel:${sentinelStatus}`);

    // 3. Active-hours gate.
    if (!this.deps.rate.withinActiveHours()) {
      await this.engineWait('engine:active-hours-park', this.msUntilActiveWindow());
      return 'waited-active-hours';
    }

    // 4. Hard-ceiling gate — nothing more today.
    if (this.deps.rate.atHardCeiling()) {
      await this.engineWait('engine:daily-ceiling-park', this.msUntilLocalMidnight());
      return 'waited-ceiling';
    }

    const now = this.deps.clock.now();

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
      return this.refillPool(current);
    }

    // 8. Exactly ONE Instagram action, then the human delay — but first the R4
    //    pre-check: when the request budget cannot spend, a saturated window PARKS
    //    on the idle wait instead of driving attempts that would only be blocked
    //    downstream (no action, no chain traffic, no manufactured failures).
    if (!this.deps.requestBudget.canSpend()) {
      log.warn('engine: request budget saturated, parking', {
        remaining: this.deps.requestBudget.remaining(),
      });
      await this.engineWait('engine:budget-park', ENGINE_IDLE_MS);
      return 'idle';
    }
    const due = this.deps.churn.nextDue(now);
    if (due !== null) {
      await this.deps.churn.execute(due, now);
      this.lastActionAt = now;
      // If a pause/stop landed DURING the action, don't open a fresh full delay —
      // let the loop reach the pause gate (or exit) promptly so a prune hand-off
      // can take the shared tab. The inter-action spacing is preserved by the
      // pause/stop itself (growth won't act again until it resumes). Any other
      // state (running, or a direct step in tests) keeps THE human delay.
      if (this.stateNow() !== 'paused' && !this.runAbort.signal.aborted) {
        await this.engineWait('engine:action-delay', this.deps.rate.nextDelayMs());
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
  private async refillPool(current: CurrentTarget): Promise<StepResult> {
    let issuedTraffic = false;

    // (1) At most one acquisition per cycle.
    if (!this.acquiredThisCycle) {
      this.acquiredThisCycle = true;
      if (current.username === null) {
        log.warn('engine: cannot acquire, target username unknown', { pk: current.pk });
      } else {
        await this.deps.acquisition.acquire(current.username);
        issuedTraffic = true;
      }
    }

    // (2) Select up to a batch of candidate usernames still lacking counts.
    const usernames: string[] = [];
    for (const pk of this.deps.store.candidatePksForTarget(current.pk)) {
      if (usernames.length >= ENRICH_BATCH_SIZE) break;
      const acc = this.deps.store.getAccount(pk);
      if (acc === null || acc.enrichment === 'profiled') continue;
      if (acc.username === undefined) continue; // no username → no profile fetch possible
      usernames.push(acc.username);
    }

    // (3) Enrich them (bounded per cycle); the next firing scores what came back.
    if (usernames.length > 0 && this.enrichPassesThisCycle < MAX_ENRICH_PASSES_PER_CYCLE) {
      this.enrichPassesThisCycle += 1;
      const enriched = await this.enricher.enrich(usernames);
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

  /** How many `queued` follow-records aim at this target. */
  private queuedCountFor(targetPk: string): number {
    return this.deps.store
      .followRecordsByState('queued')
      .filter((r) => r.targetPk === targetPk).length;
  }

  // --- Halt / status ----------------------------------------------------------------

  private halt(reason: string): 'halted' {
    this.engineState = 'halted';
    log.warn('engine: halted', { reason });
    this.deps.onHalt?.(reason);
    return 'halted';
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
   * (`nextActionAt`) while the wait is pending; other keys stay quiet to avoid
   * doubling every step's status push.
   */
  private async engineWait(key: string, policyOrMs: DelayPolicy | number): Promise<void> {
    const wait = this.delays.wait(key, policyOrMs, { signal: this.runAbort.signal });
    if (key === 'engine:action-delay') this.emitStatus();
    await wait;
  }

  /** The CURRENT run-generation abort signal (adapter waits link to this). */
  runSignal(): AbortSignal {
    return this.runAbort.signal;
  }

  /**
   * f10: the short jittered pause ending every branch that issued Instagram traffic
   * outside step 8 (acquire / enrich / sweep / chain-advance-into-refill), so no
   * branch can hammer back-to-back. Step 8 keeps `rate.nextDelayMs()` as the human
   * delay between ACTIONS; this is merely the between-reads floor. Drawn through
   * the DelayManager's injected rng (deterministic tests — no raw Math.random).
   */
  private pacingSleep(): Promise<void> {
    return this.engineWait(
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

  /** Ms until the next local midnight (the daily ledger rolls over there). */
  private msUntilLocalMidnight(): number {
    const now = this.deps.clock.now();
    const next = new Date(now);
    next.setHours(24, 0, 0, 0);
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
    const parked = new Promise<true>((resolve) => {
      this.parkAckWaiters.push(() => resolve(true));
    });
    return (await withTimeout(parked, timeoutMs)) !== TIMED_OUT;
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

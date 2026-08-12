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

/** The Rate Governor slice the Engine consults for gating, pacing, and status. */
export interface EngineRate {
  withinActiveHours(): boolean;
  atHardCeiling(): boolean;
  nextDelayMs(): number;
  actionsToday(): number;
  remainingToday(): number;
}

/** The Request Budget slice the Engine projects into status. */
export interface EngineRequestBudget {
  remaining(): number;
}

/** The Sentinel slice: classify the tab before anything else each iteration. */
export interface EngineSentinel {
  check(): Promise<SentinelStatus>;
}

/**
 * An interruptible sleep: resolves after `ms` OR as soon as `signal` aborts,
 * whichever comes first (it never rejects). Injected so tests can advance a
 * FakeClock instead of waiting; the default is a real `setTimeout` wired to the
 * signal (E1 — nothing in the Engine can wait un-interruptibly).
 */
export type SleepFn = (ms: number, signal: AbortSignal) => Promise<void>;

/** The default sleep: real setTimeout, resolving early (not rejecting) on abort. */
export const defaultSleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });

/** How long an iteration idles when nothing is due yet (§3.1, final branch). */
export const ENGINE_IDLE_MS = 30_000;

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
  settings: Settings;
  /** Injected sleep; defaults to a real interruptible setTimeout. */
  sleep?: SleepFn;
  /** Called with a fresh status projection after every step and lifecycle change. */
  onStatus?: (s: EngineStatus) => void;
  /** Called exactly once per halt with the reason (e.g. `sentinel:challenge`). */
  onHalt?: (reason: string) => void;
}

const MS_PER_HOUR = 3_600_000;

interface CurrentTarget {
  pk: string;
  username: string | null;
}

// ---------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------

export class Engine {
  private readonly deps: EngineDeps;
  private readonly sleepFn: SleepFn;
  /** Live settings — swapped by {@link applySettings} when the user saves changes. */
  private settings: Settings;

  private engineState: EngineState = 'idle';
  private runAbort = new AbortController();
  /** The AbortController of the sleep currently in flight, if any. */
  private activeSleep: AbortController | null = null;
  /** Resolvers parked by the run loop while paused; released by resume()/stop(). */
  private resumeWaiters: Array<() => void> = [];

  private current: CurrentTarget | null = null;
  /**
   * Acquisition guard: set once `acquisition.acquire` has been attempted for the
   * current target in this refill cycle; cleared when the chain advances or when
   * a plan actually enqueues new candidates. Prevents the loop from re-acquiring
   * a dry target forever — with the flag set and nothing new to enqueue, the
   * "exhausted" branch (§3.1 step 9) is reachable and the chain advances.
   */
  private acquiredThisCycle = false;

  /**
   * Last follow-back sweep, epoch ms. Starts at 0 so the FIRST eligible step of a
   * fresh Engine performs a catch-up sweep (cheap: the watcher no-ops when nothing
   * is pending), then the configured cadence applies.
   */
  private lastSweepAt = 0;

  private lastStep: StepResult | null = null;
  private lastSentinel: SentinelStatus | null = null;
  private lastActionAt: number | null = null;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.sleepFn = deps.sleep ?? defaultSleep;
    this.settings = deps.settings;
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
   */
  async start(): Promise<void> {
    if (this.engineState === 'running' || this.engineState === 'paused') return;
    if (this.runAbort.signal.aborted) this.runAbort = new AbortController();
    this.engineState = 'running';
    log.info('engine: started');
    this.emitStatus();

    try {
      for (;;) {
        // Read through a method: control commands mutate the state concurrently,
        // so literal narrowing from the assignment above must not apply here.
        const state = this.stateNow();
        if (state === 'paused') {
          await this.waitForResume();
          continue;
        }
        if (state !== 'running') break;
        const result = await this.stepOnce();
        if (result === 'aborted' || result === 'halted') break;
      }
    } finally {
      const state = this.stateNow();
      if (state === 'running' || state === 'paused') {
        this.engineState = 'idle';
      }
      log.info('engine: loop ended', { state: this.engineState });
      this.emitStatus();
    }
  }

  /** Pause between actions: aborts the in-flight sleep; the loop parks until resume(). */
  pause(): void {
    if (this.engineState !== 'running') return;
    this.engineState = 'paused';
    this.activeSleep?.abort();
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
    this.activeSleep?.abort();
    if (this.engineState !== 'halted') this.engineState = 'idle';
    this.releaseResumeWaiters();
    log.info('engine: stopped');
    this.emitStatus();
  }

  status(): EngineStatus {
    const { store, rate, requestBudget } = this.deps;
    const chainIndex =
      this.current === null ? null : (store.getTarget(this.current.pk)?.chainIndex ?? null);
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
   *  6. Follow-back sweep due → `followback.check()` → `'swept-followback'`.
   *  7. Candidate pool low (and target not proven dry) → acquire + plan → `'acquired'`.
   *  8. A due record → `churn.execute` then sleep `rate.nextDelayMs()` — THE human
   *     delay between actions → `'acted'`.
   *  9. Target exhausted → `chain.advance`; adopt the next target → `'advanced-chain'`,
   *     or halt (`chain-exhausted`) → `'halted'`.
   * 10. Nothing due → short idle sleep → `'idle'`.
   *
   * Emits `onStatus` after every step, whatever the branch.
   */
  async stepOnce(): Promise<StepResult> {
    const result = await this.step();
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
      await this.interruptibleSleep(this.msUntilActiveWindow());
      return 'waited-active-hours';
    }

    // 4. Hard-ceiling gate — nothing more today.
    if (this.deps.rate.atHardCeiling()) {
      await this.interruptibleSleep(this.msUntilLocalMidnight());
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

    // 6. Follow-back sweep on its slow cadence.
    const sweepDueMs = this.settings.followbackSweepHours * MS_PER_HOUR;
    if (now - this.lastSweepAt >= sweepDueMs) {
      await this.deps.followback.check();
      this.lastSweepAt = now;
      return 'swept-followback';
    }

    // 7. Candidate pool low → refill (acquire + plan), unless the target is proven
    //    dry (already acquired this cycle AND the graph holds no unqueued candidates).
    const queuedForTarget = this.queuedCountFor(current.pk);
    const unqueuedCandidates = this.deps.store.candidatePksForTarget(current.pk).length;
    if (
      queuedForTarget < this.settings.lowWaterCandidates &&
      (!this.acquiredThisCycle || unqueuedCandidates > 0)
    ) {
      await this.acquireAndPlan(current);
      return 'acquired';
    }

    // 8. Exactly ONE Instagram action, then the human delay.
    const due = this.deps.churn.nextDue(now);
    if (due !== null) {
      await this.deps.churn.execute(due, now);
      this.lastActionAt = now;
      await this.interruptibleSleep(this.deps.rate.nextDelayMs());
      return 'acted';
    }

    // 9. Target exhausted: nothing queued for it, no candidates left in the graph,
    //    and acquisition has already been tried this cycle → advance the chain.
    if (queuedForTarget === 0 && unqueuedCandidates === 0 && this.acquiredThisCycle) {
      const advance = await this.deps.chain.advance(current.pk);
      if (advance.nextTargetPk !== null) {
        this.adoptTarget(advance.nextTargetPk);
        log.info('engine: advanced chain', {
          from: current.pk,
          to: advance.nextTargetPk,
          source: advance.source,
        });
        return 'advanced-chain';
      }
      return this.halt('chain-exhausted');
    }

    // 10. Nothing due yet (records waiting on follow-back/holds): short idle.
    await this.interruptibleSleep(ENGINE_IDLE_MS);
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
    const plan = this.deps.scanner.planTarget(targetPk);
    if (plan.queued.length > 0) this.acquiredThisCycle = false;
    log.info('engine: seed target bootstrapped', { seed, targetPk, queued: plan.queued.length });
    return 'acquired';
  }

  /** Make `pk` the current target and reset the acquisition guard for its cycle. */
  private adoptTarget(pk: string): void {
    this.current = { pk, username: this.deps.store.getAccount(pk)?.username ?? null };
    this.acquiredThisCycle = false;
  }

  // --- Pool refill ----------------------------------------------------------------

  /**
   * One budgeted acquisition pass + a plan. Sets the acquisition guard; a plan that
   * actually enqueues candidates clears it again (there was yield, so a later refill
   * is allowed). A target whose username is unknown cannot be scraped: the guard is
   * set anyway so the exhausted branch can advance past it instead of spinning.
   */
  private async acquireAndPlan(current: CurrentTarget): Promise<void> {
    if (current.username === null) {
      log.warn('engine: cannot acquire, target username unknown', { pk: current.pk });
      this.acquiredThisCycle = true;
      return;
    }
    await this.deps.acquisition.acquire(current.username);
    this.acquiredThisCycle = true;
    const plan = this.deps.scanner.planTarget(current.pk);
    if (plan.queued.length > 0) this.acquiredThisCycle = false;
    log.info('engine: acquired + planned', {
      target: current.pk,
      queued: plan.queued.length,
    });
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
   * Sleep interruptibly: a per-sleep AbortController that fires on `pause()`/`stop()`
   * and is chained to the run signal, so no wait can outlive a control command (E1).
   */
  private async interruptibleSleep(ms: number): Promise<void> {
    const controller = new AbortController();
    const onRunAbort = (): void => controller.abort();
    if (this.runAbort.signal.aborted) {
      controller.abort();
    } else {
      this.runAbort.signal.addEventListener('abort', onRunAbort, { once: true });
    }
    this.activeSleep = controller;
    try {
      await this.sleepFn(ms, controller.signal);
    } finally {
      this.activeSleep = null;
      this.runAbort.signal.removeEventListener('abort', onRunAbort);
    }
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
    return new Promise<void>((resolve) => {
      this.resumeWaiters.push(resolve);
    });
  }

  private releaseResumeWaiters(): void {
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const w of waiters) w();
  }
}

/** Pure factory for the composition root (a later task); no wiring lives here. */
export function createEngine(deps: EngineDeps): Engine {
  return new Engine(deps);
}

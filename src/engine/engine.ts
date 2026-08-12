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

/** f10: bounds of the short jittered pause ending every branch that issued IG traffic. */
export const REFILL_PACING_MIN_MS = 2_000;
export const REFILL_PACING_MAX_MS = 5_000;

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
   * Last follow-back sweep, epoch ms. Starts at 0 so the FIRST eligible step of a
   * fresh Engine performs a catch-up sweep (cheap: the watcher no-ops when nothing
   * is pending), then the configured cadence applies.
   */
  private lastSweepAt = 0;

  private lastStep: StepResult | null = null;
  private lastSentinel: SentinelStatus | null = null;
  private lastActionAt: number | null = null;

  /** The injected enricher, or the warn-and-noop fallback (see {@link EngineDeps}). */
  private readonly enricher: EngineEnricher;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.sleepFn = deps.sleep ?? defaultSleep;
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
      await this.interruptibleSleep(ENGINE_IDLE_MS);
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

    // 6. Follow-back sweep on its slow cadence (IG traffic → paced, f10).
    const sweepDueMs = this.settings.followbackSweepHours * MS_PER_HOUR;
    if (now - this.lastSweepAt >= sweepDueMs) {
      await this.deps.followback.check();
      this.lastSweepAt = now;
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
      await this.interruptibleSleep(ENGINE_IDLE_MS);
      return 'idle';
    }
    const due = this.deps.churn.nextDue(now);
    if (due !== null) {
      await this.deps.churn.execute(due, now);
      this.lastActionAt = now;
      await this.interruptibleSleep(this.deps.rate.nextDelayMs());
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
   * Sleep interruptibly: a per-sleep AbortController that fires on `pause()`/`stop()`
   * and is chained to the run signal, so no wait can outlive a control command (E1).
   */
  private async interruptibleSleep(ms: number): Promise<void> {
    const controller = new AbortController();
    // Capture the CURRENT generation's signal: cleanup must unhook from the signal
    // we hooked, even if a restart has swapped `this.runAbort` by the time we wake.
    const runSignal = this.runAbort.signal;
    const onRunAbort = (): void => controller.abort();
    if (runSignal.aborted) {
      controller.abort();
    } else {
      runSignal.addEventListener('abort', onRunAbort, { once: true });
    }
    this.activeSleep = controller;
    try {
      await this.sleepFn(ms, controller.signal);
    } finally {
      // R2: only clear our own controller — a stale generation's sleep resolving
      // after a restart must not null out the NEW loop's in-flight sleep handle.
      if (this.activeSleep === controller) this.activeSleep = null;
      runSignal.removeEventListener('abort', onRunAbort);
    }
  }

  /**
   * f10: the short jittered pause ending every branch that issued Instagram traffic
   * outside step 8 (acquire / enrich / sweep / chain-advance-into-refill), so no
   * branch can hammer back-to-back. Step 8 keeps `rate.nextDelayMs()` as the human
   * delay between ACTIONS; this is merely the between-reads floor.
   */
  private async pacingSleep(): Promise<void> {
    const span = REFILL_PACING_MAX_MS - REFILL_PACING_MIN_MS;
    await this.interruptibleSleep(Math.round(REFILL_PACING_MIN_MS + Math.random() * span));
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

/**
 * The conductor: composes the pure engine components (Churn Scheduler, Scanner,
 * Chain Controller, Follow-back Watcher) and the rim ports into one safe, paced,
 * interruptible running system.
 *
 * One interruptible wait owner and one rule verdict per iteration (ADRs 0205/0902).
 * Ports, clock and sleep are injected so lifecycle transitions can be simulated.
 */

import type { SentinelStatus } from '../adapter/sentinel';
import type { Settings } from '../settings/settings';
import type { FollowRecord } from '../store/types';
import {
  ENGINE as ENGINE_TIMING,
  PRUNE as PRUNE_TIMING,
  RECOVERY as RECOVERY_TIMING,
} from '../timing/config';
import type { WaitResult } from '../timing/delay-manager';
import { mulberry32 } from '../timing/noise';
import {
  type DelayPolicy,
  type Rng,
  TIMED_OUT,
  uniform,
  withTimeout,
} from '../timing/primitives';
import { WaitRunner } from '../timing/wait-runner';
import * as log from '../utils/logger';
import { absurd } from './absurd';
import { queuedCountFor } from './decisions';
import { buildEngineFactSources } from './engine-facts';
import {
  ENGINE_WAIT_CLASS,
  type EngineParkReason,
  type EngineWaitKey,
  parkReasonFor,
} from './engine-waits';
import { FactGatherer, type FactSources, type Facts, type FeedCandidate } from './facts';
import { type HaltReason, haltReasonKey } from './halt-reason';
import { LegacyPacer, OrganicPacer, type Pacer } from './pacers';
import type {
  CurrentTarget,
  EngineDeps,
  EnginePacing,
  EngineState,
  EngineStatus,
  EngineUnfollowFeed,
  StepResult,
  SweepCadence,
} from './ports';
import { ReconciliationRunner } from './reconciliation-runner';
import { type FailureKind, type RecoveryIncident, RecoverySupervisor } from './recovery';
import { healIncidentWindow } from './recovery-healer';
import { decideProgram, type EffectRef, type RuleVerdict } from './rules';
import { RuntimeHealth } from './runtime-health';
import { projectEngineStatus, projectRecovery } from './status-projection';
import { TargetPipeline } from './target-pipeline';

// The canonical interruptible sleep lives in timing/primitives — nothing in the
// Engine may wait un-interruptibly.
export type { SleepFn } from '../timing/primitives';
export { sleep as defaultSleep } from '../timing/primitives';

/** How long an iteration idles when nothing is due yet (the final gate). */
export const ENGINE_IDLE_MS = ENGINE_TIMING.IDLE_MS;

/** Bounds of the short jittered pause ending every branch that issued IG traffic. */
export const REFILL_PACING_MIN_MS = ENGINE_TIMING.REFILL_PACING_MIN_MS;
export const REFILL_PACING_MAX_MS = ENGINE_TIMING.REFILL_PACING_MAX_MS;

// The refill cycle's own knobs live with it; re-exported for consumers that
// have always imported them from here.
export {
  ACQUIRE_SKIP_POOL_FACTOR,
  ENRICH_BATCH_SIZE,
  MAX_ENRICH_PASSES_PER_CYCLE,
} from './target-pipeline';

/**
 * Consecutive failed actions (ACROSS records) that enter the recovery ladder from
 * a standing start — two full records' worth, since one dead account produces at
 * most `maxRetries + 1` fails before abandoning. While the ladder is PROBING the
 * re-entry threshold drops to `RECOVERY.REENTRY_FAILS`.
 */
export const ACTIONS_FAILING_HALT = 8;

export type { EngineParkReason, EngineWaitKey } from './engine-waits';
export { ENGINE_WAIT_CLASS } from './engine-waits';
// The ports, status projection, and dependency bundle live in `ports.ts`;
// re-exported so consumers may import them from either module.
export * from './ports';

/** What one action attempt produced: the verb that landed (so the pacer can be
 *  told and the delay armed), or a StepResult that ends the iteration outright. */
type ActionOutcome =
  | { kind: 'follow' | 'unfollow'; step?: undefined }
  | { kind?: undefined; step: StepResult };

export class Engine {
  private readonly health: RuntimeHealth;
  private refillSinceAction = false;
  private readonly reconciliation: ReconciliationRunner;
  private readonly deps: EngineDeps;
  /** The ONE wait gate: every Engine wait is a named `engine:*` entry here. */
  private readonly waits: WaitRunner<EngineWaitKey, EngineParkReason>;
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

  /** Sweep cadence port (persisted by the composition root; see the fallback below). */
  private readonly sweepCadence: SweepCadence;

  /** The in-flight LONG park ({@link parkReasonFor}): why the loop is holding and
   *  until when. Set — and emitted — synchronously as the park registers, so a
   *  multi-hour hold is visible the moment it starts; cleared when it resolves. */
  private park: { reason: EngineParkReason; until: number } | null = null;

  private lastStep: StepResult | null = null;
  private lastSentinel: SentinelStatus | null = null;
  private lastActionAt: number | null = null;
  /** Why the engine last halted; cleared on the next `start()`. */
  private haltReason: string | null = null;
  /** The most recent halt, kept STICKY across restarts (unlike {@link haltReason},
   *  which a fresh start clears): the scheduled-prune cool-down must still see a
   *  rate-limit halt after the user has restarted growth. */
  private lastHalt: { reason: string; at: number } | null = null;

  /**
   * The classified, durable recovery ladder (`docs/adr/0201-recovery-ladder.md`).
   * Hydrated from store meta at construction, so a relaunch mid-hold serves the
   * REMAINDER rather than restarting the backoff.
   */
  private readonly recovery: RecoverySupervisor;

  /**
   * Deadline (epoch ms) of the inter-action paced delay still OWED, or null.
   * Armed the moment an action completes and disarmed only when the delay fully
   * elapses, so a pause, a stop, or a quit resumes the REMAINDER rather than
   * acting immediately. Mirrored to store meta `action_delay_deadline_at` on
   * every change and hydrated at construction; being absolute, time spent closed
   * counts against it.
   */
  private actionDelayDeadline: number | null = null;

  /** The chain target being worked and its bounded refill cycle. */
  private readonly targets: TargetPipeline;

  /** The organic pacing planner, or undefined in legacy mode (see {@link EngineDeps.pacing}). */
  private readonly pacing?: EnginePacing;

  /** The pacing model in force — the loop never branches on which one. */
  private readonly pacer: Pacer;

  /**
   * The per-tick fact snapshot the rules decide over ({@link PROGRAM}). Sources
   * are gathered lazily, in rule order, so a superseded step still never reaches
   * the sentinel and the clock is still sampled exactly once.
   */
  private readonly facts: FactGatherer;

  /** The generation token the CURRENT tick's fact sources read. */
  private stepToken: AbortController = new AbortController();

  /** The woven prune-unfollow feed (a no-op feed when weaving is off). */
  private readonly unfollowFeed: EngineUnfollowFeed;

  /** Randomness for the weave interleave draw; injectable for deterministic tests. */
  private readonly rng: () => number;
  /** Per-install noise entropy (see {@link EngineDeps.installEntropy}). */
  private readonly installEntropy: number;

  /**
   * The DEDICATED timing-noise rng — NEVER {@link rng}. Noise must not consume the
   * seeded engine stream, or every downstream draw shifts
   * (`docs/adr/0204-timing-noise.md`). Seeded from the install entropy ⊕
   * construction time.
   */
  private readonly noiseRng: Rng;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.reconciliation = new ReconciliationRunner(deps);
    this.health = new RuntimeHealth(deps.store);
    const delays = deps.delays;
    this.installEntropy = deps.installEntropy;
    this.noiseRng = mulberry32(((this.installEntropy >>> 0) ^ (deps.clock.now() & 0xffffffff)) >>> 0);
    this.waits = new WaitRunner<EngineWaitKey, EngineParkReason>({
      delays,
      clock: deps.clock,
      classes: ENGINE_WAIT_CLASS,
      noiseRng: this.noiseRng,
      installEntropy: this.installEntropy,
      parkReason: parkReasonFor,
      signal: () => this.runAbort.signal,
      hooks: {
        // Publish a LONG park at REGISTRATION: a fresh start that parks
        // immediately must say so now, not when the hold ends. The paced action
        // delay publishes too, so the countdown shows the real deadline; the
        // remaining short keys stay quiet to avoid doubling every step's push.
        onRegistered: (key, deadline, park) => {
          if (park !== null) {
            this.park = { reason: park, until: deadline };
            log.info('engine: holding', {
              reason: park,
              resumesAt: new Date(deadline).toISOString(),
            });
            this.emitStatus();
          } else if (key === 'engine:action-delay') {
            this.emitStatus();
          }
        },
        onSettled: (_key, park) => {
          // The hold is over however the wait ended (elapsed, pause, offline,
          // stop); the step's own status emit publishes the cleared state.
          if (park !== null) this.park = null;
        },
      },
    });
    this.sweepCadence = deps.sweepCadence;
    this.settings = deps.settings;
    this.pacing = deps.pacing;
    // The pacing model is chosen ONCE: the composition root injects a planner
    // only for the organic model. GATING is pure (`pacingVerdict` over facts);
    // only the post-action gap needs the model object.
    this.pacer =
      deps.pacing === undefined ? new LegacyPacer(deps.rate) : new OrganicPacer(deps.pacing);
    this.unfollowFeed = deps.unfollowFeed;
    this.rng = deps.rng ?? Math.random;
    // Hydrate the owed inter-action delay from the store so an app relaunch
    // resumes the remaining wait rather than acting on the first step.
    this.actionDelayDeadline = deps.store.getActionDelayDeadline();
    // The ladder hydrates its own durable state (store meta `recovery_state`) —
    // a relaunch mid-hold serves the REMAINDER.
    this.recovery = new RecoverySupervisor({
      clock: deps.clock,
      store: deps.store,
      rng: deps.rng,
    });
    this.targets = new TargetPipeline({
      frontier: deps.frontier,
      store: deps.store,
      clock: deps.clock,
      acquisition: deps.acquisition,
      scanner: deps.scanner,
      enricher: deps.enricher,
      settings: (): Settings => this.settings,
      wait: (key, policyOrMs) => this.engineWait(key, policyOrMs),
      pacingSleep: () => this.pacingSleep(),
      recover: (token, kind) => this.enterRecovery(token, kind),
      halt: (reason) => this.halt(reason),
    });
    this.facts = new FactGatherer(this.buildFactSources(), deps.clock);
  }

  /** Swap the Engine's own settings-derived knobs at runtime (seed, active-hours,
   *  follow-back cadence, low-water) — the governor/component configs reload
   *  separately. Applied between steps, so an in-flight iteration is never torn. */
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
   * aborts any in-flight wait, so resolution is prompt. Restartable from `idle` or
   * `halted`; a second concurrent `start()` is a no-op.
   *
   * EXACTLY ONE CONCURRENT LOOP: each run captures its own AbortController as a
   * GENERATION TOKEN and checks THAT token, never the current `this.runAbort`. A
   * stale loop waking after a restart sees its own token aborted and exits without
   * touching the new run's state. The step body carries the same token.
   */
  async start(): Promise<void> {
    if (this.engineState === 'running' || this.engineState === 'paused') return;
    this.runAbort = new AbortController();
    this.deps.reentry?.prepare(this.deps.clock.now());
    const token = this.runAbort; // this run's generation token
    this.engineState = 'running';
    // User ack: a manual Start from a RECOVERY halt clears the persisted ladder
    // and the streak counters — the user has looked at the session and chosen
    // to try again. A ladder that is merely mid-hold/probing (a stop, or an app
    // relaunch during a hold) is deliberately KEPT: stop/start is not a way
    // around a rate-wall backoff, exactly like the inter-action deadline.
    const recoveryHalt =
      this.haltReason === 'recovery-exhausted' || this.haltReason === 'adapter-drift';
    if (recoveryHalt || this.recovery.phase() === 'exhausted') {
      const incident = this.recovery.reset();
      this.deps.churn.resetStreaks();
      log.info('engine: recovery ladder cleared by manual start (user ack)');
      // The user's Start closes the incident window a terminal halt left open:
      // requeue what the window systemically burned (store-only, no IG traffic).
      if (incident !== null) this.healIncidentWindow(incident);
    }
    this.haltReason = null; // a fresh start clears the previous halt's cause
    // A manual start is likewise a user ack for the chain self-heal: each
    // exhausted target re-earns its ONE dead-end re-verify for this run.
    this.targets.clearRevived();
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

  /** Pause between actions: aborts the in-flight wait; the loop parks until resume(). */
  pause(): void {
    if (this.engineState !== 'running') return;
    this.engineState = 'paused';
    this.waits.cancelAll('engine:');
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
   * Stop: abort the run signal AND any in-flight wait, release a paused loop, and
   * let `start()` resolve cleanly. A halted Engine keeps its `halted` state (the
   * reason stays visible); otherwise it returns to `idle`.
   */
  stop(): void {
    this.runAbort.abort();
    this.waits.cancelAll('engine:');
    // The owed inter-action delay deliberately SURVIVES a stop (and, being
    // store-mirrored, an app quit): a later start() serves the remainder before
    // its first action — stop/start is not a way around the pacing.
    if (this.engineState !== 'halted') this.engineState = 'idle';
    this.sessionStartedAt = null;
    // Forget the in-memory target: the next start() re-adopts the store's
    // ACTIVE front, so store-side chain edits between runs take effect.
    this.targets.forget();
    this.releaseResumeWaiters();
    // A loop parked for offline must wake to observe the abort and exit cleanly.
    this.releaseOnlineWaiters();
    log.info('engine: stopped');
    this.emitStatus();
  }

  /**
   * Report connectivity (wired to the main-process ConnectivityMonitor). Going
   * OFFLINE aborts the in-flight wait so the loop parks promptly (no `stepOnce`
   * runs while offline); ONLINE releases it. `sessionStartedAt` is untouched —
   * an offline hold is not a stop.
   */
  setOnline(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    if (!online) {
      this.waits.cancelAll('engine:');
    } else {
      this.releaseOnlineWaiters();
    }
    log.info(online ? 'engine: back online' : 'engine: offline, holding', { online });
    this.emitStatus();
  }

  status(): EngineStatus {
    return {
      ...projectEngineStatus(this.deps, this.targets.current, this.pacing, this.health),
      state: this.engineState,
      lastStep: this.lastStep,
      lastSentinel: this.lastSentinel,
      lastActionAt: this.lastActionAt,
      sessionStartedAt: this.sessionStartedAt,
      // The live wait's deadline when one is pending; otherwise the OWED
      // deadline a pause/offline hold interrupted (so the countdown survives a
      // hold and reflects the remainder that will be served on resume).
      nextActionAt:
        this.waits.nextDeadline('engine:action-delay') ?? this.actionDelayDeadline,
      parkedUntil: this.park?.until ?? null,
      parkReason: this.park?.reason ?? null,
      online: this.online,
      haltReason: this.engineState === 'halted' ? this.haltReason : null,
      recovery: projectRecovery(this.recovery),
    };
  }

  // --- The loop body ---------------------------------------------------------------

  /**
   * ONE loop iteration — what the unit tests drive. The precedence lives in
   * `rules.ts`, not here: the first rule to claim the tick owns the step, and
   * its verdict carries at most one effect, which is what makes bursts
   * structurally impossible. Emits `onStatus` afterwards, whatever the branch.
   */
  async stepOnce(): Promise<StepResult> {
    // A stale step cannot overwrite the new run's durable state after stop/start.
    const token = this.runAbort;
    this.stepToken = token;
    let result: StepResult;
    try {
      this.facts.beginTick();
      result = await this.runProgram(token);
      if (!this.superseded(token)) this.health.responsive();
    } catch (err) {
      if (this.superseded(token)) return 'aborted';
      let terminal = true;
      try { terminal = this.health.failure(err, this.deps.clock.now()); }
      catch (storageError) { log.error('engine: cannot persist runtime failure', { error: String(storageError) }); }
      log.error('engine: step failed', { error: String(err), terminal });
      if (terminal) result = this.halt({ kind: 'runtime-error' });
      else {
        await this.engineWait('engine:transient-backoff', ENGINE_IDLE_MS);
        result = 'idle';
      }
    }
    this.lastStep = result;
    this.emitStatus();
    // Durable pacing snapshot: persist after every step so a relaunch resumes the
    // current day plan, owed within-session state, and the trailing-hour ring
    // exactly. Only the CURRENT generation persists — a stale step's is wrong.
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

  /**
   * ONE pass over the mode's rule table: gather each rule's DECLARED facts, ask
   * it to decide, and perform the FIRST verdict returned. The gathered object
   * carries exactly `needs` — the widened `Rule` erased which keys those were,
   * so the cast is the seam (`tests/engine/rules.test.ts` guards it). The final
   * rule always claims the tick, so the `null` fallback is unreachable.
   */
  private async runProgram(token: AbortController): Promise<StepResult> {
    const claim = await decideProgram({ mode: 'growth' }, async (needs) =>
      (await this.facts.collect(needs)) as Facts,
    );
    return claim === null ? 'idle' : this.perform(claim.verdict, token);
  }

  /**
   * Perform the single verdict a rule returned. A `halt` with a null reason is
   * "this generation is superseded, or we already halted" — stop the step
   * without minting a new halt; a `park` performs the one wait its key names.
   */
  private async perform(verdict: RuleVerdict, token: AbortController): Promise<StepResult> {
    switch (verdict.do) {
      case 'halt':
        return verdict.reason === null ? 'aborted' : this.halt(verdict.reason);
      case 'park':
        await this.engineWait(verdict.spec.key, verdict.spec.delay);
        return verdict.spec.step;
      case 'run':
        return this.runEffect(verdict.effect, token);
      case 'yield':
        return 'idle';
      default:
        return absurd(verdict);
    }
  }

  /** The ONE effect a run verdict asks for (ADR 0205: at most one per iteration). */
  private async runEffect(effect: EffectRef, token: AbortController): Promise<StepResult> {
    if (effect.id !== 'idle' && effect.id !== 'serve-recovery-hold' && this.deps.validateIdentity) {
      const valid = await this.deps.validateIdentity();
      if (this.superseded(token)) return 'aborted';
      if (!valid) return this.halt({ kind: 'identity-changed' });
    }
    switch (effect.id) {
      case 'serve-recovery-hold':
        return this.serveRecoveryHold(token);
      case 'enter-recovery':
        return this.enterRecovery(token, effect.kind);
      case 'bootstrap-seed-target':
        return this.targets.bootstrapSeedTarget();
      case 'sweep-followback': {
        const result = await this.reconciliation.run(effect.now, () => this.superseded(token));
        if (result.outcome === 'aborted') return 'aborted';
        this.actionDelayDeadline = this.deps.store.getActionDelayDeadline();
        if (result.outcome === 'halt') return this.halt({ kind: 'reconciliation-failed' });
        if (result.outcome === 'wait') {
          await this.engineWait('engine:enrich-backoff', result.delayMs);
          return 'idle';
        }
        const at = this.deps.clock.now();
        this.sweepCadence.markRun(at);
        this.deps.churn.advanceTimers(at);
        this.noteProgress('relationships-reconciled');
        await this.pacingSleep();
        return 'swept-followback';
      }
      case 'refill-pool': {
        this.refillSinceAction = true;
        const result = await this.targets.refillPool(effect.target, token);
        return result;
      }
      case 'churn-action':
        return this.performAction(effect.now, token, (actAt) =>
          this.actChurn(effect.record, actAt, token),
        );
      case 'woven-unfollow':
        return this.performAction(effect.now, token, (actAt) =>
          this.actWovenUnfollow(effect.candidate, actAt, token),
        );
      case 'advance-chain':
        return this.advanceChain(effect.target);
      case 'idle':
        await this.engineWait('engine:idle', ENGINE_IDLE_MS);
        return 'idle';
      default:
        return absurd(effect);
    }
  }

  /** The Engine's fact sources (see `engine-facts.ts`). Built once. */
  private buildFactSources(): FactSources {
    const { clock, rate, store, churn, sentinel } = this.deps;
    return buildEngineFactSources({
      clock,
      rate,
      store,
      churn,
      sentinel,
      recovery: this.recovery,
      pacing: this.pacing,
      targets: this.targets,
      sweepCadence: this.sweepCadence,
      actionsFailingHalt: ACTIONS_FAILING_HALT,
      yieldRefill: () => this.refillSinceAction,
      rotationReason: () => this.deps.frontier ? this.targets.rotationReason() : null,
      requiresReconciliation: (now) => this.deps.reentry?.requiresReconciliation(now) ?? false,
      refillAvailableAt: () => this.targets.refillAvailableAt(),
      settings: () => this.settings,
      aborted: () => this.superseded(this.stepToken),
      halted: () => this.engineState === 'halted',
      onSentinel: (status) => {
        this.lastSentinel = status;
      },
      selectPruneCandidate: (now) => this.selectPruneCandidate(now),
      rng: () => this.rng(),
    });
  }

  /**
   * THE one Instagram action per iteration — a growth/lifecycle churn action
   * or, in the organic model with prune woven in, an interleaved prune unfollow
   * drawn from the SAME stream. Returns null when neither stream has work.
   */
  private async performAction(
    now: number,
    token: AbortController,
    act: (actAt: number) => Promise<ActionOutcome>,
  ): Promise<StepResult> {
    const probationUntil = this.deps.reentry?.mutationWaitUntil(now);
    if (probationUntil !== null && probationUntil !== undefined) {
      await this.engineWait('engine:action-delay', probationUntil - now);
      return 'idle';
    }
    // Pay down an OWED remainder first (armed by a previous action whose delay a
    // pause/offline aborted). Interruptible: a fresh pause during the remainder
    // leaves the deadline armed and parks without acting.
    if (this.actionDelayDeadline !== null) {
      const remaining = this.actionDelayDeadline - now;
      if (remaining > 0) {
        const res = await this.engineWait('engine:action-delay', remaining);
        // Aborted with the remainder still owed: NOTHING was acted on — report
        // 'idle' so lastStep/lastActionAt stay truthful.
        if (!res.completed) return 'idle';
      }
      this.setActionDeadline(null);
    }

    const actAt = this.deps.clock.now();
    this.refillSinceAction = false;
    const outcome = await act(actAt);
    if (outcome.kind === undefined) return outcome.step;

    this.lastActionAt = actAt;
    // Arm the delay deadline BEFORE waiting: if a pause/stop/quit lands during
    // the action (or the wait), the persisted deadline survives so the next
    // resume — or app launch — serves the remainder.
    this.setActionDeadline(Math.max(this.deps.store.getActionDelayDeadline() ?? 0,
      actAt + this.pacer.noteAction(actAt, outcome.kind)));
    if (this.stateNow() !== 'paused' && !this.superseded(token)) {
      const remaining = (this.actionDelayDeadline ?? 0) - this.deps.clock.now();
      const res = await this.engineWait('engine:action-delay', remaining);
      if (res.completed) this.setActionDeadline(null);
    }
    return 'acted';
  }

  /** One woven prune unfollow: the feed owns the ledger row + edge reconcile. */
  private async actWovenUnfollow(
    cand: FeedCandidate,
    actAt: number,
    token: AbortController,
  ): Promise<ActionOutcome> {
    const status = await this.unfollowFeed.executeUnfollow(cand, actAt);
    // A stop()+start() landed during the await: the new generation owns pacing
    // now — bail before recording, arming, or serving anything.
    if (this.superseded(token)) return { step: 'aborted' };
    const detail = this.unfollowFeed.lastActionOutcome?.();
    if (status === 'blocked') {
      if (detail?.cause === 'rate-limited') return { step: await this.enterRecovery(token, 'rate-limited') };
      // The journal retains unresolved effects; no failed attempt consumes the candidate.
      await this.engineWait('engine:prune-park', PRUNE_TIMING.PARK_MS);
      return { step: 'idle' };
    }
    if (status === 'ok' && !detail?.alreadyInState) {
      this.deps.reentry?.noteAction(actAt);
      this.noteProgress('mutation-verified');
    }
    return { kind: 'unfollow' };
  }

  /** One lifecycle churn action, with the ladder's breakers on its outcome. */
  private async actChurn(
    rec: FollowRecord,
    actAt: number,
    token: AbortController,
  ): Promise<ActionOutcome> {
    const outcome = await this.deps.churn.execute(rec, actAt);
    // A stop()+start() landed during the await: the superseded step's owed gap
    // is dropped rather than allowed to overwrite the new run's deadline.
    if (this.superseded(token)) return { step: 'aborted' };

    if (outcome === 'blocked') {
      if (this.deps.churn.lastBlockedCause() === 'local-policy') {
        await this.engineWait('engine:idle', ENGINE_IDLE_MS);
        return { step: 'idle' };
      }
      // Nothing was clicked and the record is untouched. Re-driving the SAME
      // record at full pace hammers the wall invisibly — park briefly instead,
      // and ladder up once the streak (or IG's own verdict) proves a wall.
      this.recovery.noteOutcome('rate-limited');
      const blockedStreak = this.deps.churn.streaks().blocked;
      if (this.deps.churn.lastBlockedCause() === 'rate-limited') {
        // A definitive server refusal: every further attempt deepens the block.
        log.warn('engine: Instagram refused the action as rate-limited — entering recovery', {
          blockedStreak,
        });
        return { step: await this.enterRecovery(token, 'rate-limited') };
      }
      if (blockedStreak >= RECOVERY_TIMING.BLOCKED_STREAK_ENTRY) {
        return { step: await this.enterRecovery(token, 'rate-limited') };
      }
      log.info('engine: action blocked — short park before the next attempt', { blockedStreak });
      await this.engineWait('engine:blocked-park', PRUNE_TIMING.PARK_MS);
      return { step: 'idle' };
    }

    // Systemic-breakage breaker: when every action fails identically across
    // records the problem is the machinery, so enter the ladder instead of
    // burning the queue on clicks that do nothing. An ALL-drift window carries
    // drift evidence; anything ambiguous is presumed rate-limited.
    const { failed, drift } = this.deps.churn.streaks();
    if (failed >= this.recovery.failingEntryThreshold(ACTIONS_FAILING_HALT)) {
      const kind: FailureKind = drift >= failed ? 'drift' : 'rate-limited';
      return { step: await this.enterRecovery(token, kind) };
    }
    if ((outcome === 'ok' && !this.deps.churn.lastActionOutcome?.()?.alreadyInState) || outcome === 'simulated') {
      this.noteProgress(outcome === 'ok' ? 'mutation-verified' : 'simulation-completed');
      if (outcome === 'ok') {
        this.deps.reentry?.noteAction(actAt);
        if (rec.state === 'queued') this.deps.frontier?.noteFollow(rec.targetPk, actAt);
      }
      // Only a verified new mutation clears the recovery incident.
      const incident = this.recovery.noteRecovered();
      if (incident !== null) this.healIncidentWindow(incident);
    }
    return { kind: rec.state === 'unfollow_queued' ? 'unfollow' : 'follow' };
  }

  /**
   * Advance past a spent target. On a dead end, one self-heal pass first:
   * re-verify the most recently exhausted target — an exhaustion stamped during
   * a rate-wall/drift window is absence of evidence. The CURRENT target just
   * latched on fresh drain evidence, so it can never revive itself.
   */
  private async advanceChain(current: CurrentTarget): Promise<StepResult> {
    const advance = await this.deps.chain.advance(current.pk, this.targets.rotationReason() ?? undefined);
    if (advance.nextTargetPk !== null) {
      this.targets.adoptTarget(advance.nextTargetPk);
      this.noteProgress('source-rotated');
      log.info('engine: advanced chain', {
        from: current.pk,
        to: advance.nextTargetPk,
        source: advance.source,
      });
      // The next step will typically re-acquire for the new target right away —
      // interpose the jittered pacing pause before it can.
      if (
        queuedCountFor(this.deps.store, advance.nextTargetPk) < this.settings.lowWaterCandidates
      ) {
        await this.pacingSleep();
      }
      return 'advanced-chain';
    }
    if (advance.retryAt !== undefined) {
      await this.engineWait('engine:idle', Math.min(ENGINE_IDLE_MS, Math.max(1, advance.retryAt - this.deps.clock.now())));
      return 'idle';
    }
    this.targets.markRevived(current.pk);
    const revived = this.targets.reviveRecentExhausted();
    if (revived !== null) {
      this.targets.adoptTarget(revived);
      return 'advanced-chain';
    }
    return this.halt({ kind: 'chain-exhausted' });
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
  private selectPruneCandidate(now: number): FeedCandidate | null {
    if (this.pacing === undefined || !this.settings.weaveEnabled) return null;
    const feed = this.unfollowFeed;
    if (feed.atDailyCap(now)) return null;
    return feed.nextCandidate(now);
  }

  // --- Recovery ladder (docs/adr/0201-recovery-ladder.md) ----------------------------

  /**
   * Enter the ladder with a classified failure `kind`: diagnose the tab FIRST (a
   * sick tab consumes no rung and touches no records), then presume a rate wall
   * and serve the next rung's hold. Terminal: `recovery-exhausted` once the rungs
   * are spent, `adapter-drift` once drift is CONFIRMED.
   */
  private async enterRecovery(token: AbortController, kind: FailureKind): Promise<StepResult> {
    // Defensive: an already-armed hold is served, never double-entered.
    if (this.recovery.phase() === 'holding') return this.serveRecoveryHold(token);

    this.recovery.noteOutcome(kind);
    // Each rung burns a fresh window of ledger rows — clear every streak.
    this.deps.churn.resetStreaks();
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
      return this.halt({ kind: 'adapter-drift' });
    }

    const hold = this.recovery.beginHold(this.deps.clock.now());
    if (hold === null) {
      return this.halt({ kind: 'recovery-exhausted' });
    }
    log.warn('engine: recovery hold begins', {
      attempt: hold.attempt,
      maxAttempts: this.recovery.maxAttempts(),
      holdMs: hold.holdMs,
      resumesAt: new Date(this.deps.clock.now() + hold.holdMs).toISOString(),
    });
    return this.serveRecoveryHold(token);
  }

  /** Heal what a just-closed incident window systemically burned (once per reset). */
  private healIncidentWindow(incident: RecoveryIncident): void {
    healIncidentWindow(this.deps.store, incident, this.deps.clock.now());
  }

  /**
   * Serve the armed hold's REMAINDER — an absolute deadline, durable across
   * pause/offline/stop and app relaunches. An interrupted wait leaves the
   * deadline armed for the next opportunity; a wait served to completion moves
   * the ladder to probing, and the next real actions ARE the probe.
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
    await diag.recoverTab();
    try {
      this.lastSentinel = await this.deps.sentinel.check();
      log.info('engine: post-recovery sentinel', { status: this.lastSentinel });
    } catch (e) {
      log.warn('engine: post-recovery sentinel check failed', { error: String(e) });
    }
  }

  // --- Halt / status ----------------------------------------------------------------

  /** Terminal stop. The reason is typed here and serialized once, so the status
   *  surface, `onHalt`, and `lastHaltInfo` all speak the same vocabulary. */
  private halt(reason: HaltReason): 'halted' {
    const key = haltReasonKey(reason);
    this.engineState = 'halted';
    this.haltReason = key;
    this.lastHalt = { reason: key, at: this.deps.clock.now() };
    log.warn('engine: halted', { reason: key });
    this.deps.onHalt?.(key);
    return 'halted';
  }

  /**
   * The most recent halt (reason + when), STICKY across restarts — the
   * scheduled-prune rate-limit cool-down reads this even after the user has
   * started growth again. Null when no halt has happened yet.
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

  private noteProgress(phase: string): void {
    const now = this.deps.clock.now();
    this.health.progress(phase, now);
    this.deps.reentry?.noteProgress(now);
    this.deps.onProgress?.(phase);
  }

  // --- Waits --------------------------------------------------------------------------

  /**
   * Wait under a namespaced key through the ONE gate ({@link WaitRunner}), linked
   * to the CURRENT run-generation token: no wait outlives a control command, and
   * the manager's per-key replace guard keeps a stale generation's wait from
   * shadowing the new run's.
   */
  private engineWait(key: EngineWaitKey, policyOrMs: DelayPolicy | number): Promise<WaitResult> {
    return this.waits.wait(key, policyOrMs);
  }

  /** The CURRENT run-generation abort signal (adapter waits link to this). */
  runSignal(): AbortSignal {
    return this.runAbort.signal;
  }

  /**
   * The short jittered pause ending every branch that issued Instagram traffic
   * OUTSIDE the action gate (acquire / enrich / sweep / chain advance), so no
   * branch can hammer back-to-back. The between-reads floor, not the paced
   * inter-action delay.
   */
  private async pacingSleep(): Promise<void> {
    await this.engineWait(
      'engine:refill-pacing',
      uniform(REFILL_PACING_MIN_MS, REFILL_PACING_MAX_MS),
    );
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

/** Pure factory for the composition root; no wiring lives here. */
export function createEngine(deps: EngineDeps): Engine {
  return new Engine(deps);
}

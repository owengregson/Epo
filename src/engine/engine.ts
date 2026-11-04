/**
 * The conductor: composes the pure engine components (Churn Scheduler, Scanner,
 * Chain Controller, Follow-back Watcher) and the rim ports into one safe, paced,
 * interruptible running system.
 *
 * One interruptible wait owner and one rule verdict per iteration (ADRs 0205/0902).
 * Ports, clock and sleep are injected so lifecycle transitions can be simulated.
 */

import type { SentinelStatus } from '../adapter/sentinel';
import { tempoOrReference } from '../kernel/tempo';
import type { Settings } from '../settings/settings';
import { ENGINE as ENGINE_TIMING } from '../timing/config';
import type { WaitResult } from '../timing/delay-manager';
import { mulberry32 } from '../timing/noise';
import { type DelayPolicy, type Rng, TIMED_OUT, withTimeout } from '../timing/primitives';
import { WaitRunner } from '../timing/wait-runner';
import * as log from '../utils/logger';
import { absurd } from './absurd';
import { queuedCountFor } from './decisions';
import { actChurn, actWovenUnfollow, type EngineActionContext, performAction } from './engine-actions';
import { buildEngineFactSources } from './engine-facts';
import { type EngineJournalContext, settleJournalStep } from './engine-journal-effects';
import { type EngineSweepContext, runFollowbackSweep } from './engine-sweep-effects';
import {
  ENGINE_WAIT_CLASS,
  type EngineParkReason,
  type EngineWaitKey,
  idleBaseMs,
  parkReasonFor,
} from './engine-waits';
import { FactGatherer, type FactSources, type Facts, type FeedCandidate } from './facts';
import { type HaltReason, haltReasonKey } from './halt-reason';
import { cleanupCooldown } from './plan-mix';
import type { EngineTempo } from './plan-port';
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
import { selectWovenCandidate } from './prune-feed';
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

/** What the effect steps run against: one view of the Engine for every extracted step. */
type EngineEffectContext = EngineActionContext & EngineJournalContext & EngineSweepContext;

export class Engine {
  private readonly health: RuntimeHealth;
  private refillSinceAction = false;
  private readonly deps: EngineDeps & EngineTempo;
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

  /** The chain target being worked and its bounded refill cycle. */
  private readonly targets: TargetPipeline;

  /** The plan: the one pacing model (see {@link EngineDeps.pacing}). */
  private readonly pacing: EnginePacing;

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

  /** Per-install noise entropy (see {@link EngineDeps.installEntropy}). */
  private readonly installEntropy: number;

  /**
   * The DEDICATED timing-noise rng — never a seeded decision stream. Noise must not consume a
   * seeded stream, or every downstream draw shifts
   * (`docs/adr/0204-timing-noise.md`). Seeded from the install entropy ⊕
   * construction time.
   */
  private readonly noiseRng: Rng;

  /** The context the extracted effect steps run against (see {@link effectContext}). */
  private readonly ctx: EngineEffectContext;

  constructor(deps: EngineDeps & EngineTempo) {
    this.deps = deps;
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
          this.deps.reentry?.holdUntil(deadline); // a hold the engine chose is presence, never absence
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
          // Over however it ended (elapsed, pause, offline, stop); the step's status emit publishes the clear.
          this.deps.reentry?.endHold(this.deps.clock.now());
          if (park !== null) this.park = null;
        },
      },
    });
    this.sweepCadence = deps.sweepCadence;
    this.settings = deps.settings;
    // GATING is pure (`pacingVerdict` over the plan's facts); the gap is armed at dispatch and owed
    // in the store (`action_delay_deadline_at`), so a pause, a stop or a quit serves its remainder.
    this.pacing = deps.pacing;
    this.unfollowFeed = deps.unfollowFeed;
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
      clock: deps.clock, tempo: deps.tempo,
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
    this.ctx = this.effectContext();
  }

  /** One view of the Engine for `engine-actions.ts` and the sweep effects; the accessors write through. */
  private effectContext(): EngineEffectContext {
    const engine = this;
    return {
      deps: this.deps,
      recovery: this.recovery,
      unfollowFeed: this.unfollowFeed,
      actionsFailingHalt: ACTIONS_FAILING_HALT,
      sweepCadence: this.sweepCadence,
      get refillSinceAction() { return engine.refillSinceAction; },
      set refillSinceAction(v) { engine.refillSinceAction = v; },
      get lastActionAt() { return engine.lastActionAt; },
      set lastActionAt(at) { engine.lastActionAt = at; },
      stateNow: () => this.stateNow(),
      superseded: (token) => this.superseded(token),
      engineWait: (key, policyOrMs) => this.engineWait(key, policyOrMs),
      idleWait: (now) => this.idleWait(now),
      enterRecovery: (token, kind) => this.enterRecovery(token, kind),
      noteProgress: (phase) => this.noteProgress(phase),
      healIncidentWindow: (incident) => this.healIncidentWindow(incident),
      pacingSleep: () => this.pacingSleep(),
    };
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
      lastActionAt: this.lastActionAt ?? this.deps.store.feed.lastSettledMutationAt(), // a relaunch shows the last settled write
      sessionStartedAt: this.sessionStartedAt,
      // The live wait's deadline when one is pending; otherwise the OWED
      // deadline a pause/offline hold interrupted (so the countdown survives a
      // hold and reflects the remainder that will be served on resume).
      nextActionAt: this.waits.nextDeadline('engine:action-delay') ?? this.owedDeadline(),
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
        await this.engineWait('engine:transient-backoff', tempoOrReference(this.deps.tempo).base('beat.transient'));
        result = 'idle';
      }
    }
    this.lastStep = result;
    this.emitStatus();
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
      case 'settle-journal':
        return settleJournalStep(this.ctx, token);
      case 'sweep-followback':
        return runFollowbackSweep(this.ctx, token);
      case 'refill-pool': {
        this.refillSinceAction = true;
        const result = await this.targets.refillPool(effect.target, token);
        return result;
      }
      case 'churn-action':
        return performAction(this.ctx, effect.now, token, (actAt) =>
          actChurn(this.ctx, effect.record, actAt, token),
        );
      case 'woven-unfollow':
        return performAction(this.ctx, effect.now, token, (actAt) =>
          actWovenUnfollow(this.ctx, effect.candidate, actAt, token),
        );
      case 'advance-chain':
        return this.advanceChain(effect.target);
      case 'idle':
        await this.idleWait(this.deps.clock.now());
        return 'idle';
      default:
        return absurd(effect);
    }
  }

  /** The Engine's fact sources (see `engine-facts.ts`). Built once. */
  private buildFactSources(): FactSources {
    const { clock, rate, store, churn, sentinel } = this.deps;
    return buildEngineFactSources({
      clock, rate,
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
      settlesJournal: this.deps.settleJournal !== undefined,
      refillAvailableAt: () => this.targets.refillAvailableAt(),
      settings: () => this.settings,
      aborted: () => this.superseded(this.stepToken),
      halted: () => this.engineState === 'halted',
      onSentinel: (status) => {
        this.lastSentinel = status;
      },
      selectPruneCandidate: (now) => this.selectPruneCandidate(now),
      cleanupCooldown: (now) => cleanupCooldown({ lastHalt: this.lastHalt, ladder: this.recoverySnapshot() }, now),
    });
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
      await this.idleWait(this.deps.clock.now(), [advance.retryAt]);
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
   * The idle beat (spec §5.16): until the earliest FUTURE event the loop knows of — the open session's
   * close, the next session, the owed deadline, the refill's reopening, `extra` — bounded by the
   * `beat.transient` base (the staleness bound) and floored at two perception frames.
   */
  private idleWait(now: number, extra: readonly number[] = []): Promise<WaitResult> {
    const view = this.pacing.view(now);
    const open = view.open === null ? null : (view.sessions[view.open.idx]?.closesAt ?? null);
    const events = [view.nextSessionAt, open, this.deps.store.getActionDelayDeadline(), this.targets.refillAvailableAt(), ...extra];
    return this.engineWait('engine:idle', idleBaseMs(now, events, tempoOrReference(this.deps.tempo).base('beat.transient')));
  }

  /** The deadline the last dispatch armed, while it is still owed. */
  private owedDeadline(): number | null {
    const at = this.deps.store.getActionDelayDeadline();
    return at !== null && at > this.deps.clock.now() ? at : null;
  }

  /** The next woven prune-unfollow candidate, or null (see `prune-feed.ts`). */
  private selectPruneCandidate(now: number): FeedCandidate | null {
    return selectWovenCandidate({ pacing: this.pacing, settings: this.settings, unfollowFeed: this.unfollowFeed }, now);
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
      tempoOrReference(this.deps.tempo).policy('pause.after-task'),
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
export function createEngine(deps: EngineDeps & EngineTempo): Engine {
  return new Engine(deps);
}

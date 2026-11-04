/**
 * The target pipeline: which chain target the loop works, and the bounded refill cycle that stocks its
 * queue — at most one acquisition, {@link MAX_ENRICH_PASSES_PER_CYCLE} enrichment passes, then a plan;
 * only a plan that enqueued something opens another cycle (`docs/adr/0203-refill-cycle.md`).
 */

import type { Clock } from '../governors/clock';
import { tempoOrReference } from '../kernel/tempo';
import { type AcquireEndReason, isAcquireFailure } from '../rim/follower-acquisition';
import type { EffectiveSettings } from '../settings/effective';
import type { KnowledgeStore } from '../store/knowledge-store';
import { RECOVERY as RECOVERY_TIMING } from '../timing/config';
import type { WaitResult } from '../timing/delay-manager';
import * as log from '../utils/logger';
import { unenrichedUsernames } from './decisions';
import type { EngineWait } from './engine-waits';
import { EXPLORATION_POLICY, weeklyCycleSince } from './exploration-policy';
import type { HaltReason } from './halt-reason';
import type { EnginePlan, EngineTempo } from './plan-port';
import { ACQUIRE_DRAIN_REASONS, type CurrentTarget, type EngineAcquisition, type EngineEnricher, type EngineScanner,
  type StepResult } from './ports';
import type { FailureKind } from './recovery';
import { peekResumeTarget } from './resume-target';
import type { SourceFrontier, SourceVisitEndReason } from './source-frontier';
import { acquisitionFailureBackoff, reviveRecentExhausted } from './target-recovery';

/** At most this many candidate usernames are enriched per pass. */
export const ENRICH_BATCH_SIZE = EXPLORATION_POLICY.profilesPerSlice;

/** One bounded profile slice before planning; only verified list evidence concludes an audience ended. */
export const MAX_ENRICH_PASSES_PER_CYCLE = EXPLORATION_POLICY.maxEnrichPassesPerCycle;

/** Acquisition waits while the unacted pool holds this many plans' worth: selection never runs pool-starved. */
export const ACQUIRE_SKIP_POOL_FACTOR = EXPLORATION_POLICY.skipPoolFactor;

/** Everything the pipeline needs; the Engine supplies its own gates as callbacks. */
export interface TargetPipelineDeps extends EngineTempo {
  store: KnowledgeStore;
  clock: Clock;
  acquisition: EngineAcquisition;
  scanner: EngineScanner;
  frontier?: SourceFrontier;
  enricher: EngineEnricher;
  /** Live settings — read through, so a runtime save takes effect immediately. */
  settings(): Pick<EffectiveSettings, 'seed'>;
  /** The Engine's noise-gated wait. */
  wait: EngineWait;
  /** The plan the slice, the read deferral and the freshness windows read (spec §5.16, §17.8). */
  plan: Pick<EnginePlan, 'view' | 'dayWindow'>;
  /** The loop's idle beat until the earliest of `events` and the plan's own (spec §5.16): exact, bounded, never hot. */
  idle(events: readonly number[]): Promise<WaitResult>;
  /** Route a repeatedly-walled read into the recovery ladder. */
  recover(token: AbortController, kind: FailureKind): Promise<StepResult>;
  /** Terminal stop with a typed reason. */
  halt(reason: HaltReason): 'halted';
}

export class TargetPipeline {
  private readonly deps: TargetPipelineDeps;

  /** The target being worked, or null before the first resolution. */
  current: CurrentTarget | null = null;

  /** Refill-cycle guards: a FAILED read leaves `acquiredThisCycle` unset (the retry re-acquires); exhaustion needs drain evidence. */
  private acquiredThisCycle = false;
  private enrichPassesThisCycle = 0;
  /** Profiles enriched this cycle — "pool being worked through" vs "walled". */
  private enrichedThisCycle = 0;
  private exhausted = false;
  /** The latest GENUINE acquire end reason: the evidence the latch consults. */
  private lastAcquireEnd: AcquireEndReason | null = null;
  /** Consecutive cycles whose acquire completed but bounded only a slice. */
  private sliceReopens = 0;
  /** Consecutive WALLED cycles (a read wall); the ladder entry counts these. */
  private walledCycles = 0;
  /** Targets already granted their ONE dead-end re-verify this run. */
  private readonly revivedTargets = new Set<string>();
  private readDeferredUntil = 0;

  constructor(deps: TargetPipelineDeps) {
    this.deps = deps;
  }

  /** Whether the current target's pool is spent with drain evidence. */
  isExhausted(): boolean {
    return this.exhausted;
  }

  /** Budget rotation remains distinct from evidence that a list ended. */
  rotationReason(): SourceVisitEndReason | null {
    if (this.current === null) return null;
    if (this.exhausted) return this.lastAcquireEnd === null ? 'low-yield'
      : this.lastAcquireEnd === 'coverage-cap' ? 'coverage-policy' : 'verified-ended';
    return this.deps.frontier?.rotationReason(this.current.pk) ?? null;
  }

  refillAvailableAt(): number { return this.readDeferredUntil; }

  /** Optional reads wait until `retryAt`; a refusal naming no instant waits for the plan-day's end (spec §17.8). */
  private deferReads(retryAt: number | undefined, why = 'durable budget'): 'idle' {
    this.readDeferredUntil = retryAt ?? this.deps.plan.view(this.deps.clock.now()).window.endsAt;
    log.info('engine: optional reads deferred', { why, resumesAt: this.readDeferredUntil });
    return 'idle';
  }

  /** A manual start re-earns every exhausted target its ONE re-verify. */
  clearRevived(): void {
    this.revivedTargets.clear();
  }

  /** Mark `pk` as having consumed its re-verify (the dead-end path). */
  markRevived(pk: string): void {
    this.revivedTargets.add(pk);
  }

  /**
   * Forget the in-memory target so the next start() re-adopts the store's
   * ACTIVE front — store-side chain edits between runs then take effect.
   */
  forget(): void {
    this.current = null;
  }

  /**
   * Adopt the store's active target with the highest chainIndex (the front of the
   * chain), if any. Free — no IG traffic. Returns whether a target was adopted.
   */
  adoptActiveTargetFromStore(): boolean {
    const pick = peekResumeTarget(this.deps);
    if (pick === null) return false;
    if (pick.ready !== undefined) {
      const existing = pick.ready.existing;
      if (existing === null) this.deps.store.addTarget({ accountPk: pick.pk, source: pick.ready.source,
        status: 'active', chainIndex: this.deps.store.nextChainIndex() });
      else if (existing.status === 'exhausted') this.deps.store.setTargetStatus(pick.pk, 'active');
    }
    this.adoptTarget(pick.pk);
    return true;
  }

  /**
   * First run ever: resolve `settings.seed` to a pk via one acquisition pass, record
   * it as the chain's target #0, and plan its candidates. Costs the step (it IS an
   * acquisition), so it returns `'acquired'` — or halts when the seed is missing or
   * cannot be resolved (there is nothing safe to do without a target).
   */
  async bootstrapSeedTarget(): Promise<StepResult> {
    if (this.deps.frontier !== undefined && this.deps.frontier.snapshot().sources.length > 0) {
      const resumeAt = this.deps.frontier.nextResumeAt();
      await this.deps.idle(resumeAt === null ? [] : [resumeAt]);
      return 'idle';
    }
    const seed = this.deps.settings().seed.trim();
    if (seed === '') return this.deps.halt({ kind: 'seed-missing' });

    const acquired = await this.deps.acquisition.acquire(seed);
    if (acquired.endReason === 'read-budget') {
      this.deferReads('retryAt' in acquired && typeof acquired.retryAt === 'number' ? acquired.retryAt : undefined);
      await this.deps.idle([this.readDeferredUntil]);
      return 'idle';
    }
    const targetPk = acquired.targetPk;
    if (targetPk === null) return this.deps.halt({ kind: 'seed-unresolved' });

    // NEVER silently resurrect a burned-out chain (re-adding an exhausted seed corrupts the lineage on
    // every restart); a RECENT evidence-stamped exhaustion may be an outage artifact, so it is
    // re-verified once before the terminal halt. Restart-from-seed is the sanctioned way back in.
    if (this.deps.store.getTarget(targetPk)?.status === 'exhausted') {
      const revived = this.reviveRecentExhausted();
      if (revived === null) return this.deps.halt({ kind: 'chain-exhausted' });
      this.adoptTarget(revived);
      return 'advanced-chain';
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
    this.deps.frontier?.beginVisit(targetPk, 'seed');
    // Only a GENUINELY completed read consumes the first cycle's acquisition
    // (and records latch evidence) — a failed seed read (a rate wall at first
    // contact) leaves step 7 free to retry instead of planning an empty pool
    // straight into the exhaustion latch.
    const failed = isAcquireFailure(acquired.endReason);
    this.acquiredThisCycle = !failed;
    this.lastAcquireEnd = failed ? null : acquired.endReason;
    this.enrichPassesThisCycle = 0;
    this.enrichedThisCycle = 0;
    this.sliceReopens = 0;
    this.exhausted = false;
    const plan = this.deps.scanner.planTarget(targetPk);
    if (plan.queued.length > 0) this.acquiredThisCycle = false;
    log.info('engine: seed target bootstrapped', {
      seed,
      targetPk,
      queued: plan.queued.length,
      endReason: acquired.endReason,
    });
    return 'acquired';
  }

  /** Make `pk` the current target and reset the refill-cycle guards for it. */
  adoptTarget(pk: string): void {
    this.current = { pk, username: this.deps.store.getAccount(pk)?.username ?? null };
    this.deps.frontier?.beginVisit(pk, this.deps.store.getTarget(pk)?.source ?? 'discovered');
    this.acquiredThisCycle = false;
    this.enrichPassesThisCycle = 0;
    this.enrichedThisCycle = 0;
    this.walledCycles = 0;
    this.lastAcquireEnd = null;
    this.sliceReopens = 0;
    this.exhausted = false;
  }

  /** Legacy targets get one evidence-based recheck per run. */
  reviveRecentExhausted(): string | null {
    return reviveRecentExhausted(this.deps, this.revivedTargets);
  }

  /**
   * One bounded refill slice: acquire when stored prospects are insufficient,
   * enrich at most one profile batch, then plan on the next firing. The frontier
   * defers unproductive visits; only observed drain evidence closes the source.
   * Read-budget refusal records a deadline without blocking existing actions.
   */
  async refillPool(current: CurrentTarget, token: AbortController): Promise<StepResult> {
    this.deps.scanner.reconsiderTarget?.(current.pk, this.deps.clock.now());

    // (1) At most one acquisition per cycle — and NONE while the store holds several plans' worth of
    // unscored prospects for this target (more pages would be pure request waste).
    const now = this.deps.clock.now();
    const view = this.deps.plan.view(now);
    if (!this.acquiredThisCycle) {
      const rawPool = this.deps.store.candidatePksForTarget(current.pk).length;
      // The skip bar: the factor times one source's share of today's follows (spec §17.8).
      const planCapacity = Math.min(view.plan.kinds.follow, EXPLORATION_POLICY.queuedPerSource);
      if (rawPool >= planCapacity * ACQUIRE_SKIP_POOL_FACTOR) {
        this.acquiredThisCycle = true;
        log.info('engine: raw pool sufficient, skipping acquisition', {
          pk: current.pk,
          rawPool,
        });
      } else if (current.username === null) {
        this.acquiredThisCycle = true;
        log.warn('engine: cannot acquire, target username unknown', { pk: current.pk });
      } else {
        const acquired = await this.deps.acquisition.acquire(current.username);
        this.deps.frontier?.noteAcquisition(current.pk, acquired.observed,
          'globallyNew' in acquired && typeof acquired.globallyNew === 'number' ? acquired.globallyNew : 0);
        if (acquired.endReason === 'read-budget') return this.deferReads(
          'retryAt' in acquired && typeof acquired.retryAt === 'number' ? acquired.retryAt : undefined);
        if (isAcquireFailure(acquired.endReason)) {
          // A FAILED read yields no evidence about the audience: the cycle's
          // acquisition opportunity stays UNCONSUMED (the retry after the
          // backoff re-acquires) and the exhaustion latch is untouched.
          return this.acquireFailedBackoff(current, acquired.endReason, token);
        }
        // Consume the cycle's acquisition only NOW — on a genuine completion —
        // and record its end reason as the latch's evidence.
        this.acquiredThisCycle = true;
        this.lastAcquireEnd = acquired.endReason;
      }
    }

    // (2) Up to one slice of candidates still lacking counts: the smaller of a slice and the open session's
    // explore reads (spec §5.16). A session with none leaves them to the next session — a zero slice is no wall.
    const freshSince = weeklyCycleSince((t) => this.deps.plan.dayWindow(t), now);
    const slice = Math.min(ENRICH_BATCH_SIZE, view.open?.readsLeft.explore ?? 0);
    const usernames = unenrichedUsernames(this.deps.store, current.pk, slice, freshSince);
    if (slice === 0 && unenrichedUsernames(this.deps.store, current.pk, 1, freshSince).length > 0) {
      return this.deferReads(view.nextSessionAt ?? view.window.endsAt, 'no explore reads this session');
    }

    // (3) Enrich them (bounded per cycle); the next firing scores what came back.
    if (usernames.length > 0 && this.enrichPassesThisCycle < MAX_ENRICH_PASSES_PER_CYCLE) {
      this.enrichPassesThisCycle += 1;
      const enriched = await this.deps.enricher.enrich(usernames);
      this.deps.frontier?.noteEnrichment(current.pk, usernames.length);
      this.enrichedThisCycle += enriched;
      const resumeAt = this.deps.enricher.budgetResumeAt?.();
      if (resumeAt !== undefined && resumeAt !== null) {
        this.enrichPassesThisCycle = 0;
        return this.deferReads(resumeAt);
      }
      log.info('engine: enriched candidates', {
        target: current.pk,
        requested: usernames.length,
        enriched,
        pass: this.enrichPassesThisCycle,
      });
      return 'acquired';
    }

    // (4) Plan — final for this cycle when it enqueues nothing.
    const plan = this.deps.scanner.planTarget(current.pk);
    this.deps.frontier?.notePlan(current.pk, plan.queued.length);
    if (plan.queued.length > 0) {
      this.acquiredThisCycle = false;
      this.enrichPassesThisCycle = 0;
      // Reset with its sibling guards: a stale positive count from THIS cycle
      // would otherwise make the NEXT cycle's rate wall read as "progressing"
      // and skip the long backoff exactly when it is needed (walls typically
      // land right after a burst of successful requests).
      this.enrichedThisCycle = 0;
      this.walledCycles = 0; // real progress — the read side is not walled
      this.sliceReopens = 0; // real progress — the list is still yielding
    } else if (unenrichedUsernames(this.deps.store, current.pk, 1, freshSince).length > 0) {
      // NOT exhaustion: candidates were never enriched. Enrichment delivering (a deep pool being worked
      // through) opens the next cycle; delivering NOTHING (a wall) parks LONG and retries — latching here
      // would burn the chain over an outage. The WALLED_CYCLES_ENTRY-th walled cycle enters recovery.
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
          return this.deps.recover(token, 'rate-limited');
        }
        log.warn('engine: refill starved by failed enrichment, backing off (target NOT exhausted)', {
          target: current.pk,
          walledCycles: this.walledCycles,
        });
        await this.deps.wait('engine:enrich-backoff', tempoOrReference(this.deps.tempo).base('backoff.walled'));
        return 'idle';
      }
      this.walledCycles = 0;
      this.acquiredThisCycle = false;
      log.info('engine: pool not exhausted, opening next enrichment cycle', {
        target: current.pk,
      });
    } else if (this.lastAcquireEnd !== null && !ACQUIRE_DRAIN_REASONS.has(this.lastAcquireEnd)) {
      // The LOCAL pool is spent, but the latest acquire only BOUNDED A SLICE
      // (demand met / page budget / known-rows window / stagnant) — the list
      // was never verified done, so this zero is designed, not exhaustion
      // evidence. Reopen the cycle's acquisition: the persisted cursor
      // resumes exactly where the slice stopped. Bounded against a long
      // known-only tail: from the walled-cycles threshold on, each reopen
      // first takes the long backoff so zero-yield slices can never hot-loop.
      this.acquiredThisCycle = false;
      this.enrichPassesThisCycle = 0;
      this.enrichedThisCycle = 0;
      this.sliceReopens += 1;
      log.info('engine: local pool spent but list not verified done — reopening acquisition', {
        target: current.pk,
        lastAcquireEnd: this.lastAcquireEnd,
        sliceReopens: this.sliceReopens,
      });
      if (this.sliceReopens >= RECOVERY_TIMING.WALLED_CYCLES_ENTRY) {
        await this.deps.wait('engine:enrich-backoff', tempoOrReference(this.deps.tempo).base('backoff.walled'));
        return 'idle';
      }
    } else if (this.lastAcquireEnd === null && current.username !== null) {
      // A local pool rejected by the scorer is not evidence about unread pages.
      // The next cycle must acquire before it can declare the source drained.
      this.acquiredThisCycle = false;
      this.enrichPassesThisCycle = 0;
      this.enrichedThisCycle = 0;
    } else {
      // POSITIVE evidence only: nothing plannable remains locally AND the
      // latest acquire either VERIFIED the list's end ('no-more-pages') or
      // deliberately closed it ('coverage-cap') — or no acquisition is
      // possible at all (username unknown / a wiring without one), where
      // latching is the only way the cycle terminates.
      this.exhausted = true;
    }
    log.info('engine: refill planned', {
      target: current.pk,
      queued: plan.queued.length,
      exhausted: this.exhausted,
      lastAcquireEnd: this.lastAcquireEnd,
    });
    return 'acquired';
  }

  private async acquireFailedBackoff(current: CurrentTarget, endReason: AcquireEndReason, token: AbortController): Promise<StepResult> {
    const result = await acquisitionFailureBackoff(this.deps, current.pk, endReason, token, this.walledCycles);
    this.walledCycles = result.walledCycles;
    return result.step;
  }
}

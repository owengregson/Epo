/**
 * The target pipeline: which chain target the loop is working, and the bounded
 * refill cycle that keeps its candidate queue stocked.
 *
 * A "cycle" is ONE bounded attempt to refill the current target's queue: at most
 * one acquisition, at most {@link MAX_ENRICH_PASSES_PER_CYCLE} enrichment passes,
 * then a final plan. Only demonstrated progress (a plan that enqueued something)
 * opens another cycle, so the loop can never hammer Instagram on a dry target.
 * See `docs/adr/0203-refill-cycle.md` for the evidence rules behind the
 * exhaustion latch.
 */

import type { Clock } from '../governors/clock';
import { type AcquireEndReason, isAcquireFailure } from '../rim/follower-acquisition';
import type { Settings } from '../settings/settings';
import type { KnowledgeStore } from '../store/knowledge-store';
import { ENGINE as ENGINE_TIMING, RECOVERY as RECOVERY_TIMING } from '../timing/config';
import * as log from '../utils/logger';
import { acquireFailureVerdict, unenrichedUsernames } from './decisions';
import type { EngineWait } from './engine-waits';
import type { HaltReason } from './halt-reason';
import {
  ACQUIRE_DRAIN_REASONS,
  type CurrentTarget,
  type EngineAcquisition,
  type EngineEnricher,
  type EngineScanner,
  type StepResult,
} from './ports';
import type { FailureKind } from './recovery';

/** At most this many candidate usernames are enriched per pass. */
export const ENRICH_BATCH_SIZE = 20;

/**
 * At most this many enrichment passes per refill cycle. Once exhausted, the
 * cycle plans with whatever counts it has; a plan that enqueues nothing then
 * marks the target exhausted — enrichment can never spin on a dry target.
 * Sized with {@link ENRICH_BATCH_SIZE} so a cycle profiles up to ~80 candidates
 * before its final plan, and the Scanner picks from a real pool.
 */
export const MAX_ENRICH_PASSES_PER_CYCLE = 4;

/**
 * Acquisition is skipped while the raw not-yet-acted-on pool already holds this
 * many PLANS' worth of prospects (pool >= factor x dailyPlanSize). The bar is a
 * MULTIPLE of a plan so selection never runs pool-starved.
 */
export const ACQUIRE_SKIP_POOL_FACTOR = 4;

/** Everything the pipeline needs; the Engine supplies its own gates as callbacks. */
export interface TargetPipelineDeps {
  store: KnowledgeStore;
  clock: Clock;
  acquisition: EngineAcquisition;
  scanner: EngineScanner;
  enricher: EngineEnricher;
  /** Live settings — read through, so a runtime save takes effect immediately. */
  settings(): Settings;
  /** The Engine's noise-gated wait. */
  wait: EngineWait;
  /** The short jittered pause that ends every branch which issued IG traffic. */
  pacingSleep(): Promise<void>;
  /** Route a repeatedly-walled read into the recovery ladder. */
  recover(token: AbortController, kind: FailureKind): Promise<StepResult>;
  /** Terminal stop with a typed reason. */
  halt(reason: HaltReason): 'halted';
}

export class TargetPipeline {
  private readonly deps: TargetPipelineDeps;

  /** The target being worked, or null before the first resolution. */
  current: CurrentTarget | null = null;

  /**
   * Refill-cycle guards. `acquiredThisCycle` means an acquisition GENUINELY
   * completed (or was rightly skipped); a FAILED read leaves it unset so the
   * retry re-acquires instead of planning an empty pool into exhaustion.
   * `targetExhausted` latches only on positive drain evidence.
   */
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

  constructor(deps: TargetPipelineDeps) {
    this.deps = deps;
  }

  /** Whether the current target's pool is spent with drain evidence. */
  isExhausted(): boolean {
    return this.exhausted;
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
  async bootstrapSeedTarget(): Promise<StepResult> {
    const seed = this.deps.settings().seed.trim();
    if (seed === '') return this.deps.halt({ kind: 'seed-missing' });

    const acquired = await this.deps.acquisition.acquire(seed);
    const targetPk = acquired.targetPk;
    if (targetPk === null) return this.deps.halt({ kind: 'seed-unresolved' });

    // NEVER silently resurrect a burned-out chain: with no ACTIVE target and
    // the seed already exhausted (a prior chain ran it dry), re-adding it at
    // index 0 would re-acquire, re-exhaust, and corrupt the chain lineage on
    // every restart. But before the terminal halt, the chain self-heal gets
    // its chance: a RECENT evidence-stamped exhaustion (the front of the
    // chain, possibly this very seed) may be an outage artifact, not a dry
    // chain — re-verify it once. Otherwise halting keeps the state visible;
    // an explicit restart-from-seed (the Settings action) is the sanctioned
    // way back in.
    if (this.deps.store.getTarget(targetPk)?.status === 'exhausted') {
      const revived = this.reviveRecentExhausted();
      if (revived === null) return this.deps.halt({ kind: 'chain-exhausted' });
      this.adoptTarget(revived);
      await this.deps.pacingSleep(); // the seed resolve was IG traffic — pace it.
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
    await this.deps.pacingSleep(); // the bootstrap IS an acquisition — pace it.
    return 'acquired';
  }

  /** Make `pk` the current target and reset the refill-cycle guards for it. */
  adoptTarget(pk: string): void {
    this.current = { pk, username: this.deps.store.getAccount(pk)?.username ?? null };
    this.acquiredThisCycle = false;
    this.enrichPassesThisCycle = 0;
    this.enrichedThisCycle = 0;
    this.walledCycles = 0;
    this.lastAcquireEnd = null;
    this.sliceReopens = 0;
    this.exhausted = false;
  }

  /**
   * The chain dead-end self-heal — the REVERSAL path for evidence-stamped
   * exhaustion: pick the most recently exhausted target whose `exhaustedAt`
   * stamp is younger than {@link RECOVERY_TIMING.EXHAUSTED_REVERIFY_WINDOW_MS}
   * and not yet re-verified this run, return it to 'active' in the store, and
   * hand it back for re-adoption — the next refill cycle retries its
   * acquisition ONCE. A re-exhaustion re-stamps it and the per-run set blocks
   * a second revive, so a genuinely dry chain still reaches the terminal
   * `chain-exhausted` halt. Deliberate retirements (no stamp —
   * restart-from-seed) are never revived. Null when nothing qualifies.
   */
  reviveRecentExhausted(): string | null {
    const now = this.deps.clock.now();
    const cutoff = now - RECOVERY_TIMING.EXHAUSTED_REVERIFY_WINDOW_MS;
    for (const t of this.deps.store.exhaustedTargetsSince(cutoff)) {
      if (this.revivedTargets.has(t.accountPk)) continue;
      this.revivedTargets.add(t.accountPk);
      this.deps.store.setTargetStatus(t.accountPk, 'active');
      log.warn('engine: chain dead-end — re-verifying recently exhausted target', {
        pk: t.accountPk,
        exhaustedAt: t.exhaustedAt ?? null,
        windowMs: RECOVERY_TIMING.EXHAUSTED_REVERIFY_WINDOW_MS,
      });
      return t.accountPk;
    }
    return null;
  }

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
   * can open another cycle. Every path that issued IG traffic ends with the
   * short jittered pacing pause, so no branch hammers back-to-back.
   */
  async refillPool(current: CurrentTarget, token: AbortController): Promise<StepResult> {
    let issuedTraffic = false;

    // (1) At most one acquisition per cycle — and NONE when the store already
    // holds several plans' worth of raw not-yet-acted-on followers for this
    // target: scraping more pages while un-scored prospects sit locally is
    // pure request waste. The bar is a MULTIPLE of a plan (not one plan) so
    // the Scanner always selects from a deep pool — a bar of exactly one plan
    // starved selection and queued whatever ratios the last shallow batch had.
    if (!this.acquiredThisCycle) {
      const rawPool = this.deps.store.candidatePksForTarget(current.pk).length;
      if (rawPool >= this.deps.settings().dailyPlanSize * ACQUIRE_SKIP_POOL_FACTOR) {
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
        issuedTraffic = true;
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

    // (2) Select up to a batch of candidate usernames still lacking counts.
    const usernames = unenrichedUsernames(this.deps.store, current.pk, ENRICH_BATCH_SIZE);

    // (3) Enrich them (bounded per cycle); the next firing scores what came back.
    if (usernames.length > 0 && this.enrichPassesThisCycle < MAX_ENRICH_PASSES_PER_CYCLE) {
      this.enrichPassesThisCycle += 1;
      const enriched = await this.deps.enricher.enrich(usernames);
      this.enrichedThisCycle += enriched;
      issuedTraffic = true;
      log.info('engine: enriched candidates', {
        target: current.pk,
        requested: usernames.length,
        enriched,
        pass: this.enrichPassesThisCycle,
      });
      await this.deps.pacingSleep();
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
      this.sliceReopens = 0; // real progress — the list is still yielding
    } else if (unenrichedUsernames(this.deps.store, current.pk, 1).length > 0) {
      // NOT exhaustion: candidates remain that were never successfully
      // enriched. Two very different situations land here:
      //  - enrichment IS delivering but everything scored so far was rejected
      //    (a deep pool being worked through) → open the next cycle promptly;
      //  - enrichment delivered NOTHING (rate wall / sentinel window) → park
      //    LONG and retry; latching exhaustion here would burn the chain
      //    irreversibly over a transient outage. The WALLED_CYCLES_ENTRY-th
      //    walled cycle escalates to the recovery ladder.
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
        await this.deps.wait('engine:enrich-backoff', ENGINE_TIMING.ENRICH_BACKOFF_MS);
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
        await this.deps.wait('engine:enrich-backoff', ENGINE_TIMING.ENRICH_BACKOFF_MS);
        return 'idle';
      }
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
    if (issuedTraffic) await this.deps.pacingSleep();
    return 'acquired';
  }

  /**
   * The refill path's response to a FAILED acquire ('shape-mismatch' /
   * 'fetch-failed' / 'sentinel-blocked' / 'stopped' / 'dialog-failed'): no
   * trustworthy evidence was read, so nothing latches and the cycle's
   * acquisition slot stays open for the retry. Failed reads share the
   * walled-cycle ladder with starved enrichment — the first entries take the
   * long enrich-backoff park (a rate wall must not spin the refill loop at
   * pacing speed); the {@link RECOVERY_TIMING.WALLED_CYCLES_ENTRY}-th in a row
   * enters the recovery ladder, carrying drift evidence when the read itself
   * reported shape drift.
   */
  private async acquireFailedBackoff(
    current: CurrentTarget,
    endReason: AcquireEndReason,
    token: AbortController,
  ): Promise<StepResult> {
    const verdict = acquireFailureVerdict(
      this.walledCycles,
      endReason,
      RECOVERY_TIMING.WALLED_CYCLES_ENTRY,
    );
    if (verdict.action === 'recover') {
      this.walledCycles = 0;
      log.warn('engine: acquisition failing repeatedly — entering recovery', {
        target: current.pk,
        endReason,
      });
      return this.deps.recover(token, verdict.kind);
    }
    this.walledCycles = verdict.walledCycles;
    log.warn('engine: acquire failed — backing off (cycle slot kept, target NOT exhausted)', {
      target: current.pk,
      endReason,
      walledCycles: this.walledCycles,
    });
    await this.deps.wait('engine:enrich-backoff', ENGINE_TIMING.ENRICH_BACKOFF_MS);
    return 'idle';
  }

}

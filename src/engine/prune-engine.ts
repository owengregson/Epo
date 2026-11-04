/**
 * PruneEngine — the auto-prune routine, separate from growth.
 *
 * Walks the account's ENTIRE following + followers lists and unfollows every
 * account we follow that does NOT follow us back, except protected accounts.
 * One-shot per run (schedule fields live in Settings); it shares the ONE
 * Instagram tab + Sentinel with the growth engine and the
 * composition root keeps the two MUTUALLY EXCLUSIVE (never two drivers on the
 * tab). It has its OWN daily cap, tracked in its own durable `prune_ledger`,
 * independent of growth's daily ceiling.
 *
 * Like the growth Engine (`engine.ts`), everything is injected (ports, clock,
 * sleep), so the whole routine is unit-testable with fakes: no browser, no
 * wall-clock, no real timers. Every wait goes through one interruptible sleep,
 * so `stop()` takes effect between actions instantly — and the SCAN threads a
 * cooperative stop + jittered pacing (`PruneScanOpts`) into both list scrapes,
 * so `stop()` also lands between scroll rounds mid-scan.
 */

import type { SentinelStatus } from '../adapter/sentinel';
import { blockedStreakThreshold, driftConfirmThreshold } from '../kernel/derive';
import { tempoOrReference } from '../kernel/tempo';
import type { PruneCensusRecord } from '../store/knowledge-store';
import { POLL } from '../timing/config';
import { DelayManager, type WaitResult } from '../timing/delay-manager';
import { mulberry32, type WaitClass } from '../timing/noise';
import {
  type DelayPolicy,
  type Rng,
  sleep as timingSleep,
} from '../timing/primitives';
import { WaitRunner } from '../timing/wait-runner';
import { launchStream } from '../utils/entropy';
import * as log from '../utils/logger';
import { censusAuthority, type OwnHeader } from './census-authority';
import type { ChurnActionOutcome } from './churn-scheduler';
import { type HaltReason, haltReasonKey } from './halt-reason';
import { journaledMutation } from './journaled-mutation';
import { annotatedRows, protectionKey, selectionVerdict, unprotectedRows } from './protection-gate';
import { type ProtectionPort, unconfiguredProtection } from './protection-port';
import { type AnnotatedCandidate, decidePruneCandidate, pruneDeferral } from './prune-candidate';
import { nextFeedCandidate, type PruneFeedContext } from './prune-feed';
import { PrunePacing } from './prune-pacing';
import { assertFetchComplete, assertScanCoverage } from './prune-scan-guards';
import type { PruneCandidate, PruneConfig, PruneEngineDeps, PruneScanEstimates, PruneScanOpts, PruneState, PruneStatus } from './prune-types';

export type { PruneCandidate, PruneChurnActions, PruneConfig, PruneEngineDeps, PruneOwnFollowers, PruneOwnFollowing, PrunePlan, PruneScanEstimates, PruneScanFetch, PruneScanOpts, PruneSentinel, PruneState, PruneStatus } from './prune-types';

/** Every DelayManager key the PruneEngine waits under: the closed set the noise registry classifies. */
export type PruneWaitKey = 'prune:park' | 'prune:action-delay';

/**
 * The noise class per key: the blocked-action park is a bounded retry backoff around its base; the
 * paced inter-unfollow delay draws its own spread and stays exact. An unclassified key fails tsc.
 */
export const PRUNE_WAIT_CLASS = {
  'prune:park': 'retry-backoff',
  'prune:action-delay': 'exact',
} as const satisfies Record<PruneWaitKey, WaitClass>;

/** Consecutive FAILED unfollows that halt a run (`actions-failing`): one can fail alone, several in a row is the machinery. */
export const PRUNE_CONSECUTIVE_FAIL_HALT = 4;

/** Consecutive BLOCKED unfollows before the run halts and the woven feed suspends (one home, one count; D5). */
export const PRUNE_CONSECUTIVE_BLOCK_HALT = blockedStreakThreshold();

/** Minimum spacing between mid-scan status emissions (the graph push throttle); phase-final emissions bypass it. */
export const PRUNE_PROGRESS_EMIT_MS = POLL.GRAPH_PUSH_THROTTLE_MS;

// ---------------------------------------------------------------------------------
// PruneEngine
// ---------------------------------------------------------------------------------

export class PruneEngine {
  private readonly deps: PruneEngineDeps;
  /** The ONE wait gate: every prune wait is a named `prune:*` entry here. */
  private readonly waits: WaitRunner<PruneWaitKey>;
  private readonly rng: () => number;
  /**
   * The DEDICATED timing-noise rng — never {@link rng}, whose seeded stream
   * feeds the paced delay draw (deterministic tests stay byte-identical).
   * Seeded from the install entropy ⊕ construction time ⊕ a prune-side salt,
   * so growth and prune noise streams differ even on one install.
   */
  private readonly noiseRng: Rng;
  private cfg: PruneConfig;

  private pruneState: PruneState = 'idle';
  /** Why the last halt happened; cleared by any non-halted transition. */
  private haltReason: string | null = null;
  private runAbort = new AbortController();
  /** Resolvers parked by the run loop while paused; released by resume()/stop(). */
  private resumeWaiters: Array<() => void> = [];
  /**
   * Deadline (epoch ms) of the inter-action delay a pause interrupted: resume
   * serves its remainder before the next unfollow (the growth engine's
   * "resume acts instantly" fix, mirrored), and the status projection keeps
   * pointing at it while paused. Null outside a paused delay.
   */
  private owedActionDeadline: number | null = null;

  private followingCount = 0;
  private followersCount = 0;
  private candidateCount = 0;
  private unfollowedThisRun = 0;
  private remaining = 0;
  private lastRunAt: number | null;
  private lastSentinel: SentinelStatus | null = null;
  /**
   * The RAW census of the last COMPLETE scan (following − followers − self − growth-managed, protection
   * NOT applied), runnable for a 2-step run; the actionable set derives from it against the LIVE protection
   * at consumption time (no re-scan). Null means "no runnable scan — Run is locked".
   */
  private pendingCandidates: PruneCandidate[] | null = null;
  /** Clock time the pending candidate set was captured; drives freshness. */
  private pendingScanAt: number | null = null;
  /** The last COMPLETE census (durable): replaced only when a scan verifiably finishes; the tiles' display truth. */
  private lastCensus: PruneCensusRecord | null = null;
  /** Clock time of the last THROTTLED mid-scan progress emission. */
  private lastProgressEmitAt = 0;
  /** The active run's next candidate (status projection); null outside a run. */
  private upNextCandidate: PruneCandidate | null = null;
  /** Which list the live scan is walking right now (status projection). */
  private scanPhase: 'following' | 'followers' | null = null;
  /** The current phase's header-count estimate (progress display only). */
  private scanEstimates: PruneScanEstimates | null = null;

  // --- Woven-feed state: the growth engine drains unfollows through the
  //     EngineUnfollowFeed methods below, one interleaved with its follows. Separate
  //     from run()'s counters; reset when a fresh scan replaces the census. ---
  /** Consecutive failed woven unfollows; halts the FEED (not the engine) at the cap. */
  private feedConsecutiveFailed = 0;
  /** Consecutive blocked woven unfollows; halts the feed at 3 (persistent block). */
  private feedConsecutiveBlocked = 0;
  /** Once true, `nextCandidate` returns null (growth keeps running); reset on a new scan. */
  private feedHalted = false;
  private lastOutcome: ChurnActionOutcome | null = null;
  /** The run's gates, plan and paced delay (see `prune-pacing.ts`). */
  private readonly pacing: PrunePacing;
  /** The feed selection's view of this engine (see `prune-feed.ts`). */
  private readonly feed: PruneFeedContext;
  /** The live protection (spec §7.4) and the rules key the actionable counts were derived for. */
  private readonly protection: ProtectionPort;
  private countedFor: string | null = null;
  lastActionOutcome(): ChurnActionOutcome | null { return this.lastOutcome ? { ...this.lastOutcome } : null; }

  constructor(deps: PruneEngineDeps) {
    this.deps = deps;
    this.protection = deps.protection ?? unconfiguredProtection(deps.clock);
    const delays =
      deps.delays ??
      new DelayManager({ clock: deps.clock, rng: deps.rng, sleep: deps.sleep ?? timingSleep });
    this.rng = deps.rng ?? launchStream('engine/prune-engine');
    this.noiseRng = mulberry32(
      (((deps.installEntropy ?? 0) >>> 0) ^ (deps.clock.now() & 0xffffffff) ^ 0x51abc0de) >>> 0,
    );
    this.waits = new WaitRunner<PruneWaitKey>({
      delays,
      clock: deps.clock,
      classes: PRUNE_WAIT_CLASS,
      noiseRng: this.noiseRng,
      signal: () => this.runAbort.signal,
      hooks: {
        // The paced inter-unfollow delay publishes at REGISTRATION so the
        // renderer sees the real next-unfollow deadline while it is pending.
        onRegistered: (key) => {
          if (key === 'prune:action-delay') this.emitStatus();
        },
      },
    });
    this.cfg = deps.cfg;
    this.lastRunAt = deps.lastRunAt ?? null;
    this.pacing = new PrunePacing({
      deps,
      stateNow: () => this.stateNow(),
      owe: (deadline) => {
        this.owedActionDeadline = deadline;
      },
      pruneWait: (key, ms) => this.pruneWait(key, ms),
    });
    this.feed = this.feedContext();

    // Rehydrate the durable scan snapshot (same pattern as growth's
    // adoptActiveTargetFromStore): the census counts and any not-yet-visited
    // candidates survive a restart, so the prune panel never resets to zeros
    // and a fresh-enough reviewed set stays runnable. The engine still starts
    // idle — data is restored, nothing auto-acts.
    this.lastCensus = deps.store.getPruneCensus();
    const snap = deps.store.getPruneScan();
    if (snap !== null) {
      this.followingCount = snap.following;
      this.followersCount = snap.followers;
      // The persisted rows are the RAW unvisited census; the counts show what is actionable under
      // protection as it stands NOW (after a completed run only never-visited protected rows remain).
      const actionable = this.actionable(snap.remaining).length;
      this.remaining = actionable;
      this.candidateCount = actionable;
      if (snap.remaining.length > 0) {
        this.pendingCandidates = snap.remaining;
        this.pendingScanAt = snap.at;
      }
      log.info('prune: restored scan snapshot', {
        at: snap.at,
        following: snap.following,
        followers: snap.followers,
        candidates: this.candidateCount,
        remaining: actionable,
      });
    }
  }

  /** Swap the live config in place (a settings reload); a protection change re-derives the counts. */
  applyConfig(cfg: PruneConfig): void {
    this.cfg = cfg;
    if (this.recount()) this.emitStatus();
  }

  /**
   * A protection change re-derives the actionable counts from the RAW cached census without
   * invalidating the scan (a new rule hides rows, a removed one restores unvisited rows); never
   * mid-run, where each candidate is judged as it comes. True when the counts were re-derived.
   */
  private recount(): boolean {
    if (this.pendingCandidates === null || this.busy()) return false;
    if (protectionKey(this.protection.index()) === this.countedFor) return false;
    const actionable = this.actionable(this.pendingCandidates).length;
    this.candidateCount = actionable;
    this.remaining = actionable;
    log.info('prune: protection changed, candidate set re-derived', { raw: this.pendingCandidates.length, actionable });
    return true;
  }

  /** The rows no rule protects now, stamping the rules key the counts derive from. */
  private actionable(rows: PruneCandidate[]): PruneCandidate[] {
    this.countedFor = protectionKey(this.protection.index());
    return unprotectedRows(this.deps.store, this.protection.index(), rows);
  }

  /** The verdict over a candidate's stored facts as they stand now (selection, spec §7.4). */
  private verdictOf(cand: PruneCandidate) { return selectionVerdict(this.deps.store, cand.pk, this.protection.index()); }

  /** The census rows annotated with their protection (the candidates channel). */
  candidateViews(rows: readonly PruneCandidate[]): AnnotatedCandidate<PruneCandidate>[] {
    return annotatedRows(this.deps.store, this.protection.index(), rows);
  }

  /** One view of this engine for the feed selection; the accessors read live state. */
  private feedContext(): PruneFeedContext {
    const engine = this;
    return {
      deps: this.deps,
      get cfg() { return engine.cfg; },
      get feedHalted() { return engine.feedHalted; },
      get pendingCandidates() { return engine.pendingCandidates; },
      hasFreshScan: () => this.hasFreshScan(),
      atDailyCap: (now) => this.atDailyCap(now),
      followsUsNow: (pk) => this.followsUsNow(pk),
      protectionOf: (cand) => this.verdictOf(cand),
      visitCandidate: (cand) => this.visitCandidate(cand),
    };
  }

  /** Whether a fresh, complete scan is cached and runnable right now. */
  private hasFreshScan(): boolean {
    return (
      this.pendingCandidates !== null &&
      this.pendingScanAt !== null &&
      // The plan's census freshness (spec §5.8.3); a unit rig without a plan keeps a scan runnable.
      this.deps.clock.now() - this.pendingScanAt <= (this.deps.plan?.censusFreshMs() ?? Number.POSITIVE_INFINITY)
    );
  }

  /** The state as a wide type — sidesteps literal narrowing across awaits. */
  private stateNow(): PruneState {
    return this.pruneState;
  }

  private busy(): boolean {
    const s = this.stateNow();
    return s === 'scanning' || s === 'running' || s === 'paused';
  }

  // --- Lifecycle -----------------------------------------------------------------

  /**
   * READ-ONLY scan: scrape our following + followers lists (bounded) and compute
   * `candidates = following − followers − ownPk` (raw; protection applies later). NO unfollows.
   * Emits status `scanning` → `idle`. Throws when a scan/run is already active
   * (the composition root's driver token normally prevents that) or when a
   * scrape genuinely fails — callers surface a typed result across IPC.
   *
   * Interruptible: the scan holds its own abort token (mirroring {@link run});
   * {@link stop} aborts it, the sources' scroll loops break between rounds, and
   * the scan resolves promptly with whatever was gathered, landing in `idle`.
   */
  async scan(): Promise<{
    following: number;
    followers: number;
    candidates: PruneCandidate[];
    /** True when stop() landed mid-scan: the census is PARTIAL — callers must
     *  not present its empty candidate set as "everyone follows you back". */
    aborted: boolean;
  }> {
    if (this.busy()) throw new Error('prune: scan refused, a scan/run is already active');
    this.runAbort = new AbortController();
    const token = this.runAbort;
    this.setState('scanning');
    try {
      const result = await this.performScan();
      // Cache the RAW census for a subsequent 2-step run — but ONLY a complete
      // (non-aborted) scan; an interrupted scan yields no runnable candidate set.
      // The run derives the actionable subset against the live protection.
      if (this.superseded(token)) {
        // The census this scan was building is void; the last COMPLETE one
        // (still durable — nothing was cleared up front) stays the runnable
        // set and the displayed truth. A NEWER generation owns the projection
        // already, so a stale scan restores nothing.
        if (!this.stale(token)) this.restoreLastCensus();
        return { ...result, aborted: true };
      }
      this.pendingCandidates = result.candidates;
      this.pendingScanAt = this.deps.clock.now();
      return { ...result, aborted: false };
    } catch (e) {
      // A FAILED scan keeps the LAST COMPLETE census standing: the durable
      // snapshot is retained until a scan verifiably completes, so restore the
      // projection (and the runnable rows, if any remain) exactly as a
      // relaunch would — a failed attempt to replace the census must not
      // destroy it.
      this.restoreLastCensus();
      throw e;
    } finally {
      this.scanPhase = null;
      this.scanEstimates = null;
      if (this.stateNow() === 'scanning') this.setState('idle');
    }
  }

  /**
   * One full prune run: scan, then unfollow each candidate ONE AT A TIME with a
   * paced delay between, each action gated by the prune daily cap, the
   * request budget, and the Sentinel (halt on non-ok). Stops when candidates are
   * exhausted, the daily cap is hit, or {@link stop} is called. A completed run
   * lands in `done` and reports `lastRunAt` via `onRunComplete`.
   */
  async run(): Promise<void> {
    if (this.busy()) return;
    this.runAbort = new AbortController();
    const token = this.runAbort;
    this.unfollowedThisRun = 0;

    // 2-step run: consume the reviewed candidate set from a fresh manual scan
    // verbatim — no second full-list walk (half the rate-limit exposure, and the
    // run acts on exactly what the user reviewed). The cache is cleared on
    // consumption so the next run needs its own fresh scan. When there is no
    // fresh scan (the scheduled auto-prune path), the run scans internally.
    let candidates: PruneCandidate[];
    // The census timestamp survives into a possible truncation below, so a
    // cap/hours-truncated run can hand its unvisited remainder back as a
    // still-fresh runnable set instead of dropping it.
    let scanAt: number | null = null;
    if (this.hasFreshScan()) {
      // The cached census is RAW; what runs is the subset no rule protects NOW.
      candidates = this.actionable(this.pendingCandidates ?? []);
      scanAt = this.pendingScanAt;
      this.pendingCandidates = null;
      this.pendingScanAt = null;
      this.candidateCount = candidates.length;
      this.remaining = candidates.length;
      log.info('prune: consuming reviewed scan for run', { candidates: candidates.length });
    } else {
      this.pendingCandidates = null;
      this.pendingScanAt = null;
      this.setState('scanning');
      try {
        const scanned = await this.performScan();
        candidates = this.actionable(scanned.candidates);
        scanAt = this.deps.clock.now();
        this.candidateCount = candidates.length;
        this.remaining = candidates.length;
      } catch (e) {
        // Not silent: a failed scrape (e.g. a stale DOM contact point) is logged
        // loud and lands the routine in `halted` — never a rejection across IPC.
        // The last COMPLETE census (durable, untouched by the failed walk) is
        // restored as the displayed truth.
        this.scanPhase = null;
        this.scanEstimates = null;
        this.restoreLastCensus();
        log.error('prune: scan failed, halting run', { error: String(e) });
        this.halt({ kind: 'scan-failed' });
        return;
      }
      if (this.superseded(token)) {
        if (!this.stale(token)) this.setState('idle');
        return;
      }
    }

    this.setState('running');
    // Why the run stopped before exhausting its candidates: its unvisited remainder stays RUNNABLE and
    // lastRunAt is not stamped ("the cap tapped out" is not "the list is clean"); a typed refusal names it.
    let truncated: string | null = null;
    // EVERY early exit (user stop, sentinel halt, unexpected failure) hands the unvisited remainder —
    // with the candidates passed over for their account's unsettled write — back as the runnable set.
    let index = 0;
    const passed: PruneCandidate[] = [];
    const handBackRemainder = (): void => {
      const rest = [...passed, ...candidates.slice(index)];
      if (rest.length > 0) {
        this.pendingCandidates = rest;
        this.pendingScanAt = scanAt;
      }
    };
    let consecutiveBlocked = 0;
    // Systemic-failure breaker: failures in a row mean the MACHINERY or the
    // ACCOUNT is blocked, not that every candidate is individually broken.
    // Halt loudly and keep the remainder runnable.
    let consecutiveFailed = 0;
    try {
      while (index < candidates.length) {
        const cand = candidates[index];
        // The countdown's subject: `cand` is what the run acts on next from
        // here through its gates; the bottom-of-loop delay re-points at the
        // FOLLOWING candidate (index already advanced) before it registers.
        this.upNextCandidate = cand;
        if (this.superseded(token)) break;

        // Pause gate (mirrors engine.ts): a paused run parks HERE, between
        // unfollows, until resume()/stop() releases it. After the release the
        // owed inter-action delay's remainder is served first — resume is not
        // a way to act instantly — and every downstream gate (active hours,
        // cap, sentinel) re-evaluates before the next unfollow.
        if (this.stateNow() === 'paused') {
          await this.waitForResume();
          if (this.superseded(token)) break;
          const owed = this.owedActionDeadline;
          this.owedActionDeadline = null;
          const remainderMs = owed === null ? 0 : owed - this.deps.clock.now();
          if (remainderMs > 0) await this.pruneWait('prune:action-delay', remainderMs);
          continue;
        }

        // The plan's admission before the visit (spec §9.7): serve its instant, pass the candidate, or end.
        const gate = this.pacing.admit(cand.pk);
        if (gate?.do === 'end') { truncated = gate.reason; break; }
        if (gate?.do === 'pass') { passed.push(cand); index += 1; continue; }
        const due = gate?.do === 'wait' ? gate.until - this.deps.clock.now() : 0;
        if (due > 0) { await this.pruneWait('prune:action-delay', due); continue; }

        // Gate 2 — Sentinel: any non-ok is a verified block → halt loud.
        const sentinelStatus = await this.deps.sentinel.check();
        this.lastSentinel = sentinelStatus;
        if (sentinelStatus !== 'ok') {
          handBackRemainder();
          this.halt({ kind: 'sentinel', status: sentinelStatus });
          return;
        }

        // Protection as it stands NOW, the live-graph follows-us guard and the username: ONE pure
        // decision shared with the woven feed (`prune-candidate.ts`). A paused index stops the run.
        const verdict = decidePruneCandidate({
          candidate: cand,
          protection: this.verdictOf(cand),
          followsUsNow: this.followsUsNow(cand.pk),
        });
        if (verdict.do === 'stop') {
          truncated = verdict.reason;
          break;
        }
        if (verdict.do === 'skip') {
          const detail = { pk: cand.pk, reason: verdict.reason };
          if (verdict.reason === 'no-username') {
            log.warn('prune: candidate has no known username, skipping', detail);
          } else {
            log.info('prune: candidate skipped by a live guard', detail);
          }
          this.visitCandidate(cand);
          index += 1;
          continue;
        }

        const outcome = await this.journaledUnfollow(cand.pk, verdict.username);
        // Judged before any visit, a refusal never marks the candidate visited (spec §9.7); a past instant takes the park.
        const deferral = pruneDeferral(outcome.verdict);
        if (deferral?.do === 'end') { truncated = deferral.reason; break; }
        if (deferral?.do === 'pass') { passed.push(cand); index += 1; continue; }
        const owed = deferral?.do === 'wait' ? deferral.until - this.deps.clock.now() : 0;
        if (owed > 0) { await this.pruneWait('prune:action-delay', owed); continue; }
        if (outcome.status === 'blocked') {
          if (outcome.cause === 'rate-limited') {
            // Instagram's own response refused the unfollow as throttling — definitive: halt now, remainder runnable.
            handBackRemainder();
            this.halt({ kind: 'rate-limited' });
            return;
          }
          // Blocked before any click: NOT visited — park briefly and retry the SAME candidate; halt rather than spin.
          // An unverified press counts once the plan's breaker has tripped (spec §11.1 F7).
          if (outcome.cause !== 'local-policy' && (outcome.cause !== 'unverified' || this.unverifiedTrips(cand))) consecutiveBlocked += 1;
          if (consecutiveBlocked >= PRUNE_CONSECUTIVE_BLOCK_HALT) {
            handBackRemainder();
            this.halt({ kind: 'blocked-repeatedly' });
            return;
          }
          log.warn('prune: action blocked, parking briefly', {
            pk: cand.pk,
            consecutiveBlocked,
          });
          this.emitStatus();
          await this.pruneWait('prune:park', tempoOrReference(this.deps.tempo).base('park.blocked'));
          continue;
        }
        // A click review (protected / unreadable) consumes the candidate after its visit: no ledger row.
        consecutiveBlocked = 0;
        this.visitCandidate(cand);
        index += 1;
        switch (outcome.status) {
          case 'ok':
            // Verified transition: heal our own-follow edge and record the prune.
            if (!outcome.alreadyInState) {
              this.unfollowedThisRun += 1;
              this.deps.onMutation?.();
            }
            consecutiveFailed = 0;
            break;
          case 'simulated':
            // Dry-run: the ledger records intent (and gates the cap); no edge.
            consecutiveFailed = 0;
            break;
          case 'failed':
            consecutiveFailed += 1;
            if (consecutiveFailed >= PRUNE_CONSECUTIVE_FAIL_HALT) {
              handBackRemainder();
              this.halt({ kind: 'actions-failing' });
              return;
            }
            break;
        }
        if (outcome.status === 'ok' || outcome.status === 'failed') this.deps.plan?.noteOutcome(false, this.deps.clock.now());
        this.upNextCandidate = candidates[index] ?? null;
        this.emitStatus();

        await this.pacing.paceNext(outcome.status === 'simulated');
      }
    } catch (e) {
      // A newer generation owns the candidate set and the state: a stale loop
      // unwinding here must not hand ITS remainder back over the new run's.
      if (this.stale(token)) return;
      handBackRemainder();
      // A user stop can surface as a throw from deep inside an adapter wait —
      // that is a CONTROL COMMAND, not a failure: land in idle like any stop.
      if (token.signal.aborted) {
        log.info('prune: run stopped mid-action, remainder stays runnable', { error: String(e) });
        this.setState('idle');
        return;
      }
      // Not silent: an unexpected mid-run failure is logged loud and halts —
      // never a rejection across IPC, never a phantom completion.
      log.error('prune: run failed, halting', { error: String(e) });
      this.halt({ kind: 'run-failed' });
      return;
    }

    if (this.superseded(token)) {
      if (this.stale(token)) return;
      handBackRemainder();
      this.setState('idle');
      return;
    }
    if (truncated === null && passed.length > 0) truncated = 'journal';
    if (truncated !== null) {
      // Hand the unvisited remainder back as the runnable set (the durable snapshot still holds exactly
      // these rows). lastRunAt is NOT stamped: the list is not clean, and the next run resumes it.
      const rest = [...passed, ...candidates.slice(index)];
      this.pendingCandidates = rest;
      this.pendingScanAt = scanAt;
      log.info('prune: run truncated, remainder stays runnable', {
        by: truncated,
        unfollowed: this.unfollowedThisRun,
        remaining: rest.length,
      });
      this.setState('done');
      return;
    }
    const at = this.deps.clock.now();
    this.lastRunAt = at;
    this.deps.onRunComplete?.(at);
    log.info('prune: run complete', {
      unfollowed: this.unfollowedThisRun,
      remaining: this.remaining,
    });
    this.setState('done');
  }

  /** Mark one candidate visited: decrement the live remaining count and drop
   *  it from the durable remaining set, so a quit mid-run restores exactly the
   *  unvisited rest. Called ONLY after the candidate was genuinely handled
   *  (acted on or deliberately skipped) — never for a blocked attempt. */
  private visitCandidate(cand: PruneCandidate): void {
    this.remaining = Math.max(0, this.remaining - 1);
    this.deps.store.consumePruneScanCandidate(cand.pk);
  }

  /**
   * Whether `token`'s generation has been superseded — this run/scan was
   * stopped, or a NEWER one replaced it. A stale loop waking from an await
   * must bail before touching candidate or ledger state (the growth engine's
   * generation guard, mirrored).
   */
  private superseded(token: AbortController): boolean {
    return this.stale(token) || token.signal.aborted;
  }

  /**
   * Whether a NEWER scan/run generation has taken over. A stale generation may
   * still write the FACTS its own action produced (PRINCIPLES §1 — an unfollow that
   * happened is recorded), but must never touch shared control state: the
   * runnable candidate set, the census projection, or the engine state all
   * belong to the current generation.
   */
  private stale(token: AbortController): boolean {
    return token !== this.runAbort;
  }

  /**
   * Stop: abort the run/scan signal AND any in-flight sleep so the loop exits
   * between actions instantly (mirrors the growth engine's E1 pattern) and an
   * in-flight SCAN breaks between scroll rounds / phases. A halted engine keeps
   * its `halted` state; an active scan/run returns to `idle`.
   */
  stop(): void {
    this.runAbort.abort();
    this.waits.cancelAll('prune:');
    this.owedActionDeadline = null;
    // A loop parked at the pause gate must wake to observe the abort and exit.
    this.releaseResumeWaiters();
    if (this.busy()) this.setState('idle');
    log.info('prune: stopped');
  }

  /**
   * Pause between unfollows: aborts the in-flight wait; the run loop parks at
   * its gate until {@link resume} (mirrors the growth engine's E1 pattern).
   * Only a RUNNING run can pause — a scan has no between-action boundary to
   * park at, so stop is a scan's one control. The run keeps every claim it
   * holds (candidate set, driver token) while paused.
   */
  pause(): void {
    if (this.stateNow() !== 'running') return;
    // Capture the interrupted delay's deadline BEFORE cancelling it: resume
    // serves the remainder, and the status keeps projecting the real deadline.
    this.owedActionDeadline = this.waits.nextDeadline('prune:action-delay');
    this.waits.cancelAll('prune:');
    log.info('prune: paused');
    this.setState('paused');
  }

  /** Resume a paused prune run (the owed inter-action delay is served first). */
  resume(): void {
    if (this.stateNow() !== 'paused') return;
    this.pruneState = 'running';
    this.releaseResumeWaiters();
    log.info('prune: resumed');
    this.emitStatus();
  }

  private waitForResume(): Promise<void> {
    return new Promise((resolve) => this.resumeWaiters.push(resolve));
  }

  private releaseResumeWaiters(): void {
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const release of waiters) release();
  }

  status(): PruneStatus {
    this.recount();
    return {
      state: this.stateNow(),
      following: this.followingCount,
      followers: this.followersCount,
      candidates: this.candidateCount,
      unfollowed: this.unfollowedThisRun,
      remaining: this.remaining,
      // The plan's day: its cleanup done and its unfollow budget (the number today actually stops at).
      dailyDone: this.pacing.today().done,
      dailyLimit: this.pacing.today().limit,
      lastRunAt: this.lastRunAt,
      lastSentinel: this.lastSentinel,
      haltReason: this.haltReason,
      // While paused the in-flight wait is cancelled but the deadline is still
      // OWED (served on resume) — keep projecting it so the countdown survives.
      nextActionAt: this.waits.nextDeadline('prune:action-delay') ?? this.owedActionDeadline,
      upNext: this.upNextCandidate?.username ?? null,
      scanReady: this.hasFreshScan(),
      // The census timestamp outlives the runnable set: a run consuming the
      // candidates must not turn "Scanned 2h ago" into "never scanned".
      scanAt: this.lastCensus?.at ?? this.pendingScanAt,
      scanPhase: this.scanPhase,
      scanEstimates: this.scanEstimates,
      graph: this.deps.store.relationshipCounts(),
      census: this.lastCensus,
      rawRemaining: this.deps.store.pruneScanRemainingCount(),
    };
  }

  /** The CURRENT run/scan abort signal (adapter waits link to this). */
  runSignal(): AbortSignal {
    return this.runAbort.signal;
  }

  // --- Woven feed (EngineUnfollowFeed) — the growth loop drains unfollows one at a
  //     time, interleaved with its follows. All the census/verdict logic stays
  //     here; only the pacing moves to the growth engine's session stream. ---

  /** Whether the plan's unfollow budget for the day is spent (all unfollows look alike to IG). */
  atDailyCap(_now: number): boolean {
    const t = this.pacing.today();
    return t.done >= t.limit;
  }

  /** Feed the breaker an unverified press; whether its streak has reached the trip (spec §11.1 F7). */
  private unverifiedTrips(_cand: PruneCandidate): boolean {
    return (this.deps.plan?.noteOutcome(true, this.deps.clock.now()) ?? 0) >= driftConfirmThreshold();
  }

  /** The next actionable unfollow, or null (see `prune-feed.ts`). */
  nextCandidate(now: number): { pk: string; username: string } | null {
    return nextFeedCandidate(this.feed, now);
  }

  /** What the LIVE graph says about `pk → us` right now (PRINCIPLES §2). */
  private followsUsNow(pk: string): boolean {
    return this.deps.store.getEdge(pk, this.deps.ownPk, 'follows')?.status === 'active';
  }

  /**
   * Perform one woven unfollow (the growth engine owns the tab + sentinel gate).
   * Writes the ledger row + heals the own-follow edge (PRINCIPLES §1), consumes
   * the candidate, and tracks the feed's own fail/block breakers. `blocked`
   * leaves the candidate runnable. Returns the outcome for the caller's pacing.
   */
  async executeUnfollow(cand: PruneCandidate, _now: number): Promise<ChurnActionOutcome['status']> {
    this.lastOutcome = null;
    if (cand.username === null) { this.lastOutcome = { status: 'failed' }; return 'failed'; }
    const outcome = await this.journaledUnfollow(cand.pk, cand.username);
    this.lastOutcome = { ...outcome };
    if (outcome.status === 'blocked') {
      if (outcome.cause !== 'local-policy') this.feedConsecutiveBlocked += 1;
      if (outcome.cause === 'rate-limited') {
        // Preserve the cause for the growth driver's ACCOUNT-wide recovery ladder.
        this.feedHalted = true;
        log.warn('prune: woven unfollow refused as rate-limited, suspending feed until next scan');
      } else if (this.feedConsecutiveBlocked >= PRUNE_CONSECUTIVE_BLOCK_HALT) {
        this.feedHalted = true;
        log.warn('prune: woven feed blocked repeatedly, suspending until next scan');
      }
      this.emitStatus();
      return 'blocked';
    }
    // A paused index is judged before any visit: the feed yields and the candidate stays.
    if (outcome.verdict?.kind === 'protection-paused') return 'reviewed';
    this.feedConsecutiveBlocked = 0;
    this.dropFromPending(cand);
    this.visitCandidate(cand);
    switch (outcome.status) {
      case 'ok':
        if (!outcome.alreadyInState) this.unfollowedThisRun += 1;
        this.feedConsecutiveFailed = 0;
        break;
      case 'simulated':
        this.feedConsecutiveFailed = 0;
        break;
      case 'failed':
        this.feedConsecutiveFailed += 1;
        if (this.feedConsecutiveFailed >= PRUNE_CONSECUTIVE_FAIL_HALT) {
          this.feedHalted = true;
          log.warn('prune: woven feed failing repeatedly, suspending until next scan');
        }
        break;
    }
    this.emitStatus();
    return outcome.status;
  }

  /** Remove `cand` from the pending census (by pk) if present. */
  private journaledUnfollow(accountPk: string, username: string): Promise<ChurnActionOutcome> {
    return journaledMutation({ store: this.deps.store, clock: this.deps.clock,
      ownPk: this.deps.ownPk, actions: this.deps.churnActions, action: 'unfollow',
      accountPk, username, channel: 'prune' });
  }

  private dropFromPending(cand: PruneCandidate): void {
    if (this.pendingCandidates === null) return;
    const i = this.pendingCandidates.findIndex((c) => c.pk === cand.pk);
    if (i >= 0) this.pendingCandidates.splice(i, 1);
  }

  // --- Scan ------------------------------------------------------------------------

  /**
   * The shared scan body: full following scrape, full followers scrape, then the
   * pure set difference minus our own pk and growth-managed accounts. The result
   * is the RAW census — protection is NOT applied here; callers derive the
   * actionable subset against the live protection (so edits react instantly).
   * Usernames come from the store — the sources observed every parsed profile
   * there before this reads them back.
   *
   * Both scrapes receive the SAME scan opts: a live `shouldStop` bound to the
   * current abort token (so `stop()` breaks their scroll loops between rounds)
   * and the configured jittered pacing bounds. The token is re-checked between
   * the following and followers phases and before computing candidates; an
   * aborted scan resolves with whatever was gathered and an empty candidate set.
   */
  private async performScan(): Promise<{
    following: number;
    followers: number;
    candidates: PruneCandidate[];
  }> {
    const token = this.runAbort;
    const scanOpts: PruneScanOpts = {
      shouldStop: (): boolean => this.superseded(token),
      scrollMinMs: this.cfg.scanMinMs,
      scrollMaxMs: this.cfg.scanMaxMs,
    };

    // Live counts: a fresh census counts up from zero as pages land (throttled
    // to ~4 emissions/sec so the IPC stream is never flooded); each phase's
    // settled total still lands unconditionally below. The stale candidate
    // figure is zeroed too — it belongs to the census being replaced. The
    // DURABLE snapshot and census, though, stay until this scan verifiably
    // completes (`savePruneScan` replaces them atomically at the end): a
    // stopped or failed walk restores them, so an interrupted scan never
    // destroys the census it could not replace.
    this.followingCount = 0;
    this.followersCount = 0;
    this.candidateCount = 0;
    // A fresh census re-arms the woven feed (a prior block/fail suspension is cleared).
    this.feedHalted = false;
    this.feedConsecutiveFailed = 0;
    this.feedConsecutiveBlocked = 0;

    // The estimates below need our OWN header counts, and passively overhearing
    // them is unreliable (an SPA profile navigation may never issue
    // the profile endpoint) — so a scan BEGINS with one active profile fetch
    // for our own account. A failed required refresh cannot authorize a census.
    let header: OwnHeader | undefined;
    if (this.deps.refreshOwnStats) {
      try {
        header = (await this.deps.refreshOwnStats()) ?? undefined;
      } catch (e) {
        log.warn('prune: own-stats refresh failed, preserving previous census', { error: String(e) });
        throw e;
      }
    }

    // Progress phases: the header counts size the scan's bar. BOTH estimates
    // project for the whole scan so the UI can draw one continuous fill across
    // the phase hand-off. Estimates only — ghosts keep them above the real
    // lists, so the UI rides to 100% on the settled totals at completion.
    const preScanStats = this.deps.store.getAccount(this.deps.ownPk);
    this.scanPhase = 'following';
    this.scanEstimates = {
      following: preScanStats?.following ?? null,
      followers: preScanStats?.followers ?? null,
    };
    this.emitStatus();

    const followingFetch = await this.deps.ownFollowing.fetchAllPks({
      ...scanOpts,
      onProgress: (n): void => {
        this.followingCount = n;
        this.emitStatusThrottled();
      },
    });
    const followingPks = followingFetch.pks;
    this.followingCount = followingPks.length;
    if (this.superseded(token) || followingFetch.reason === 'stop-requested') {
      return this.abortedScan(followingPks.length, 0, 'between-phases');
    }
    // A truncated FOLLOWING walk yields a smaller candidate set (safe direction)
    // but also a wrong census — refuse it the same way. Fail loud, never guess.
    assertFetchComplete('following', followingFetch);
    this.scanPhase = 'followers';
    this.emitStatus();

    const followersFetch = await this.deps.ownFollowers.fetchAllPks({
      ...scanOpts,
      onProgress: (n): void => {
        this.followersCount = n;
        this.emitStatusThrottled();
      },
    });
    const followerSet = new Set(followersFetch.pks);
    this.followersCount = followerSet.size;
    if (this.superseded(token) || followersFetch.reason === 'stop-requested') {
      return this.abortedScan(followingPks.length, followerSet.size, 'before-candidates');
    }
    // THE dangerous direction: candidates are FOLLOWING − FOLLOWERS, so a
    // truncated followers walk silently converts real followers into unfollow
    // candidates. The walk's own completeness verdict is authoritative — the
    // header-count heuristic below is only a second net.
    assertFetchComplete('followers', followersFetch);

    // Census coverage guard (second net): the header refreshed for THIS scan (else the stored
    // one) must be covered; when the scan refreshed it, an unknown header fails closed.
    const ownStats = header ?? this.deps.store.getAccount(this.deps.ownPk);
    const headerRequired = this.deps.refreshOwnStats !== undefined;
    assertScanCoverage('following', followingPks.length, ownStats?.following ?? null, { headerRequired });
    assertScanCoverage('followers', followerSet.size, ownStats?.followers ?? null, { headerRequired });

    // Feed the whole census back into the shared graph BEFORE computing candidates
    // (the two systems enrich each other): our-follow edges are healed
    // and who-follows-us edges recorded, so growth's follow-back detection and
    // net-growth benefit from a scan, and any queued growth candidate an external
    // actor already followed is dropped here (which also removes it from the
    // active-record exclusion below). Absence is a verdict only on a side whose
    // list COVERS the header count — completion alone is the walk's opinion.
    const ingestAt = this.deps.clock.now();
    this.deps.store.ingestScanCensus(followingPks, [...followerSet], ingestAt, {
      authoritative: censusAuthority(followingPks.length, followerSet.size, ownStats), planDay: this.deps.plan?.dayWindow(ingestAt),
    });

    // Accounts the growth engine is actively managing (awaiting a follow-back,
    // etc.) are OFF-LIMITS to prune — growth owns their lifecycle end-to-end, so
    // prune never yanks a follow growth is still working. Chain TARGETS are
    // off-limits too: they were followed deliberately as poaching anchors and
    // "does not follow back" is their expected steady state.
    const growthManaged = this.deps.store.activeFollowRecordPks();
    const chainTargets = this.deps.store.targetPks();

    const candidates: PruneCandidate[] = [];
    // Scraped non-reciprocal follows (self excluded), BEFORE the growth/chain
    // exemptions — the census records it so the composition display can show
    // the exempt slice honestly instead of folding it into "follows back".
    let notFollowingBack = 0;
    for (const pk of followingPks) {
      if (pk === this.deps.ownPk) continue;
      if (followerSet.has(pk)) continue;
      notFollowingBack += 1;
      if (growthManaged.has(pk)) continue;
      if (chainTargets.has(pk)) continue;
      const username = this.deps.store.getAccount(pk)?.username ?? null;
      candidates.push({ pk, username });
    }

    // GHOST BUFFER — the displayed census must MATCH the numbers Instagram
    // shows: a complete walk lands below the profile header's counts because
    // the header includes deactivated/unavailable accounts the list API never
    // returns. The DISPLAYED counts carry that buffer (scraped + ghosts =
    // header figure); the candidate math above stays on the raw scraped sets.
    const displayFollowing = Math.max(followingPks.length, ownStats?.following ?? 0);
    const displayFollowers = Math.max(followerSet.size, ownStats?.followers ?? 0);
    this.followingCount = displayFollowing;
    this.followersCount = displayFollowers;

    // Status counts reflect what is ACTIONABLE under the current protection; the
    // raw census is what gets cached/persisted, so later rule edits can
    // both hide and restore candidates without another walk.
    const actionable = this.actionable(candidates).length;
    this.candidateCount = actionable;
    this.remaining = actionable;
    // Persist the completed scan so a restart restores it (counts + the raw
    // unvisited census); a subsequent run consumes the remaining rows one by one.
    const censusAt = this.deps.clock.now();
    this.deps.store.savePruneScan({
      at: censusAt,
      following: displayFollowing,
      followers: displayFollowers,
      candidateCount: actionable,
      remaining: candidates,
    });
    // The scan verifiably completed — NOW (and only now) the last-complete
    // census is replaced, durable alongside the snapshot. Aborts and failures
    // above never reach this line, which is what keeps the previous census
    // standing through them.
    const census: PruneCensusRecord = {
      at: censusAt,
      following: displayFollowing,
      followers: displayFollowers,
      scrapedFollowing: followingPks.length,
      scrapedFollowers: followerSet.size,
      notFollowingBack, candidates: candidates.length,
    };
    this.deps.store.savePruneCensus(census);
    this.lastCensus = census;
    log.info('prune: scan complete', {
      following: followingPks.length,
      followers: followerSet.size,
      ghostBuffer: {
        following: displayFollowing - followingPks.length,
        followers: displayFollowers - followerSet.size,
      },
      candidates: candidates.length,
      actionable,
    });
    this.scanPhase = null;
    this.scanEstimates = null;
    this.emitStatus();
    return { following: displayFollowing, followers: displayFollowers, candidates };
  }

  /**
   * The aborted-scan resolution: `stop()` landed mid-scan, so report whatever
   * was gathered with an EMPTY candidate set (a partial diff must never feed a
   * run) and let the caller settle into `idle`. Logged loud, never a throw.
   * The partial walked counts go only to the CALLER (typed `aborted` result);
   * the LIVE projection restores the last complete census — a stopped scan
   * must never leave "Following = partial, Followers = 0" standing as if it
   * were a census.
   */
  private abortedScan(
    following: number,
    followers: number,
    phase: 'between-phases' | 'before-candidates',
  ): { following: number; followers: number; candidates: PruneCandidate[] } {
    this.restoreLastCensus();
    this.scanPhase = null;
    this.scanEstimates = null;
    log.info('prune: scan aborted, last complete census restored', {
      phase,
      following,
      followers,
    });
    this.emitStatus();
    return { following, followers, candidates: [] };
  }

  /**
   * Reset the live projection to the durable last-complete state: counts from
   * the retained scan snapshot, the unvisited candidate rows runnable again —
   * exactly what a relaunch would restore (the constructor's twin). Used when
   * a scan aborts or fails, so the census it could not replace keeps standing
   * instead of partial walked counts (or zeros) taking its place.
   */
  private restoreLastCensus(): void {
    const snap = this.deps.store.getPruneScan();
    if (snap === null) {
      // No census has ever completed: nothing to restore, nothing runnable.
      this.followingCount = 0;
      this.followersCount = 0;
      this.candidateCount = 0;
      this.remaining = 0;
      this.pendingCandidates = null;
      this.pendingScanAt = null;
      return;
    }
    this.followingCount = snap.following;
    this.followersCount = snap.followers;
    const actionable = this.actionable(snap.remaining).length;
    this.candidateCount = actionable;
    this.remaining = actionable;
    this.pendingCandidates = snap.remaining.length > 0 ? snap.remaining : null;
    this.pendingScanAt = snap.remaining.length > 0 ? snap.at : null;
  }

  // --- Internals -------------------------------------------------------------------

  /** Terminal stop, with the reason recorded on the status surface as a string. */
  private halt(reason: HaltReason): void {
    const key = haltReasonKey(reason);
    log.warn('prune: halted', { reason: key });
    this.haltReason = key;
    this.setState('halted');
  }

  private setState(state: PruneState): void {
    this.pruneState = state;
    if (state !== 'halted') this.haltReason = null;
    // Terminal transitions retire the countdown's subject — only an active
    // run (running, or paused mid-run) has a next candidate to name.
    if (state !== 'running' && state !== 'paused') this.upNextCandidate = null;
    this.emitStatus();
  }

  private emitStatus(): void {
    this.deps.onStatus?.(this.status());
  }

  /**
   * Mid-scan progress emission, rate-limited to one per
   * {@link PRUNE_PROGRESS_EMIT_MS} (~4/sec): page-granular progress callbacks
   * would otherwise push a projection over IPC for every parsed page. The
   * unconditional {@link emitStatus} calls at phase/scan boundaries are not
   * throttled, so the settled totals always land.
   */
  private emitStatusThrottled(): void {
    const now = this.deps.clock.now();
    if (now - this.lastProgressEmitAt < PRUNE_PROGRESS_EMIT_MS) return;
    this.lastProgressEmitAt = now;
    this.emitStatus();
  }
  /**
   * Wait under a namespaced key through the ONE gate ({@link WaitRunner}),
   * linked to this run's abort token — `stop()` wakes any in-flight wait
   * immediately. Resolves `{ completed: false }` when a control command cut it
   * short, so a caller can tell "the delay elapsed" from "we were interrupted".
   */
  private pruneWait(key: PruneWaitKey, policyOrMs: DelayPolicy | number): Promise<WaitResult> {
    return this.waits.wait(key, policyOrMs);
  }
}

/** Pure factory for the composition root; no wiring lives here. */
export function createPruneEngine(deps: PruneEngineDeps): PruneEngine {
  return new PruneEngine(deps);
}

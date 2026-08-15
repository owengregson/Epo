/**
 * PruneEngine (Phase 5 — auto-prune) — a SEPARATE routine from growth.
 *
 * Walks the account's ENTIRE following + followers lists and unfollows every
 * account we follow that does NOT follow us back, except whitelisted accounts.
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

import type { KnowledgeStore } from '../store/knowledge-store';
import type { Clock } from '../governors/clock';
import type { SentinelStatus } from '../adapter/sentinel';
import type { ChurnActionOutcome } from './churn-scheduler';
import { DelayManager } from '../timing/delay-manager';
import {
  type DelayPolicy,
  type SleepFn,
  jittered,
  sample,
  scaled,
  sleep as timingSleep,
} from '../timing/primitives';
import { PRUNE } from '../timing/config';
import { filterPruneCandidates, isPruneWhitelisted, pruneWhitelistSet } from './prune-whitelist';
import * as log from '../utils/logger';

/** One day in ms — the unit `pruneScheduleDays` counts. */
const MS_PER_DAY = 24 * 3600 * 1000;

/**
 * Whether a scheduled prune run is due now. Pure and opt-in: `scheduleDays <= 0`
 * (the default) disables scheduling entirely and always returns `false`; a run is
 * due when it has never run (`lastRunAt === null`) or at least `scheduleDays` have
 * elapsed since the last run. The composition root polls this and only auto-starts
 * a run when it is ALSO safe (logged in, growth idle, inside active hours).
 */
export function pruneDue(scheduleDays: number, lastRunAt: number | null, now: number): boolean {
  if (!Number.isFinite(scheduleDays) || scheduleDays <= 0) return false;
  if (lastRunAt === null) return true;
  return now - lastRunAt >= scheduleDays * MS_PER_DAY;
}

// ---------------------------------------------------------------------------------
// Ports: the narrow, structural slices of each collaborator the PruneEngine needs.
// The real components (AdapterBackedOwnFollowingSource, AdapterBackedChurnActions,
// RequestBudget, Sentinel) satisfy these by structural subtyping; tests inject
// plain fakes without touching the concrete classes.
// ---------------------------------------------------------------------------------

/**
 * Options the PruneEngine threads into each scan source's scrape so a SCAN is
 * both interruptible and rate-limit-safe: `shouldStop` is re-checked between
 * scroll rounds (`stop()` flips it true), and the pacing bounds make every
 * inter-round wait a fresh jittered draw instead of a fixed cadence.
 */
export interface PruneScanOpts {
  shouldStop?: () => boolean;
  scrollMinMs?: number;
  scrollMaxMs?: number;
  /**
   * Live-progress callback (additive): the source relays the scrape's CUMULATIVE
   * observed count as pages land, so the scan's counts can update mid-scrape
   * instead of only when a whole-list walk resolves.
   */
  onProgress?: (observedCount: number) => void;
}

/**
 * One full-list scrape's result. `complete` is the walk's OWN verdict on
 * whether the API genuinely reported (and verified) end-of-list — the field the
 * old `Promise<string[]>` ports silently discarded, which let a truncated
 * followers walk (sentinel trip, throttle stagnation, runaway bound) masquerade
 * as a full census and convert real followers into unfollow candidates.
 */
export interface PruneScanFetch {
  pks: string[];
  complete: boolean;
  /** Why the underlying walk/scrape ended (diagnostic; drives stop-vs-fail). */
  reason: string;
}

/** The own-following source's single verb: one bounded full-list scrape. */
export interface PruneOwnFollowing {
  fetchAllPks(opts?: PruneScanOpts): Promise<PruneScanFetch>;
}

/** The own-followers scan port (mirrors {@link PruneOwnFollowing}): one bounded
 *  full-list scrape — NOT the growth follow-back watcher's paged sweep, so the
 *  followers phase of a prune scan is interruptible and paced the same way. */
export interface PruneOwnFollowers {
  fetchAllPks(opts?: PruneScanOpts): Promise<PruneScanFetch>;
}

/** The one Instagram action prune performs (shared rim `ChurnActions` slice). */
export interface PruneChurnActions {
  unfollow(username: string): Promise<ChurnActionOutcome>;
}

/** The Sentinel slice: classify the tab before each action. */
export interface PruneSentinel {
  check(): Promise<SentinelStatus>;
}

// ---------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------

export type PruneState = 'idle' | 'scanning' | 'running' | 'done' | 'halted';

/** One prunable account: we follow it, it does not follow us back. */
export interface PruneCandidate {
  pk: string;
  username: string | null;
}

/** Status projection over the last scan/run + the durable prune ledger. */
export interface PruneStatus {
  state: PruneState;
  /** Accounts we follow, as of the last scan (0 before the first scan). */
  following: number;
  /** Accounts following us, as of the last scan. */
  followers: number;
  /** Candidates the last scan yielded (after whitelist/self exclusion). */
  candidates: number;
  /**
   * Whether a FRESH, complete scan is cached and ready for a 2-step run (§Phase 5):
   * a manual Run consumes exactly this reviewed candidate set instead of walking
   * the lists again. Expires after {@link PRUNE_SCAN_FRESH_MS} and is cleared once
   * consumed — so the UI's Run button locks until a fresh scan exists. Whitelist
   * edits do NOT clear it: the cached census is raw, and the actionable set is
   * re-derived against the live whitelist.
   */
  scanReady: boolean;
  /** Epoch ms of the runnable census (persisted; survives restarts); null when none. */
  scanAt: number | null;
  /** Real (verified, non-dry-run) unfollows performed this run. */
  unfollowed: number;
  /** Candidates not yet visited by the current/last run. */
  remaining: number;
  /** Prune-ledger rows since local midnight (ok + fail + simulated). */
  dailyDone: number;
  dailyLimit: number;
  /** Epoch ms of the last COMPLETED run; null when never completed. */
  lastRunAt: number | null;
  lastSentinel: SentinelStatus | null;
  /** Deadline (epoch ms) of the in-flight inter-unfollow delay, else null. */
  nextActionAt: number | null;
  /** Which list the LIVE scan is currently walking; null outside a scan. */
  scanPhase: 'following' | 'followers' | null;
  /**
   * BOTH expected list sizes from our own profile header, projected for the
   * whole scan (null outside one; each half null when unknown). ESTIMATES for
   * progress display only — header counts run ahead of the real lists
   * (deactivated-account ghosts), so the UI treats them as a soft denominator
   * and rides its bar to 100% on the real settled totals at completion. Both
   * are exposed (not just the live phase's) so the bar can render one
   * continuous fill across the phase hand-off instead of resetting.
   */
  scanEstimates: PruneScanEstimates | null;
  /**
   * LIVE relationship counts from the graph AS IT STANDS (docs/PRINCIPLES.md
   * §2): scan sources stream every row's edge, so these tick mid-scan —
   * `notFollowingBack` moves while the walk is still running instead of
   * appearing when it ends.
   */
  graph: { following: number; followers: number; notFollowingBack: number };
}

/** Header-count list-size estimates projected while a scan is live. */
export interface PruneScanEstimates {
  following: number | null;
  followers: number | null;
}

/** Settings-derived knobs (see `toPruneConfig` in `settings/settings.ts`). */
export interface PruneConfig {
  dailyLimit: number;
  /** Usernames (case-insensitive) or pks never pruned. */
  whitelist: string[];
  minDelayMs: number;
  maxDelayMs: number;
  jitterPercent: number;
  /** SCAN pacing: each inter-scroll wait is a fresh jittered draw in [min,max] ms. */
  scanMinMs: number;
  scanMaxMs: number;
}

/** Everything the PruneEngine composes, already constructed. */
export interface PruneEngineDeps {
  store: KnowledgeStore;
  clock: Clock;
  /** Our own account pk — always excluded from the candidate set. */
  ownPk: string;
  ownFollowing: PruneOwnFollowing;
  /** The whole-list own-followers scan port (see {@link PruneOwnFollowers}). */
  ownFollowers: PruneOwnFollowers;
  churnActions: PruneChurnActions;
  sentinel: PruneSentinel;
  cfg: PruneConfig;
  /** Injected sleep; defaults to a real interruptible setTimeout. */
  sleep?: SleepFn;
  /** Injectable randomness for the paced delay (deterministic tests). */
  rng?: () => number;
  /**
   * The shared wait owner. When absent the PruneEngine constructs a private one
   * over its own clock/sleep/rng — existing tests that inject `sleep` keep
   * working. The composition root injects the ONE DelayManager it shares with
   * the growth engine (keys namespaced `prune:` / `engine:`).
   */
  delays?: DelayManager;
  /** Seed for `lastRunAt` (from persisted Settings); null when never run. */
  lastRunAt?: number | null;
  /** Called with a fresh status projection after every step and state change. */
  onStatus?: (s: PruneStatus) => void;
  /** Called exactly once per COMPLETED run so the root can persist lastRunAt. */
  onRunComplete?: (at: number) => void;
  /**
   * Active refresh of our OWN header counts into the store (one profile-info
   * fetch), awaited at scan start before the estimates are read. Passive
   * observation alone is unreliable — an SPA profile navigation may never
   * issue web_profile_info — and without stored counts the scan has no
   * progress estimates and an inert census coverage guard. Best effort: a
   * rejection is logged and the scan proceeds without estimates.
   */
  refreshOwnStats?: () => Promise<void>;
  /**
   * Active-hours gate, re-checked between unfollows: a run started in the
   * evening must STOP at the window's edge instead of rolling past local
   * midnight — where the daily count also re-zeroes, which used to let one
   * "one-shot" run spend 2× the daily cap. Absent = no hours gate (tests).
   */
  withinActiveHours?: () => boolean;
}

/** Brief park after a blocked action before continuing. */
export const PRUNE_PARK_MS = PRUNE.PARK_MS;

/**
 * Consecutive FAILED unfollows that halt a prune run (`actions-failing`).
 * One account can legitimately fail (renamed/deactivated between scan and
 * run); several in a row mean Instagram is rejecting the mutations or the
 * adapter is broken — either way, continuing burns candidates at full pace
 * (2026-08-15: one success then 13 straight failures, all consumed).
 */
export const PRUNE_CONSECUTIVE_FAIL_HALT = 4;

/**
 * Prune unfollows run at a THIRD of the growth engine's paced inter-action
 * pace: the same jittered min/max/jitter draw, scaled by this factor. Pruning is
 * a deliberate, user-invoked bulk cleanup, so it moves ~3× faster than growth's
 * follow cadence while still spacing every unfollow (never a burst). Only the
 * inter-action delay is scaled — the scan pacing and the blocked/budget park are
 * unaffected.
 */
export const PRUNE_DELAY_FACTOR = PRUNE.DELAY_FACTOR;

/**
 * How long a completed scan's candidate set stays runnable for a 2-step run.
 * Within this window a manual Run consumes the reviewed candidates verbatim
 * (no second full-list walk); past it the cache is treated as stale and a Run
 * re-scans — so a scheduled run days later never acts on an old manual census.
 */
export const PRUNE_SCAN_FRESH_MS = PRUNE.SCAN_FRESH_MS;

/**
 * Minimum spacing between LIVE mid-scan status emissions (~4/sec): each parsed
 * page fires a progress callback, and a large account walks hundreds of pages —
 * unthrottled, every page would push a full projection over IPC. Phase-final
 * emissions bypass the throttle so the settled numbers always land.
 */
export const PRUNE_PROGRESS_EMIT_MS = 250;

// ---------------------------------------------------------------------------------
// PruneEngine
// ---------------------------------------------------------------------------------

export class PruneEngine {
  private readonly deps: PruneEngineDeps;
  /** The shared wait owner: every prune wait is a named `prune:*` entry here. */
  private readonly delays: DelayManager;
  private readonly rng: () => number;
  private cfg: PruneConfig;

  private pruneState: PruneState = 'idle';
  private runAbort = new AbortController();

  private followingCount = 0;
  private followersCount = 0;
  private candidateCount = 0;
  private unfollowedThisRun = 0;
  private remaining = 0;
  private lastRunAt: number | null;
  private lastSentinel: SentinelStatus | null = null;
  /**
   * The RAW candidate census from the last COMPLETE scan (following − followers
   * − self − growth-managed, whitelist NOT applied), cached for a 2-step run
   * (§Phase 5). The actionable set is derived from it against the LIVE
   * whitelist at consumption time, so whitelist edits take effect instantly —
   * adding a user hides them, removing a user restores them — with no re-scan.
   * Cleared once consumed or when it ages out. Null means "no runnable scan —
   * Run is locked".
   */
  private pendingCandidates: PruneCandidate[] | null = null;
  /** Clock time the pending candidate set was captured; drives freshness. */
  private pendingScanAt: number | null = null;
  /** Clock time of the last THROTTLED mid-scan progress emission. */
  private lastProgressEmitAt = 0;
  /** Which list the live scan is walking right now (status projection). */
  private scanPhase: 'following' | 'followers' | null = null;
  /** The current phase's header-count estimate (progress display only). */
  private scanEstimates: PruneScanEstimates | null = null;

  // --- Woven-feed state (§5.2): the growth engine drains unfollows through the
  //     EngineUnfollowFeed methods below, one interleaved with its follows. Separate
  //     from run()'s counters; reset when a fresh scan replaces the census. ---
  /** Consecutive failed woven unfollows; halts the FEED (not the engine) at the cap. */
  private feedConsecutiveFailed = 0;
  /** Consecutive blocked woven unfollows; halts the feed at 3 (persistent block). */
  private feedConsecutiveBlocked = 0;
  /** Once true, `nextCandidate` returns null (growth keeps running); reset on a new scan. */
  private feedHalted = false;

  constructor(deps: PruneEngineDeps) {
    this.deps = deps;
    this.delays =
      deps.delays ??
      new DelayManager({ clock: deps.clock, rng: deps.rng, sleep: deps.sleep ?? timingSleep });
    this.rng = deps.rng ?? Math.random;
    this.cfg = deps.cfg;
    this.lastRunAt = deps.lastRunAt ?? null;

    // Rehydrate the durable scan snapshot (same pattern as growth's
    // adoptActiveTargetFromStore): the census counts and any not-yet-visited
    // candidates survive a restart, so the prune panel never resets to zeros
    // and a fresh-enough reviewed set stays runnable. The engine still starts
    // idle — data is restored, nothing auto-acts.
    const snap = deps.store.getPruneScan();
    if (snap !== null) {
      this.followingCount = snap.following;
      this.followersCount = snap.followers;
      // The persisted remaining rows are the RAW unvisited census; what is
      // actionable depends on the whitelist as it stands NOW, not at save time.
      // Counts reflect what is actionable NOW: after a completed run the
      // durable remaining rows are only the never-visited (e.g. whitelisted)
      // ones, and inflating the display back to the pre-run census figure
      // (`snap.candidateCount`) showed a stale "N to prune" after restart.
      const actionable = filterPruneCandidates(snap.remaining, this.cfg.whitelist).length;
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

  /**
   * Swap the live config in place (used when Settings are updated at runtime).
   * A WHITELIST change re-derives the actionable candidate counts from the RAW
   * cached census — adding a user drops them from the runnable set on the spot,
   * removing a user restores them (if the scan hasn't visited them) — WITHOUT
   * invalidating the scan. The persisted snapshot is raw too, so nothing needs
   * rewriting. A mid-run edit is honored per-candidate by the run loop.
   */
  applyConfig(cfg: PruneConfig): void {
    const whitelistChanged =
      this.cfg.whitelist.length !== cfg.whitelist.length ||
      this.cfg.whitelist.some((w, i) => w !== cfg.whitelist[i]);
    this.cfg = cfg;
    if (whitelistChanged && this.pendingCandidates !== null && !this.busy()) {
      const actionable = filterPruneCandidates(this.pendingCandidates, cfg.whitelist).length;
      this.candidateCount = actionable;
      this.remaining = actionable;
      log.info('prune: whitelist changed, candidate set re-derived', {
        raw: this.pendingCandidates.length,
        actionable,
      });
      this.emitStatus();
    }
  }

  /** Whether a fresh, complete scan is cached and runnable right now. */
  private hasFreshScan(): boolean {
    return (
      this.pendingCandidates !== null &&
      this.pendingScanAt !== null &&
      this.deps.clock.now() - this.pendingScanAt <= PRUNE_SCAN_FRESH_MS
    );
  }

  /** The state as a wide type — sidesteps literal narrowing across awaits. */
  private stateNow(): PruneState {
    return this.pruneState;
  }

  private busy(): boolean {
    const s = this.stateNow();
    return s === 'scanning' || s === 'running';
  }

  // --- Lifecycle -----------------------------------------------------------------

  /**
   * READ-ONLY scan: scrape our following + followers lists (bounded) and compute
   * `candidates = following − followers − whitelist − ownPk`. NO unfollows.
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
      // The run derives the actionable subset against the live whitelist.
      if (token.signal.aborted) {
        this.pendingCandidates = null;
        this.pendingScanAt = null;
        return { ...result, aborted: true };
      }
      this.pendingCandidates = result.candidates;
      this.pendingScanAt = this.deps.clock.now();
      return { ...result, aborted: false };
    } catch (e) {
      // A FAILED scan must not leave the previous scan's candidate set looking
      // runnable: `performScan` cleared the durable snapshot up front, so a
      // stale in-memory set would let a Run consume a census the store no
      // longer has (and a restart would lose entirely).
      this.pendingCandidates = null;
      this.pendingScanAt = null;
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
      // The cached census is RAW; what actually runs is the subset the LIVE
      // whitelist allows — so an edit between Scan and Run is always honored.
      candidates = filterPruneCandidates(this.pendingCandidates ?? [], this.cfg.whitelist);
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
        candidates = filterPruneCandidates(scanned.candidates, this.cfg.whitelist);
        scanAt = this.deps.clock.now();
        this.candidateCount = candidates.length;
        this.remaining = candidates.length;
      } catch (e) {
        // Not silent: a failed scrape (e.g. a stale DOM contact point) is logged
        // loud and lands the routine in `halted` — never a rejection across IPC.
        this.scanPhase = null;
        this.scanEstimates = null;
        log.error('prune: scan failed, halting run', { error: String(e) });
        this.setState('halted');
        return;
      }
      if (token.signal.aborted) {
        this.setState('idle');
        return;
      }
    }

    this.setState('running');
    // Why the run stopped before exhausting its candidates, if it did. A
    // truncated run keeps its unvisited remainder RUNNABLE (and does not stamp
    // lastRunAt) — "the daily cap tapped out" must not read as "the list is
    // clean", or the schedule resets and the next run re-walks both lists.
    let truncated: 'cap' | 'active-hours' | null = null;
    // EVERY early exit (user stop, sentinel halt, unexpected failure) hands the
    // unvisited remainder back as the runnable set, exactly like truncation —
    // a stopped run used to silently drop it in memory (the durable snapshot
    // kept the rows, but Run grayed out and the list emptied until a restart).
    let index = 0;
    const handBackRemainder = (): void => {
      const rest = candidates.slice(index);
      if (rest.length > 0) {
        this.pendingCandidates = rest;
        this.pendingScanAt = scanAt;
      }
    };
    // Attempts THIS run that wrote a ledger row (ok/fail/simulated). Bounds the
    // run on its own, so a run crossing local midnight — where dailyDone()
    // re-zeroes — can never spend 2× the daily cap in one sitting.
    let actedThisRun = 0;
    let consecutiveBlocked = 0;
    // Systemic-failure breaker (2026-08-15 run: ONE success then 13 straight
    // fails — Instagram silently rejecting unfollow mutations — and the run
    // kept burning candidates at full pace). Failures in a row mean the
    // MACHINERY or the ACCOUNT is blocked, not that 13 candidates were all
    // individually broken; halt loudly and keep the remainder runnable.
    let consecutiveFailed = 0;
    try {
      while (index < candidates.length) {
        const cand = candidates[index];
        if (token.signal.aborted) break;

        // Gate 0 — active hours: stop at the window's edge (also prevents the
        // midnight rollover from re-opening the daily cap mid-run).
        if (this.deps.withinActiveHours && !this.deps.withinActiveHours()) {
          truncated = 'active-hours';
          log.info('prune: outside active hours, stopping run');
          break;
        }

        // Gate 1 — the prune-own daily cap (durable) AND the per-run bound.
        if (this.dailyDone() >= this.cfg.dailyLimit || actedThisRun >= this.cfg.dailyLimit) {
          truncated = 'cap';
          log.info('prune: daily cap reached, stopping run', { limit: this.cfg.dailyLimit });
          break;
        }

        // Gate 2 — Sentinel: any non-ok is a verified block → halt loud.
        const sentinelStatus = await this.deps.sentinel.check();
        this.lastSentinel = sentinelStatus;
        if (sentinelStatus !== 'ok') {
          handBackRemainder();
          this.halt(`sentinel:${sentinelStatus}`);
          return;
        }

        // A whitelist edit landing MID-RUN is honored per candidate: protected
        // accounts are skipped (visited, never acted on) from that moment.
        if (isPruneWhitelisted(cand, pruneWhitelistSet(this.cfg.whitelist))) {
          log.info('prune: candidate whitelisted mid-run, skipping', { pk: cand.pk });
          this.visitCandidate(cand);
          index += 1;
          continue;
        }

        // LIVE-GRAPH GUARD (docs/PRINCIPLES.md §2): the graph can know MORE
        // than the census this run consumes — a notifications check or an
        // accepted follow request AFTER the scan records their follows-us
        // edge. Never unfollow someone the graph says follows us NOW. This is
        // also what makes the longer scan-freshness window safe: staleness in
        // the dangerous direction (they followed back since) is caught here.
        if (this.deps.store.getEdge(cand.pk, this.deps.ownPk, 'follows')?.status === 'active') {
          log.info('prune: candidate followed back since the scan, skipping', { pk: cand.pk });
          this.visitCandidate(cand);
          index += 1;
          continue;
        }

        // The DOM unfollow needs a username; a stub row without one is skipped
        // (typed no-match + warn — it will have a username on a later scan).
        if (cand.username === null) {
          log.warn('prune: candidate has no known username, skipping', { pk: cand.pk });
          this.visitCandidate(cand);
          index += 1;
          continue;
        }

        const outcome = await this.deps.churnActions.unfollow(cand.username);
        const now = this.deps.clock.now();
        if (outcome.status === 'blocked') {
          // Sentinel closed inside the rim before any click: the account was
          // NEVER acted on, so it is NOT visited — park briefly and retry the
          // SAME candidate. Persistently blocked → halt loud rather than spin.
          consecutiveBlocked += 1;
          if (consecutiveBlocked >= 3) {
            handBackRemainder();
            this.halt('blocked-repeatedly');
            return;
          }
          log.warn('prune: action blocked, parking briefly', {
            pk: cand.pk,
            consecutiveBlocked,
          });
          this.emitStatus();
          await this.pruneWait('prune:park', PRUNE_PARK_MS);
          continue;
        }
        consecutiveBlocked = 0;
        this.visitCandidate(cand);
        index += 1;
        actedThisRun += 1;
        switch (outcome.status) {
          case 'ok':
            // Verified transition: heal our own-follow edge and record the prune.
            this.deps.store.reconcileOwnFollow(cand.pk, false, now);
            this.deps.store.recordPruneAction(cand.pk, 'ok', now);
            this.unfollowedThisRun += 1;
            consecutiveFailed = 0;
            break;
          case 'simulated':
            // Dry-run: the ledger records intent (and gates the cap); no edge.
            this.deps.store.recordPruneAction(cand.pk, 'simulated', now);
            consecutiveFailed = 0;
            break;
          case 'failed':
            this.deps.store.recordPruneAction(cand.pk, 'fail', now);
            consecutiveFailed += 1;
            if (consecutiveFailed >= PRUNE_CONSECUTIVE_FAIL_HALT) {
              handBackRemainder();
              this.halt('actions-failing');
              return;
            }
            break;
        }
        this.emitStatus();

        // THE paced delay between actions (min/max from config, jittered).
        await this.pruneWait('prune:action-delay', this.nextDelayMs());
      }
    } catch (e) {
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
      this.setState('halted');
      return;
    }

    if (token.signal.aborted) {
      handBackRemainder();
      this.setState('idle');
      return;
    }
    if (truncated !== null) {
      // Hand the unvisited remainder back as the runnable set (the durable
      // snapshot still holds exactly these rows — visited ones were consumed
      // one by one). lastRunAt is NOT stamped: the list is not clean, and a
      // scheduled prune should resume rather than wait a whole cycle.
      const rest = candidates.slice(index);
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
   * Stop: abort the run/scan signal AND any in-flight sleep so the loop exits
   * between actions instantly (mirrors the growth engine's E1 pattern) and an
   * in-flight SCAN breaks between scroll rounds / phases. A halted engine keeps
   * its `halted` state; an active scan/run returns to `idle`.
   */
  stop(): void {
    this.runAbort.abort();
    this.delays.cancelAll('prune:');
    if (this.busy()) this.setState('idle');
    log.info('prune: stopped');
  }

  status(): PruneStatus {
    return {
      state: this.stateNow(),
      following: this.followingCount,
      followers: this.followersCount,
      candidates: this.candidateCount,
      unfollowed: this.unfollowedThisRun,
      remaining: this.remaining,
      dailyDone: this.dailyDone(),
      dailyLimit: this.cfg.dailyLimit,
      lastRunAt: this.lastRunAt,
      lastSentinel: this.lastSentinel,
      nextActionAt: this.delays.nextDeadline('prune:action-delay'),
      scanReady: this.hasFreshScan(),
      scanAt: this.pendingScanAt,
      scanPhase: this.scanPhase,
      scanEstimates: this.scanEstimates,
      graph: this.deps.store.relationshipCounts(),
    };
  }

  /** The CURRENT run/scan abort signal (adapter waits link to this). */
  runSignal(): AbortSignal {
    return this.runAbort.signal;
  }

  // --- Woven feed (EngineUnfollowFeed) — the growth loop drains unfollows one at a
  //     time, interleaved with its follows (§5.2). All the census/verdict logic stays
  //     here; only the pacing moves to the growth engine's session stream. ---

  /** Whether the prune daily cap is reached (all unfollows look alike to IG). */
  atDailyCap(_now: number): boolean {
    return this.dailyDone() >= this.cfg.dailyLimit;
  }

  /**
   * The next actionable unfollow, or null. Pure selection over the fresh census: skips
   * (permanently, consuming them) any whitelisted / followed-back-since / no-username
   * candidate, and returns null when the feed is halted, no fresh scan exists, or the
   * daily cap is hit. Does NOT consume the returned candidate — that happens in
   * {@link reportUnfollowOutcome} via {@link executeUnfollow}.
   */
  nextCandidate(now: number): { pk: string; username: string } | null {
    if (this.feedHalted || !this.hasFreshScan() || this.atDailyCap(now)) return null;
    const wl = pruneWhitelistSet(this.cfg.whitelist);
    const pending = this.pendingCandidates;
    if (pending === null) return null;
    while (pending.length > 0) {
      const cand = pending[0];
      const followsUsNow =
        this.deps.store.getEdge(cand.pk, this.deps.ownPk, 'follows')?.status === 'active';
      if (isPruneWhitelisted(cand, wl) || followsUsNow || cand.username === null) {
        // A permanent skip for this census: drop it and move on.
        pending.shift();
        this.visitCandidate(cand);
        continue;
      }
      return { pk: cand.pk, username: cand.username };
    }
    return null;
  }

  /**
   * Perform one woven unfollow (the growth engine owns the tab + sentinel gate). Writes
   * the ledger row + heals the own-follow edge (§1), consumes the candidate, and tracks
   * the feed's own fail/block breakers. `blocked` leaves the candidate runnable (never
   * consumed). Returns the outcome status for the caller's pacing/park decision.
   */
  async executeUnfollow(cand: PruneCandidate, now: number): Promise<ChurnActionOutcome['status']> {
    if (cand.username === null) return 'failed';
    const outcome = await this.deps.churnActions.unfollow(cand.username);
    if (outcome.status === 'blocked') {
      this.feedConsecutiveBlocked += 1;
      if (this.feedConsecutiveBlocked >= 3) {
        this.feedHalted = true;
        log.warn('prune: woven feed blocked repeatedly, suspending until next scan');
      }
      this.emitStatus();
      return 'blocked';
    }
    this.feedConsecutiveBlocked = 0;
    this.dropFromPending(cand);
    this.visitCandidate(cand);
    switch (outcome.status) {
      case 'ok':
        this.deps.store.reconcileOwnFollow(cand.pk, false, now);
        this.deps.store.recordPruneAction(cand.pk, 'ok', now);
        this.unfollowedThisRun += 1;
        this.feedConsecutiveFailed = 0;
        break;
      case 'simulated':
        this.deps.store.recordPruneAction(cand.pk, 'simulated', now);
        this.feedConsecutiveFailed = 0;
        break;
      case 'failed':
        this.deps.store.recordPruneAction(cand.pk, 'fail', now);
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
  private dropFromPending(cand: PruneCandidate): void {
    if (this.pendingCandidates === null) return;
    const i = this.pendingCandidates.findIndex((c) => c.pk === cand.pk);
    if (i >= 0) this.pendingCandidates.splice(i, 1);
  }

  // --- Scan ------------------------------------------------------------------------

  /**
   * The shared scan body: full following scrape, full followers scrape, then the
   * pure set difference minus our own pk and growth-managed accounts. The result
   * is the RAW census — the whitelist is NOT applied here; callers derive the
   * actionable subset against the live whitelist (so edits react instantly).
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
      shouldStop: (): boolean => token.signal.aborted,
      scrollMinMs: this.cfg.scanMinMs,
      scrollMaxMs: this.cfg.scanMaxMs,
    };

    // Live counts: a fresh census counts up from zero as pages land (throttled
    // to ~4 emissions/sec so the IPC stream is never flooded); each phase's
    // settled total still lands unconditionally below. The stale candidate
    // figure is zeroed too — it belongs to the census being replaced. The
    // durable snapshot goes with it: a partial scan must never be restorable.
    this.followingCount = 0;
    this.followersCount = 0;
    this.candidateCount = 0;
    // A fresh census re-arms the woven feed (a prior block/fail suspension is cleared).
    this.feedHalted = false;
    this.feedConsecutiveFailed = 0;
    this.feedConsecutiveBlocked = 0;
    this.deps.store.clearPruneScan();

    // The estimates below need our OWN header counts, and passively overhearing
    // them is unreliable (an SPA profile navigation may never issue
    // web_profile_info) — so a scan BEGINS with one active profile-info fetch
    // for our own account. Best effort: a failed refresh degrades to a
    // bar-less scan (and an inert coverage guard), never a failed scan.
    if (this.deps.refreshOwnStats) {
      try {
        await this.deps.refreshOwnStats();
      } catch (e) {
        log.warn('prune: own-stats refresh failed, scanning without estimates', {
          error: String(e),
        });
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
    if (token.signal.aborted || followingFetch.reason === 'stop-requested') {
      return this.abortedScan(followingPks.length, 0, 'between-phases');
    }
    // A truncated FOLLOWING walk yields a smaller candidate set (safe direction)
    // but also a wrong census — refuse it the same way. Fail loud, never guess.
    this.assertFetchComplete('following', followingFetch);
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
    if (token.signal.aborted || followersFetch.reason === 'stop-requested') {
      return this.abortedScan(followingPks.length, followerSet.size, 'before-candidates');
    }
    // THE dangerous direction: candidates are FOLLOWING − FOLLOWERS, so a
    // truncated followers walk silently converts real followers into unfollow
    // candidates. The walk's own completeness verdict is authoritative — the
    // header-count heuristic below is only a second net.
    this.assertFetchComplete('followers', followersFetch);

    // Census coverage guard (second net): when the profile header's own counts
    // are known, a scraped list far short of them still fails the scan.
    const ownStats = this.deps.store.getAccount(this.deps.ownPk);
    this.assertScanCoverage('following', followingPks.length, ownStats?.following ?? null);
    this.assertScanCoverage('followers', followerSet.size, ownStats?.followers ?? null);

    // Feed the whole census back into the shared graph BEFORE computing candidates
    // (Phase 5 — the two systems enrich each other): our-follow edges are healed
    // and who-follows-us edges recorded, so growth's follow-back detection and
    // net-growth benefit from a scan, and any queued growth candidate an external
    // actor already followed is dropped here (which also removes it from the
    // active-record exclusion below). Both walks verified completion above, so
    // the census is AUTHORITATIVE: absent followers are recorded as losses
    // (this is what makes the net-growth chart's loss side real data).
    this.deps.store.ingestScanCensus(followingPks, [...followerSet], this.deps.clock.now(), {
      authoritative: true,
    });

    // Accounts the growth engine is actively managing (awaiting a follow-back,
    // etc.) are OFF-LIMITS to prune — growth owns their lifecycle end-to-end, so
    // prune never yanks a follow growth is still working. Chain TARGETS are
    // off-limits too: they were followed deliberately as poaching anchors and
    // "does not follow back" is their expected steady state.
    const growthManaged = this.deps.store.activeFollowRecordPks();
    const chainTargets = this.deps.store.targetPks();

    const candidates: PruneCandidate[] = [];
    for (const pk of followingPks) {
      if (pk === this.deps.ownPk) continue;
      if (followerSet.has(pk)) continue;
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

    // Status counts reflect what is ACTIONABLE under the current whitelist; the
    // raw census is what gets cached/persisted, so later whitelist edits can
    // both hide and restore candidates without another walk.
    const actionable = filterPruneCandidates(candidates, this.cfg.whitelist).length;
    this.candidateCount = actionable;
    this.remaining = actionable;
    // Persist the completed scan so a restart restores it (counts + the raw
    // unvisited census); a subsequent run consumes the remaining rows one by one.
    this.deps.store.savePruneScan({
      at: this.deps.clock.now(),
      following: displayFollowing,
      followers: displayFollowers,
      candidateCount: actionable,
      remaining: candidates,
    });
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
   */
  private abortedScan(
    following: number,
    followers: number,
    phase: 'between-phases' | 'before-candidates',
  ): { following: number; followers: number; candidates: PruneCandidate[] } {
    this.followersCount = followers;
    this.candidateCount = 0;
    this.remaining = 0;
    this.scanPhase = null;
    this.scanEstimates = null;
    log.info('prune: scan aborted', { phase, following, followers });
    this.emitStatus();
    return { following, followers, candidates: [] };
  }

  // --- Internals -------------------------------------------------------------------

  /**
   * Throw when a whole-list scrape covered too little of the known list size.
   * `known` comes from our own profile header (observed during this very scan);
   * null/small values skip the check — tiny accounts and ghost-follower drift
   * make exact matches meaningless, so the guard only catches gross truncation
   * (e.g. 38 scraped of ~3200 known). 85% margin: the header count runs a
   * little ahead of the real list (deactivated/deleted accounts stay counted).
   */
  /**
   * Throw when a whole-list walk did not verify genuine completion. The walk's
   * `complete` flag is computed with care (end-of-list claims are probed one
   * page past the end) and is the ONLY trustworthy census signal — the header
   * count can be unknown (a failed own-stats refresh) exactly when throttling
   * is also truncating walks, which is when a partial census is most dangerous.
   */
  private assertFetchComplete(phase: 'following' | 'followers', fetch: PruneScanFetch): void {
    if (fetch.complete) return;
    throw new Error(
      `prune: ${phase} walk incomplete (${fetch.reason}, ${fetch.pks.length} pks) — ` +
        'aborting so a partial census never drives unfollows',
    );
  }

  private assertScanCoverage(phase: 'following' | 'followers', scraped: number, known: number | null): void {
    if (known === null || known < 50) return;
    if (scraped >= known * 0.85) {
      // A complete walk that still lands under the header figure is GHOSTS:
      // deactivated/deleted accounts stay in the profile count but Instagram
      // never returns them in the list — the scraped list is the real one.
      if (scraped < known) {
        log.info('prune: scraped list below header count (deactivated-account ghosts)', {
          phase,
          scraped,
          known,
          ghosts: known - scraped,
        });
      }
      return;
    }
    throw new Error(
      `prune: ${phase} scan incomplete — scraped ${scraped} of ~${known} known; ` +
        'aborting so a partial census never drives unfollows',
    );
  }

  /** Prune-ledger rows since local midnight — the durable daily-cap count. */
  private dailyDone(): number {
    const startOfToday = new Date(this.deps.clock.now()).setHours(0, 0, 0, 0);
    return this.deps.store.pruneCountSince(startOfToday);
  }

  private halt(reason: string): void {
    log.warn('prune: halted', { reason });
    this.setState('halted');
  }

  private setState(state: PruneState): void {
    this.pruneState = state;
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
   * The inter-action delay between unfollows: the paced uniform [min,max]
   * draw ± jitterPercent (the growth engine's pace), then scaled to a THIRD
   * ({@link PRUNE_DELAY_FACTOR}) so pruning runs ~3× faster while still spacing
   * every action.
   */
  private nextDelayMs(): number {
    const { minDelayMs, maxDelayMs, jitterPercent } = this.cfg;
    return sample(
      scaled(jittered(minDelayMs, maxDelayMs, jitterPercent), PRUNE_DELAY_FACTOR),
      this.rng,
    );
  }

  /**
   * Wait through the shared DelayManager under a namespaced key, linked to this
   * run's abort token — `stop()` wakes any in-flight wait immediately (mirrors
   * `engine.ts`). The `prune:action-delay` wait additionally emits a status
   * right after registration, so the renderer sees the REAL next-unfollow
   * deadline (`nextActionAt`) while the wait is pending.
   */
  private async pruneWait(key: string, policyOrMs: DelayPolicy | number): Promise<void> {
    const wait = this.delays.wait(key, policyOrMs, { signal: this.runAbort.signal });
    if (key === 'prune:action-delay') this.emitStatus();
    await wait;
  }
}

/** Pure factory for the composition root; no wiring lives here. */
export function createPruneEngine(deps: PruneEngineDeps): PruneEngine {
  return new PruneEngine(deps);
}

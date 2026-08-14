/**
 * PruneEngine (Phase 5 — auto-prune) — a SEPARATE routine from growth.
 *
 * Walks the account's ENTIRE following + followers lists and unfollows every
 * account we follow that does NOT follow us back, except whitelisted accounts.
 * One-shot per run (schedule fields live in Settings); it shares the ONE
 * Instagram tab + Sentinel + RequestBudget with the growth engine and the
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

/** The own-following source's single verb: one bounded full-list scrape. */
export interface PruneOwnFollowing {
  fetchAllPks(opts?: PruneScanOpts): Promise<string[]>;
}

/** The own-followers scan port (mirrors {@link PruneOwnFollowing}): one bounded
 *  full-list scrape — NOT the growth follow-back watcher's paged sweep, so the
 *  followers phase of a prune scan is interruptible and paced the same way. */
export interface PruneOwnFollowers {
  fetchAllPks(opts?: PruneScanOpts): Promise<string[]>;
}

/** The one Instagram action prune performs (shared rim `ChurnActions` slice). */
export interface PruneChurnActions {
  unfollow(username: string): Promise<ChurnActionOutcome>;
}

/** The Request Budget slice prune consults before each action. */
export interface PruneRequestBudget {
  canSpend(): boolean;
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
   * consumed or when the whitelist changes — so the UI's Run button locks until a
   * fresh scan exists.
   */
  scanReady: boolean;
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
  requestBudget: PruneRequestBudget;
  sentinel: PruneSentinel;
  cfg: PruneConfig;
  /** Injected sleep; defaults to a real interruptible setTimeout. */
  sleep?: SleepFn;
  /** Injectable randomness for the humanized delay (deterministic tests). */
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
}

/** Brief park after a blocked action / closed budget before continuing. */
export const PRUNE_PARK_MS = PRUNE.PARK_MS;

/**
 * Prune unfollows run at a THIRD of the growth engine's humanized inter-action
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
   * The reviewed candidate set from the last COMPLETE scan, cached for a 2-step
   * run (§Phase 5). A manual Run consumes this verbatim when it is still fresh
   * (see {@link PRUNE_SCAN_FRESH_MS}); cleared once consumed, when the whitelist
   * changes, or when it ages out. Null means "no runnable scan — Run is locked".
   */
  private pendingCandidates: PruneCandidate[] | null = null;
  /** Clock time the pending candidate set was captured; drives freshness. */
  private pendingScanAt: number | null = null;
  /** Clock time of the last THROTTLED mid-scan progress emission. */
  private lastProgressEmitAt = 0;

  constructor(deps: PruneEngineDeps) {
    this.deps = deps;
    this.delays =
      deps.delays ??
      new DelayManager({ clock: deps.clock, rng: deps.rng, sleep: deps.sleep ?? timingSleep });
    this.rng = deps.rng ?? Math.random;
    this.cfg = deps.cfg;
    this.lastRunAt = deps.lastRunAt ?? null;
  }

  /**
   * Swap the live config in place (used when Settings are updated at runtime).
   * A WHITELIST change invalidates any cached scan — the reviewed candidate set
   * no longer reflects the whitelist, so a 2-step run must re-scan (the UI's Run
   * button re-locks until it does). Other knob changes leave the cache intact.
   */
  applyConfig(cfg: PruneConfig): void {
    const whitelistChanged =
      this.cfg.whitelist.length !== cfg.whitelist.length ||
      this.cfg.whitelist.some((w, i) => w !== cfg.whitelist[i]);
    this.cfg = cfg;
    if (whitelistChanged && this.pendingCandidates !== null) {
      this.pendingCandidates = null;
      this.pendingScanAt = null;
      log.info('prune: whitelist changed, invalidating cached scan');
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
  async scan(): Promise<{ following: number; followers: number; candidates: PruneCandidate[] }> {
    if (this.busy()) throw new Error('prune: scan refused, a scan/run is already active');
    this.runAbort = new AbortController();
    const token = this.runAbort;
    this.setState('scanning');
    try {
      const result = await this.performScan();
      // Cache the reviewed set for a subsequent 2-step run — but ONLY a complete
      // (non-aborted) scan; an interrupted scan yields no runnable candidate set.
      if (token.signal.aborted) {
        this.pendingCandidates = null;
        this.pendingScanAt = null;
      } else {
        this.pendingCandidates = result.candidates;
        this.pendingScanAt = this.deps.clock.now();
      }
      return result;
    } finally {
      if (this.stateNow() === 'scanning') this.setState('idle');
    }
  }

  /**
   * One full prune run: scan, then unfollow each candidate ONE AT A TIME with a
   * humanized delay between, each action gated by the prune daily cap, the
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
    if (this.hasFreshScan()) {
      candidates = this.pendingCandidates ?? [];
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
        ({ candidates } = await this.performScan());
      } catch (e) {
        // Not silent: a failed scrape (e.g. a stale DOM contact point) is logged
        // loud and lands the routine in `halted` — never a rejection across IPC.
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
    try {
      for (const cand of candidates) {
        if (token.signal.aborted) break;

        // Gate 1 — the prune-own daily cap (durable, independent of growth's).
        if (this.dailyDone() >= this.cfg.dailyLimit) {
          log.info('prune: daily cap reached, stopping run', { limit: this.cfg.dailyLimit });
          break;
        }

        // Gate 2 — request budget: park one beat, then re-check; a still-closed
        // window ends the run (a one-shot routine does not wait a whole window).
        if (!this.deps.requestBudget.canSpend()) {
          log.warn('prune: request budget saturated, parking');
          await this.pruneWait('prune:park', PRUNE_PARK_MS);
          if (token.signal.aborted) break;
          if (!this.deps.requestBudget.canSpend()) {
            log.warn('prune: request budget still saturated, stopping run');
            break;
          }
        }

        // Gate 3 — Sentinel: any non-ok is a verified block → halt loud.
        const sentinelStatus = await this.deps.sentinel.check();
        this.lastSentinel = sentinelStatus;
        if (sentinelStatus !== 'ok') {
          this.halt(`sentinel:${sentinelStatus}`);
          return;
        }

        this.remaining = Math.max(0, this.remaining - 1);

        // The DOM unfollow needs a username; a stub row without one is skipped
        // (typed no-match + warn — it will have a username on a later scan).
        if (cand.username === null) {
          log.warn('prune: candidate has no known username, skipping', { pk: cand.pk });
          this.emitStatus();
          continue;
        }

        const outcome = await this.deps.churnActions.unfollow(cand.username);
        const now = this.deps.clock.now();
        switch (outcome.status) {
          case 'ok':
            // Verified transition: heal our own-follow edge and record the prune.
            this.deps.store.reconcileOwnFollow(cand.pk, false, now);
            this.deps.store.recordPruneAction(cand.pk, 'ok', now);
            this.unfollowedThisRun += 1;
            break;
          case 'simulated':
            // Dry-run: the ledger records intent (and gates the cap); no edge.
            this.deps.store.recordPruneAction(cand.pk, 'simulated', now);
            break;
          case 'failed':
            this.deps.store.recordPruneAction(cand.pk, 'fail', now);
            break;
          case 'blocked':
            // Budget/sentinel closed inside the rim before any click: leave the
            // account untouched (no ledger), park briefly, and continue.
            log.warn('prune: action blocked, parking briefly', { pk: cand.pk });
            this.emitStatus();
            await this.pruneWait('prune:park', PRUNE_PARK_MS);
            continue;
        }
        this.emitStatus();

        // THE humanized delay between actions (min/max from config, jittered).
        await this.pruneWait('prune:action-delay', this.nextDelayMs());
      }
    } catch (e) {
      // Not silent: an unexpected mid-run failure is logged loud and halts —
      // never a rejection across IPC, never a phantom completion.
      log.error('prune: run failed, halting', { error: String(e) });
      this.setState('halted');
      return;
    }

    if (token.signal.aborted) {
      this.setState('idle');
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
    };
  }

  /** The CURRENT run/scan abort signal (adapter waits link to this). */
  runSignal(): AbortSignal {
    return this.runAbort.signal;
  }

  // --- Scan ------------------------------------------------------------------------

  /**
   * The shared scan body: full following scrape, full followers scrape, then the
   * pure set difference minus whitelist (case-insensitive username OR pk match)
   * minus our own pk. Usernames come from the store — the sources observed every
   * parsed profile there before this reads them back.
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
    // figure is zeroed too — it belongs to the census being replaced.
    this.followingCount = 0;
    this.followersCount = 0;
    this.candidateCount = 0;
    this.emitStatus();

    const followingPks = await this.deps.ownFollowing.fetchAllPks({
      ...scanOpts,
      onProgress: (n): void => {
        this.followingCount = n;
        this.emitStatusThrottled();
      },
    });
    this.followingCount = followingPks.length;
    if (token.signal.aborted) {
      return this.abortedScan(followingPks.length, 0, 'between-phases');
    }
    this.emitStatus();

    const followerSet = new Set(
      await this.deps.ownFollowers.fetchAllPks({
        ...scanOpts,
        onProgress: (n): void => {
          this.followersCount = n;
          this.emitStatusThrottled();
        },
      }),
    );
    this.followersCount = followerSet.size;
    if (token.signal.aborted) {
      return this.abortedScan(followingPks.length, followerSet.size, 'before-candidates');
    }

    // Feed the whole census back into the shared graph BEFORE computing candidates
    // (Phase 5 — the two systems enrich each other): our-follow edges are healed
    // and who-follows-us edges recorded, so growth's follow-back detection and
    // net-growth benefit from a scan, and any queued growth candidate an external
    // actor already followed is dropped here (which also removes it from the
    // active-record exclusion below).
    this.deps.store.ingestScanCensus(followingPks, [...followerSet], this.deps.clock.now());

    const whitelist = new Set(
      this.cfg.whitelist.map((w) => w.trim().toLowerCase()).filter((w) => w.length > 0),
    );
    // Accounts the growth engine is actively managing (awaiting a follow-back,
    // etc.) are OFF-LIMITS to prune — growth owns their lifecycle end-to-end, so
    // prune never yanks a follow growth is still working.
    const growthManaged = this.deps.store.activeFollowRecordPks();

    const candidates: PruneCandidate[] = [];
    for (const pk of followingPks) {
      if (pk === this.deps.ownPk) continue;
      if (followerSet.has(pk)) continue;
      if (growthManaged.has(pk)) continue;
      const username = this.deps.store.getAccount(pk)?.username ?? null;
      if (whitelist.has(pk.toLowerCase())) continue;
      if (username !== null && whitelist.has(username.toLowerCase())) continue;
      candidates.push({ pk, username });
    }

    this.candidateCount = candidates.length;
    this.remaining = candidates.length;
    log.info('prune: scan complete', {
      following: followingPks.length,
      followers: followerSet.size,
      candidates: candidates.length,
    });
    this.emitStatus();
    return { following: followingPks.length, followers: followerSet.size, candidates };
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
    log.info('prune: scan aborted', { phase, following, followers });
    this.emitStatus();
    return { following, followers, candidates: [] };
  }

  // --- Internals -------------------------------------------------------------------

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
   * The inter-action delay between unfollows: the humanized uniform [min,max]
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

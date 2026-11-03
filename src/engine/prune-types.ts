import type { SentinelStatus } from '../adapter/sentinel';
import type { Clock } from '../governors/clock';
import type { Admission } from '../governors/plan-types';
import type { TempoSource } from '../kernel/tempo';
import type { KnowledgeStore, PruneCensusRecord } from '../store/knowledge-store';
import type { DelayManager } from '../timing/delay-manager';
import type { SleepFn } from '../timing/primitives';
import type { OwnHeader } from './census-authority';
import type { ChurnActionOutcome } from './churn-scheduler';
import type { ProtectionPort } from './protection-port';

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
  retryAt?: number;
  pks: string[];
  complete: boolean;
  /** Why the underlying walk/scrape ended (diagnostic; drives stop-vs-fail). */
  reason: string;
  /** Rows the walk could not read; any makes the census refuse (spec §10.4). */
  quarantined?: number;
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
  unfollow(username: string, expectedPk?: string, onDispatch?: () => void): Promise<ChurnActionOutcome>;
}

/** The Sentinel slice: classify the tab before each action. */
export interface PruneSentinel {
  check(): Promise<SentinelStatus>;
}

// ---------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------

export type PruneState = 'idle' | 'scanning' | 'running' | 'paused' | 'done' | 'halted';

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
   * Whether a FRESH, complete scan is cached and ready for a 2-step run:
   * a manual Run consumes exactly this reviewed candidate set instead of walking
   * the lists again. Expires after {@link PRUNE_SCAN_FRESH_MS} and is cleared once
   * consumed — so the UI's Run button locks until a fresh scan exists. Whitelist
   * edits do NOT clear it: the cached census is raw, and the actionable set is
   * re-derived against the live whitelist.
   */
  scanReady: boolean;
  /**
   * Epoch ms of the last COMPLETE census (persisted; survives restarts AND a
   * run consuming the candidate set — display must keep saying when the
   * numbers were taken); null only when no scan has ever completed.
   */
  scanAt: number | null;
  /** Real (verified, non-dry-run) unfollows performed this run. */
  unfollowed: number;
  /** Candidates not yet visited by the current/last run. */
  remaining: number;
  /** Prune-ledger rows this active-hours cycle (ok + fail + simulated). */
  dailyDone: number;
  dailyLimit: number;
  /** Epoch ms of the last COMPLETED run; null when never completed. */
  lastRunAt: number | null;
  lastSentinel: SentinelStatus | null;
  /**
   * Why the run halted (`'rate-limited'`, `'actions-failing'`,
   * `'blocked-repeatedly'`, `'sentinel:<status>'`); null outside `halted`.
   * Optional so the pre-build projection (composed outside this engine) can
   * omit it.
   */
  haltReason?: string | null;
  /** Deadline (epoch ms) of the in-flight inter-unfollow delay, else null. */
  nextActionAt: number | null;
  /**
   * Username of the candidate an active run will act on next — the countdown's
   * subject, so the overview hero can say WHAT fires next during a prune.
   * Null outside an active run, when the run is exhausted, or when the next
   * candidate has no known username. Optional so the pre-build projection
   * (composed outside this engine) can omit it.
   */
  upNext?: string | null;
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
  /**
   * The last COMPLETE census (durable): the settled whole-list counts of the
   * most recent finished scan plus the scraped basis the composition bar
   * derives from. Unlike the runnable-set lifecycle (`scanReady`/`remaining`),
   * this survives aborted scans, consumed runs, and relaunches — null only
   * when no scan has ever completed. Optional so the pre-build projection
   * (composed outside this engine) can omit it.
   */
  census?: PruneCensusRecord | null;
  /**
   * RAW census rows no run has visited yet (whitelist NOT applied) — the
   * durable remaining set's size. With `census.candidates` and `remaining`
   * this lets the display split the census candidates into prunable /
   * whitelist-protected / already-handled without loading the rows. Optional
   * for the same pre-build reason as `census`.
   */
  rawRemaining?: number;
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
  /** Actual standalone-run mutation; woven actions are accounted by the growth driver. */
  onMutation?: () => void;
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
  /** The protection port (spec §7.4, P5–P7); a rig without it runs unconfigured (main always wires it). */
  protection?: ProtectionPort;
  /** The session tempo the blocked park's base reads (`park.blocked`, pace-up); the reference when absent. */
  tempo?: TempoSource;
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
  /**
   * Per-install noise entropy (store meta `install_entropy`) seeding the
   * DEDICATED timing-noise rng — same contract as the growth engine's
   * (`EngineDeps.installEntropy`). Absent (tests) → 0.
   */
  installEntropy?: number;
  /** Called with a fresh status projection after every step and state change. */
  onStatus?: (s: PruneStatus) => void;
  /** Called exactly once per COMPLETED run so the root can persist lastRunAt. */
  onRunComplete?: (at: number) => void;
  /**
   * Active refresh of our OWN header counts into the store (one profile-info
   * fetch), awaited at scan start before the estimates are read. Passive
   * observation alone is unreliable — an SPA profile navigation may never
   * issue a profile read — and without stored counts the scan has no
   * progress estimates and an inert census coverage guard. A failed required
   * refresh aborts this census, preserving the previous complete observation.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: a wired refresh resolves the header or (as wired today) nothing.
  refreshOwnStats?: () => Promise<OwnHeader | void>;
  /** The plan the run and the woven feed answer to; absent in unit rigs (the run admits every candidate). */
  plan?: PrunePlan;
}

/**
 * The plan's face toward cleanup (spec §5.13 S2 item 7, §9.7, §11.1 F7): its admission before each
 * candidate's visit, the practice-mode gap, the unconfirmed-actions breaker, the day's cleanup, the
 * census freshness rule (§5.8.3) and the plan-day a census is dated in.
 */
export interface PrunePlan {
  preflight(now: number, pk: string): Admission;
  practiced(now: number): void;
  /** A dispatched unfollow's evidence; the unfollow kind's unverified streak after it. */
  noteOutcome(unverified: boolean, now: number): number;
  cleanupToday(now: number): { readonly done: number; readonly limit: number };
  /** How long a complete census stays fresh (the plan's patience wait). */
  censusFreshMs(): number;
  dayWindow(now: number): { readonly startsAt: number; readonly endsAt: number };
}

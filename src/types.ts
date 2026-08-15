/**
 * Shared cross-cutting types for Epo v3.
 *
 * This module is the single source of truth for the IPC contract between the
 * main process and the renderer, plus the network-observation shape that the
 * embedded Instagram tab emits and the Adapter Reader (Task 7) consumes.
 *
 * It is imported by both the main process and the (browser) renderer, so it
 * MUST stay dependency-free (no `electron`, no Node built-ins).
 */

// ---------------------------------------------------------------------------
// Tab network-observation contract (consumed by the Reader in Task 7)
// ---------------------------------------------------------------------------

/**
 * A single observed network response from the embedded Instagram tab.
 *
 * The tab observes responses via the Chrome DevTools Protocol (see
 * `src/adapter/tab.ts`). `getBody()` lazily fetches the decoded response body
 * so the Reader only pays for bodies it actually wants to parse.
 */
export interface TabResponse {
  /** CDP request identifier; unique within the tab's page session. */
  requestId: string;
  /** Fully-qualified response URL. */
  url: string;
  /** HTTP status code. */
  status: number;
  /** Response MIME type (e.g. `application/json`). */
  mimeType: string;
  /**
   * Lazily fetch the decoded response body as a UTF-8 string.
   * Rejects if the body is no longer available in the CDP resource cache.
   */
  getBody(): Promise<string>;
}

/** Handler registered via {@link InstagramTab.onResponse}. */
export type ResponseHandler = (response: TabResponse) => void;

/** Disposer returned by subscription helpers; idempotent. */
export type Unsubscribe = () => void;

import type { EngineStatus } from '@/engine/engine';
import type { PruneCandidate, PruneState, PruneStatus } from '@/engine/prune-engine';
import type { Target, FollowState } from '@/store/types';
import type { Settings } from '@/settings/settings';

// Re-export so the renderer can name the Engine's status shape from one place.
// These are all TYPE-ONLY re-exports — no runtime code crosses into the renderer,
// so the dependency-free contract above still holds.
export type { EngineStatus, Target, FollowState, Settings };
export type { PruneCandidate, PruneState, PruneStatus };

// ---------------------------------------------------------------------------
// Structured log stream (main -> renderer)
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
  meta?: unknown;
  /** Epoch milliseconds when the entry was emitted. */
  at: number;
}

// ---------------------------------------------------------------------------
// IPC request/response payloads (renderer -> main, via invoke)
// ---------------------------------------------------------------------------

/** Result of reading a target account's followers into the knowledge graph. */
export interface ReadFollowersResult {
  target: string;
  /** Number of follower accounts observed and written to the store. */
  observed: number;
  /**
   * Whether the read actually ran. Optional for back-compat with existing callers
   * that only read `observed`; a manual read refused while the engine is running
   * (R3) or before login returns `ok: false` with a `reason` and `observed: 0`.
   */
  ok?: boolean;
  /** Readable reason when `ok` is false (e.g. `engine-running`). */
  reason?: string;
}

/** Result of a single follow / unfollow DOM action. */
export interface ActionResult {
  ok: boolean;
  username: string;
  /** Readable failure reason when `ok` is false. */
  reason?: string;
}

/**
 * The full status snapshot the main process emits to (and serves) the renderer:
 * the Engine's own projection (§5) plus the login flag the header needs. Before
 * the dependency graph is built (pre-login) the Engine fields carry their idle
 * defaults and `loggedIn` is false.
 */
export interface EpoStatus extends EngineStatus {
  /** True once the persisted IG session has a `ds_user_id` cookie. */
  loggedIn: boolean;
  /**
   * Set when a control command (start/resume) was REFUSED rather than applied
   * (e.g. `prune-running` while a prune holds the tab). Without this the
   * renderer's button just spun and reverted with zero feedback — a refusal is
   * not an IPC rejection, so nothing ever surfaced. Absent on success.
   */
  refusal?: string;
}

// ---------------------------------------------------------------------------
// Read-only list projections (renderer -> main, via invoke) — §5
// ---------------------------------------------------------------------------

/** Per-target yield, computed on demand from follow_records + edges (§3.5). */
export interface TargetYield {
  total: number;
  followedBack: number;
  followBackRate: number;
  poolSize: number;
  mutualOverlap: number;
}

/** A chain target augmented with its account username and computed yield. */
export interface ChainTargetView extends Target {
  username: string | null;
  yield: TargetYield;
}

/** One follow_record row joined to its account, for a queue lifecycle tab. */
export interface QueueRow {
  pk: string;
  username: string | null;
  ratio: number | null;
  isPrivate: boolean | null;
  /** Mutual-follower count (shared audience), when known. */
  mutuals?: number | null;
  /** The Scorer's composite rank (higher = better); drives the queued order. */
  score?: number | null;
  followedAt?: number;
  holdUntil?: number;
  unfollowDueAt?: number;
}

/** A capped page of queue rows plus whether rows beyond the cap were dropped. */
export interface QueueListResult {
  rows: QueueRow[];
  truncated: boolean;
}

/** One day's cumulative net own-follower growth (Epo-visible, from sweeps). */
export interface NetGrowthPoint {
  dayStartMs: number;
  cumulativeNet: number;
}

/**
 * Result of a read-only prune scan (`prune:scan`). `ok: false` carries a typed
 * reason (e.g. `growth-running`, `prune-running`, `not-logged-in`) the UI
 * surfaces; the counts/candidates are then empty. `candidates` is the RAW
 * census (whitelist NOT applied) — the UI derives the visible/actionable list
 * against the live whitelist so edits react without a re-scan.
 */
export interface PruneScanResult {
  ok: boolean;
  reason?: string;
  following: number;
  followers: number;
  candidates: PruneCandidate[];
  /** True when the user stopped the scan mid-walk: the census is PARTIAL — an
   *  empty candidate set here must never read as "everyone follows back". */
  aborted?: boolean;
}

/**
 * Result of a prune control op (`prune:start`). Refusals (mutual exclusion with
 * the growth engine, not logged in) come back as `ok: false` with a typed
 * reason; `status` always carries the current prune projection.
 */
export interface PruneControlResult {
  ok: boolean;
  reason?: string;
  status: PruneStatus;
}

/** Result of a read-only seed-username precheck (existence + followers visibility). */
export interface SeedCheck {
  ok: boolean;
  exists: boolean;
  followersVisible: boolean;
  isPrivate: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Channel names — kept as string-literal unions so both sides stay in sync
// ---------------------------------------------------------------------------

/** Channels invoked from the renderer and handled in the main process. */
export type IpcInvokeChannel =
  | 'foundation:login'
  | 'foundation:readFollowers'
  | 'foundation:followOne'
  | 'foundation:unfollowOne'
  | 'foundation:status'
  | 'engine:start'
  | 'engine:pause'
  | 'engine:resume'
  | 'engine:stop'
  | 'engine:restartFromSeed'
  | 'engine:status'
  | 'prune:scan'
  | 'prune:start'
  | 'prune:stop'
  | 'prune:status'
  | 'prune:candidates'
  | 'chain:list'
  | 'growth:series'
  | 'seed:check'
  | 'queue:list'
  | 'settings:get'
  | 'settings:update'
  | 'settings:reset'
  | 'data:clear'
  | 'tab:show'
  | 'tab:hide';

/** Payload pushed on each renderer-facing event channel. */
export interface EpoEventPayloads {
  log: LogEntry;
  status: EpoStatus;
  pruneStatus: PruneStatus;
}

/** Channels pushed from the main process to the renderer. */
export type EpoEventChannel = keyof EpoEventPayloads;

// ---------------------------------------------------------------------------
// The bridge exposed on `window.epo` by the preload script
// ---------------------------------------------------------------------------

export interface EpoBridge {
  /** Open Instagram in the embedded tab (login is performed by the user). */
  login(): Promise<EpoStatus>;
  /** Read a target account's followers into the knowledge graph. */
  readFollowers(target: string): Promise<ReadFollowersResult>;
  /** Follow a single account by username via a DOM click. */
  followOne(username: string): Promise<ActionResult>;
  /** Unfollow a single account by username via a DOM click. */
  unfollowOne(username: string): Promise<ActionResult>;
  /** Fetch a status snapshot for the control shell. */
  status(): Promise<EpoStatus>;
  /** Start the engine loop (builds the graph if needed). */
  startEngine(): Promise<EpoStatus>;
  /** Pause the engine between actions. */
  pauseEngine(): Promise<EpoStatus>;
  /** Resume a paused engine. */
  resumeEngine(): Promise<EpoStatus>;
  /** Stop the engine loop (aborts in-flight sleeps). */
  stopEngine(): Promise<EpoStatus>;
  /** Scrap the current chain and restart from `seed` (persists the seed first). */
  restartFromSeed(seed: string): Promise<EpoStatus>;
  /** Fetch the engine status snapshot (same projection as {@link status}). */
  engineStatus(): Promise<EpoStatus>;
  /** READ-ONLY auto-prune scan: the raw following − followers census (no unfollows). */
  scanPrune(): Promise<PruneScanResult>;
  /** The persisted scan's not-yet-visited candidates (raw census) — restores the list on launch. */
  pruneCandidates(): Promise<PruneCandidate[]>;
  /** Start one auto-prune run (mutually exclusive with the growth engine). */
  startPrune(): Promise<PruneControlResult>;
  /** Stop an active prune scan/run between actions. */
  stopPrune(): Promise<PruneStatus>;
  /** Fetch the prune status projection. */
  pruneStatus(): Promise<PruneStatus>;
  /** Subscribe to pushed prune status projections (`on('pruneStatus', …)` sugar). */
  onPruneStatus(cb: (status: PruneStatus) => void): void;
  /** Unsubscribe a previously-registered prune status listener. */
  offPruneStatus(cb: (status: PruneStatus) => void): void;
  /** The chain lineage: every target with its username and computed yield. */
  chainList(): Promise<ChainTargetView[]>;
  /** Cumulative net own-follower growth per day for the last `days` days. */
  growthSeries(days: number): Promise<NetGrowthPoint[]>;
  /** Read-only precheck of a seed username (existence + followers visibility). */
  checkSeed(username: string): Promise<SeedCheck>;
  /** A capped page of follow_records in one lifecycle state, joined to accounts. */
  queueList(state: FollowState): Promise<QueueListResult>;
  /** The persisted settings object. */
  getSettings(): Promise<Settings>;
  /** Merge a partial into settings, persist, and reload the live engine configs. */
  updateSettings(partial: Partial<Settings>): Promise<Settings>;
  /** Reset all settings to defaults (data + session kept). */
  resetSettings(): Promise<Settings>;
  /** Wipe the knowledge DB + IG session (logout); settings kept. */
  clearData(): Promise<EpoStatus>;
  /** Reveal the embedded Instagram tab. */
  showTab(): Promise<void>;
  /** Hide the embedded Instagram tab. */
  hideTab(): Promise<void>;
  /** Subscribe to a push channel (the streaming log or pushed status). */
  on<C extends EpoEventChannel>(
    channel: C,
    cb: (payload: EpoEventPayloads[C]) => void,
  ): void;
  /** Unsubscribe a previously-registered listener (no leaks). */
  off<C extends EpoEventChannel>(
    channel: C,
    cb: (payload: EpoEventPayloads[C]) => void,
  ): void;
}

declare global {
  // eslint-disable-next-line no-var
  interface Window {
    epo: EpoBridge;
  }
}

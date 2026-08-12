/**
 * Shared cross-cutting types for Peanut v3.
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
import type { Target, FollowState } from '@/store/types';
import type { Settings } from '@/settings/settings';

// Re-export so the renderer can name the Engine's status shape from one place.
// These are all TYPE-ONLY re-exports — no runtime code crosses into the renderer,
// so the dependency-free contract above still holds.
export type { EngineStatus, Target, FollowState, Settings };

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
}

/** Result of a single follow / unfollow DOM action. */
export interface ActionResult {
  ok: boolean;
  username: string;
  /** Human-readable failure reason when `ok` is false. */
  reason?: string;
}

/**
 * The full status snapshot the main process emits to (and serves) the renderer:
 * the Engine's own projection (§5) plus the login flag the header needs. Before
 * the dependency graph is built (pre-login) the Engine fields carry their idle
 * defaults and `loggedIn` is false.
 */
export interface PeanutStatus extends EngineStatus {
  /** True once the persisted IG session has a `ds_user_id` cookie. */
  loggedIn: boolean;
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
  followedAt?: number;
  holdUntil?: number;
  unfollowDueAt?: number;
}

/** A capped page of queue rows plus whether rows beyond the cap were dropped. */
export interface QueueListResult {
  rows: QueueRow[];
  truncated: boolean;
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
  | 'engine:status'
  | 'chain:list'
  | 'queue:list'
  | 'settings:get'
  | 'settings:update'
  | 'tab:show'
  | 'tab:hide';

/** Payload pushed on each renderer-facing event channel. */
export interface PeanutEventPayloads {
  log: LogEntry;
  status: PeanutStatus;
}

/** Channels pushed from the main process to the renderer. */
export type PeanutEventChannel = keyof PeanutEventPayloads;

// ---------------------------------------------------------------------------
// The bridge exposed on `window.peanut` by the preload script
// ---------------------------------------------------------------------------

export interface PeanutBridge {
  /** Open Instagram in the embedded tab (login is performed by the user). */
  login(): Promise<PeanutStatus>;
  /** Read a target account's followers into the knowledge graph. */
  readFollowers(target: string): Promise<ReadFollowersResult>;
  /** Follow a single account by username via a human-like DOM click. */
  followOne(username: string): Promise<ActionResult>;
  /** Unfollow a single account by username via a human-like DOM click. */
  unfollowOne(username: string): Promise<ActionResult>;
  /** Fetch a status snapshot for the control shell. */
  status(): Promise<PeanutStatus>;
  /** Start the automated engine loop (builds the graph if needed). */
  startEngine(): Promise<PeanutStatus>;
  /** Pause the engine between actions. */
  pauseEngine(): Promise<PeanutStatus>;
  /** Resume a paused engine. */
  resumeEngine(): Promise<PeanutStatus>;
  /** Stop the engine loop (aborts in-flight sleeps). */
  stopEngine(): Promise<PeanutStatus>;
  /** Fetch the engine status snapshot (same projection as {@link status}). */
  engineStatus(): Promise<PeanutStatus>;
  /** The chain lineage: every target with its username and computed yield. */
  chainList(): Promise<ChainTargetView[]>;
  /** A capped page of follow_records in one lifecycle state, joined to accounts. */
  queueList(state: FollowState): Promise<QueueListResult>;
  /** The persisted settings object. */
  getSettings(): Promise<Settings>;
  /** Merge a partial into settings, persist, and reload the live engine configs. */
  updateSettings(partial: Partial<Settings>): Promise<Settings>;
  /** Reveal the embedded Instagram tab. */
  showTab(): Promise<void>;
  /** Hide the embedded Instagram tab. */
  hideTab(): Promise<void>;
  /** Subscribe to a push channel (the streaming log or pushed status). */
  on<C extends PeanutEventChannel>(
    channel: C,
    cb: (payload: PeanutEventPayloads[C]) => void,
  ): void;
  /** Unsubscribe a previously-registered listener (no leaks). */
  off<C extends PeanutEventChannel>(
    channel: C,
    cb: (payload: PeanutEventPayloads[C]) => void,
  ): void;
}

declare global {
  // eslint-disable-next-line no-var
  interface Window {
    peanut: PeanutBridge;
  }
}

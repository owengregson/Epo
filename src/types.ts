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

// Re-export so the renderer can name the Engine's status shape from one place.
export type { EngineStatus };

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

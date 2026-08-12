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

/** Snapshot of engine + governor state for the control shell header. */
export interface FoundationStatus {
  loggedIn: boolean;
  currentUrl: string;
  actionsToday: number;
  remainingToday: number;
  dailyHardCeiling: number;
  dailyOperatingRate: number;
  /** True once today's actions reach the hard ceiling (uncrossable in code). */
  atHardCeiling: boolean;
  /** Requests still available in the current rolling request-budget window. */
  requestBudgetRemaining: number;
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
  | 'tab:show'
  | 'tab:hide';

/** Channels pushed from the main process to the renderer. */
export type PeanutEventChannel = 'log';

// ---------------------------------------------------------------------------
// The bridge exposed on `window.peanut` by the preload script
// ---------------------------------------------------------------------------

export interface PeanutBridge {
  /** Open Instagram in the embedded tab (login is performed by the user). */
  login(): Promise<void>;
  /** Read a target account's followers into the knowledge graph. */
  readFollowers(target: string): Promise<ReadFollowersResult>;
  /** Follow a single account by username via a human-like DOM click. */
  followOne(username: string): Promise<ActionResult>;
  /** Unfollow a single account by username via a human-like DOM click. */
  unfollowOne(username: string): Promise<ActionResult>;
  /** Fetch a status snapshot for the control-shell header. */
  status(): Promise<FoundationStatus>;
  /** Reveal the embedded Instagram tab. */
  showTab(): Promise<void>;
  /** Hide the embedded Instagram tab. */
  hideTab(): Promise<void>;
  /** Subscribe to a push channel (e.g. the streaming log). */
  on(channel: PeanutEventChannel, cb: (payload: LogEntry) => void): void;
  /** Unsubscribe a previously-registered listener (no leaks). */
  off(channel: PeanutEventChannel, cb: (payload: LogEntry) => void): void;
}

declare global {
  // eslint-disable-next-line no-var
  interface Window {
    peanut: PeanutBridge;
  }
}

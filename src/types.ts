/**
 * Shared cross-cutting types for Epo v3.
 * This module is the single source of truth for the IPC contract between the
 * main process and the renderer, plus the network-observation shape that the
 * embedded Instagram tab emits and the Adapter Reader (Task 7) consumes.
 *
 * It is imported by both the main process and the (browser) renderer, so it
 * MUST stay dependency-free (no `electron`, no Node built-ins).
 */

// ---------------------------------------------------------------------------
// Tab network-observation contract (one home: `src/shared/tab-response.ts`)
// ---------------------------------------------------------------------------

export type { ResponseHandler, TabResponse, Unsubscribe } from '@/shared/tab-response';

import type { EngineParkReason, EngineStatus } from '@/engine/engine';
import type { PruneCandidate, PruneState, PruneStatus } from '@/engine/prune-engine';
import type { BridgeInvokers, PushContract, PushMethod } from '@/ipc/contract';
import type { Settings } from '@/settings/settings';
import type { FollowState, Target } from '@/store/types';

// Re-export so the renderer can name the Engine's status shape from one place.
// These are all TYPE-ONLY re-exports — no runtime code crosses into the renderer,
// so the dependency-free contract above still holds.
export type {
  EngineParkReason,
  EngineStatus,
  FollowState,
  PruneCandidate,
  PruneState,
  PruneStatus,
  Settings,
  Target,
};

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
  runtime?: import('./runtime-status').RuntimeStatus;
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

/**
 * Sample-size gate for conversion VERDICTS (docs/PRINCIPLES.md §1 — verdicts
 * wait): the follow-back percentage and the median time-to-follow-back read as
 * measurements only once this many follow outcomes have RESOLVED (reciprocated,
 * or ran out the follow-back wait). Below it the UI shows the raw n-of-m tally
 * and says the verdict is still forming.
 */
export const CONVERSION_VERDICT_MIN = 20;

/**
 * Runway display clamp: past this many days the projection is noise, so the UI
 * reports "> N days" instead of false precision.
 */
export const RUNWAY_CAP_DAYS = 90;

/** Per-lifecycle-state follow_record counts for one chain target (the funnel). */
export type TargetFunnelCounts = Record<FollowState, number>;

/**
 * The Targets console's detail projection for ONE chain target: the chain row
 * plus its live funnel, honest audience framing, and pace-derived runway. All
 * graph-derived (§2) — served by the `chain:detail` invoke and re-read by the
 * renderer on every `chainList` push (the store-mutation tick), so every number
 * moves DURING acquisition walks.
 */
export interface ChainTargetDetail extends ChainTargetView {
  /** follow_records per lifecycle state, zero-filled across the whole union. */
  funnel: TargetFunnelCounts;
  /** The target's true follower count (profile stat); null until enriched. */
  trueFollowers: number | null;
  /** Followers observed (walked into the graph) so far — never the audience size. */
  scanned: number;
  /** Actionable stock: queued records + scoreable not-yet-enqueued candidates. */
  remainingActionable: number;
  /** Follow outcomes that have settled (reached the follow stage and are no
   *  longer awaiting a follow-back) — the conversion verdict's sample size. */
  resolvedOutcomes: number;
  /** Median follow-back latency (ms). Null until {@link CONVERSION_VERDICT_MIN}
   *  outcomes resolve (§1), or when no follow-back has been observed yet. */
  medianFollowbackMs: number | null;
  /** Days until the actionable stock drains at the current pace (realized
   *  7-day follow rate, falling back to today's plan before history exists);
   *  null before any pace exists. `overCap` flags a projection past
   *  {@link RUNWAY_CAP_DAYS} (shown clamped, not falsely precise). */
  runway: { days: number; overCap: boolean } | null;
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
 * The `growth:series` read: the per-day series PLUS the moment follower
 * measurement began (`followersBaselineAt`). The baseline is what lets the
 * renderer be honest about coverage — the "All" window spans from it, and the
 * momentum delta only reads once measurement covers the compared windows
 * (before that the badge would imply measurement where none exists).
 */
export interface GrowthSeriesRead {
  points: NetGrowthPoint[];
  /** Epoch ms measurement began, or null before any sweep/census ran. */
  baselineAt: number | null;
}

// ---------------------------------------------------------------------------
// Network-graph projection (renderer -> main, via invoke) — the Graph view
// ---------------------------------------------------------------------------

/**
 * Every status a graph node can carry, in legend order. A node's `statuses`
 * entry indexes into this tuple. The first seven mirror the churn lifecycle
 * (`FollowState`); the last three describe relationship-only nodes that have
 * no follow record (organic followers, manual follows, and both at once).
 * `waiting` and `held` are the two TIMED statuses — their `progress` runs
 * 0..1 toward the follow-back timeout / the hold release.
 */
export const GRAPH_NODE_STATUSES = [
  'known',
  'queued',
  'waiting',
  'held',
  'unfollow_queued',
  'unfollowed',
  'abandoned',
  'external',
  'follows_you',
  'you_follow',
  'mutual',
] as const;
export type GraphNodeStatus = (typeof GRAPH_NODE_STATUSES)[number];

/** A cluster anchor on the graph canvas: you, or one chain target. */
export interface GraphHub {
  pk: string;
  username: string | null;
  kind: 'self' | 'target';
  /** Chain-target lifecycle when `kind` is 'target'; null for the self hub. */
  targetStatus: 'active' | 'exhausted' | 'retained' | null;
  chainIndex: number | null;
  /** Nodes whose primary cluster is this hub (set by the shaper). */
  memberCount: number;
}

/**
 * The whole knowledge graph shaped for the Graph view's canvas. Columnar and
 * typed-array-backed on purpose: tens of thousands of nodes cross the IPC
 * boundary as a handful of flat buffers (structured-clone-friendly) instead
 * of an object per account. Index `i` across every parallel array describes
 * one node; `hubIndex[i]` names its primary cluster ("who knows them" — the
 * chain target whose follower list surfaced it, or the self hub for your own
 * followers/follows).
 */
export interface GraphSnapshot {
  /** Epoch ms the snapshot (and its timer `progress` values) was computed. */
  at: number;
  hubs: GraphHub[];
  /** Node identity (account pk) — stable across refreshes. */
  pks: string[];
  usernames: (string | null)[];
  /** Index into {@link GRAPH_NODE_STATUSES}, one per node. */
  statuses: Uint8Array;
  /** 0..1 timer progress for the timed statuses (waiting/held); -1 untimed. */
  progress: Float32Array;
  /** Index into `hubs`; every node has a primary cluster. */
  hubIndex: Int32Array;
  /** Known follower count per node (a size cue); -1 when unknown. */
  followers: Float64Array;
  /** Per-status node totals (the legend), consistent with `statuses`. */
  counts: Record<GraphNodeStatus, number>;
}

/**
 * What fills the window region right of the console: the embedded IG tab, the
 * network graph, or the prune screen (both non-'tab' modes hide the native
 * tab view, which keeps running underneath).
 */
export type StageMode = 'tab' | 'graph' | 'prune';

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
// Self-updater (docs/RELEASE.md §5)
// ---------------------------------------------------------------------------

/**
 * What "update itself" means on this install: 'full' downloads and installs
 * (Windows NSIS), 'notify' can only announce and open the release page
 * (unsigned macOS, Windows portable), 'off' means no updater at all
 * (unpackaged dev runs).
 */
export type UpdateMode = 'full' | 'notify' | 'off';

/** The updater's live state, pushed to the renderer as it changes. */
export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';
  mode: UpdateMode;
  /** The running app's version (always present — the Updates card shows it). */
  current: string;
  /** The offered version, once one is known (available/downloading/ready). */
  version: string | null;
  /** Download progress percent while 'downloading' (full mode only). */
  percent: number | null;
  /** Human-readable failure, only when state === 'error'. */
  error: string | null;
}

/**
 * Payload pushed on each renderer-facing event channel — DERIVED from the push
 * half of the IPC contract (`PushContract` in `src/ipc/contract.ts`), which is
 * also where the channel strings live. This used to be a third hand-written
 * table alongside `preload.ts`'s map and `main.ts`'s literal sends. See ADR 1008.
 */
export type EpoEventPayloads = PushContract;

/** Channels pushed from the main process to the renderer. */
export type EpoEventChannel = PushMethod;

// ---------------------------------------------------------------------------
// The bridge exposed on `window.epo` by the preload script
// ---------------------------------------------------------------------------

/**
 * `window.epo`. The invoke half is DERIVED from the IPC contract (one entry per
 * channel in `src/ipc/contract.ts`), so a method signature can never drift from
 * the handler it reaches; only the push-subscription verbs are declared here.
 */
export interface EpoBridge extends BridgeInvokers {
  /** Subscribe to pushed prune status projections (`on('pruneStatus', …)` sugar). */
  onPruneStatus(cb: (status: PruneStatus) => void): void;
  /** Unsubscribe a previously-registered prune status listener. */
  offPruneStatus(cb: (status: PruneStatus) => void): void;
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

/**
 * The knowledge graph shaped for the Graph view's canvas — the `graph:snapshot`
 * read's payload. Pure value types plus the one legend tuple both sides index
 * into; the shaper (main) and the canvas (renderer) share this file and nothing
 * else.
 */

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

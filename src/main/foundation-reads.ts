/**
 * Pure read-shaping for the dashboard's list panels (§5).
 *
 * These functions turn raw `KnowledgeStore` reads into the exact renderer-facing
 * shapes (`ChainTargetView[]`, `QueueListResult`). They live apart from the
 * Electron-bound `Foundation` so they can be unit-tested against a plain fake store
 * — no browser, no SQLite, no login. Every call here is a STORE CALL (no SQL), so
 * the store's single-boundary rule is preserved.
 */

import {
  type AccountState,
  compareByScoreDesc,
  type FollowRecord,
  type FollowState,
  type GraphSourceRows,
  type Target,
} from '@/store/types';
import {
  type ChainTargetView,
  GRAPH_NODE_STATUSES,
  type GraphHub,
  type GraphNodeStatus,
  type GraphSnapshot,
  type QueueListResult,
  type QueueRow,
  type TargetYield,
} from '@/types';

/** The narrow slice of `KnowledgeStore` the chain projection reads. */
export interface ChainReadStore {
  listTargets(): Target[];
  getAccount(pk: string): AccountState | null;
  targetYield(targetPk: string, ownPk: string): TargetYield;
}

/** The narrow slice of `KnowledgeStore` the queue projection reads. */
export interface QueueReadStore {
  followRecordsByState(state: FollowState): FollowRecord[];
  getAccount(pk: string): AccountState | null;
}

/** Default cap on rows returned per queue tab (the rest are flagged truncated). */
export const QUEUE_ROW_CAP = 100;

/**
 * Every chain target, in the store's chain order, each augmented with its account
 * username and its on-demand yield (follow-back rate, pool size, overlap).
 */
export function shapeChainList(store: ChainReadStore, ownPk: string): ChainTargetView[] {
  return store.listTargets().map((t) => ({
    ...t,
    username: store.getAccount(t.accountPk)?.username ?? null,
    yield: store.targetYield(t.accountPk, ownPk),
  }));
}

/**
 * Order a queue's records the way the pipeline actually processes them, so the
 * DISPLAY matches reality:
 *  - `queued`             → best candidate first (Scorer's composite `score`),
 *                           the same ranking `nextDue` follows to pick the next
 *                           account to act on (shared {@link compareByScoreDesc}).
 *  - `pending_followback` → oldest follow first (closest to the follow-back timeout).
 *  - `followed_back`      → nearest hold expiry first.
 *  - `unfollow_queued`    → nearest due first (how `nextDue` reclaims slots).
 * Any other/terminal state keeps its natural order.
 *
 * Ordering runs over the WHOLE record set BEFORE the cap, so the capped page is
 * genuinely the top-N — never an arbitrary DB-order slice that then hides the
 * best candidates behind the truncation note.
 */
function orderedForDisplay(records: FollowRecord[], state: FollowState): FollowRecord[] {
  const byTimeAsc = (key: keyof FollowRecord) =>
    [...records].sort((a, b) => ((a[key] as number) ?? 0) - ((b[key] as number) ?? 0));
  switch (state) {
    case 'queued':
      return [...records].sort(compareByScoreDesc);
    case 'pending_followback':
      return byTimeAsc('followedAt');
    case 'followed_back':
      return byTimeAsc('holdUntil');
    case 'unfollow_queued':
      return byTimeAsc('unfollowDueAt');
    default:
      return records;
  }
}

/**
 * A capped page of the follow_records in `state`, each joined to its account for the
 * username/ratio/mutuals/private badge the row shows. Records are ORDERED (see
 * {@link orderedForDisplay}) before the cap, so the page is the top-N. `truncated`
 * is true when more records exist than the cap returns (the UI notes it rather than
 * silently dropping them).
 */
export function shapeQueueList(
  store: QueueReadStore,
  state: FollowState,
  cap: number = QUEUE_ROW_CAP,
): QueueListResult {
  const records = orderedForDisplay(store.followRecordsByState(state), state);
  const truncated = records.length > cap;
  const rows: QueueRow[] = records.slice(0, cap).map((r) => {
    const acc = store.getAccount(r.accountPk);
    return {
      pk: r.accountPk,
      username: acc?.username ?? null,
      ratio: acc?.ratio ?? null,
      isPrivate: acc?.isPrivate ?? null,
      mutuals: acc?.mutuals ?? null,
      score: r.score ?? null,
      followedAt: r.followedAt,
      holdUntil: r.holdUntil,
      unfollowDueAt: r.unfollowDueAt,
    };
  });
  return { rows, truncated };
}

// ---------------------------------------------------------------------------
// Graph view — the whole knowledge graph as one columnar snapshot
// ---------------------------------------------------------------------------

/** Timer inputs for the graph snapshot's two timed statuses. */
export interface GraphShapeOpts {
  /** Epoch ms "now" — stamps the snapshot and anchors both progress clocks. */
  now: number;
  /** The follow-back wait window (settings `maxWaitForFollowbackDays`, in ms). */
  followbackWaitMs: number;
}

/** How each churn lifecycle state reads on the graph. */
const RECORD_STATUS: Record<FollowState, GraphNodeStatus> = {
  queued: 'queued',
  pending_followback: 'waiting',
  followed_back: 'held',
  unfollow_queued: 'unfollow_queued',
  unfollowed: 'unfollowed',
  abandoned: 'abandoned',
  external: 'external',
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * `pending_followback` runs from the follow toward the no-follow-back timeout;
 * `followed_back` runs from reciprocation toward the hold release. A record
 * missing its start stamp reads as 0 (the clock has not visibly started); a
 * degenerate window (hold already elapsed at stamp time) reads as 1.
 */
function timerProgress(
  status: GraphNodeStatus,
  r: { followedAt: number | null; followedBackAt: number | null; holdUntil: number | null },
  opts: GraphShapeOpts,
): number {
  if (status === 'waiting') {
    if (r.followedAt === null) return 0;
    if (opts.followbackWaitMs <= 0) return 1;
    return clamp01((opts.now - r.followedAt) / opts.followbackWaitMs);
  }
  if (status === 'held') {
    if (r.followedBackAt === null || r.holdUntil === null) return 0;
    const span = r.holdUntil - r.followedBackAt;
    if (span <= 0) return 1;
    return clamp01((opts.now - r.followedBackAt) / span);
  }
  return -1;
}

/** The shaper's per-node working state before the columnar flatten. */
interface WorkingNode {
  username: string | null;
  followers: number | null;
  statusIdx: number;
  progress: number;
  hubIdx: number;
}

/**
 * Fold the store's raw graph rows into the renderer-facing {@link GraphSnapshot}.
 *
 * Precedence, applied in write order so the later, stronger fact wins:
 *  1. crowd rows (followers of chain targets) → `known`, first hub in chain
 *     order claiming the node;
 *  2. our own followers → `follows_you`;
 *  3. accounts we follow → `you_follow`, upgrading to `mutual` when they
 *     already read `follows_you`;
 *  4. follow_records → the churn lifecycle status ALWAYS wins (with its timer
 *     progress), and the record's target claims the node's cluster.
 * Hubs themselves and the self account are never members. Null in, null out
 * (pre-login there is nothing to draw).
 */
export function shapeGraphSnapshot(
  raw: GraphSourceRows | null,
  opts: GraphShapeOpts,
): GraphSnapshot | null {
  if (raw === null) return null;

  const hubs: GraphHub[] = [
    {
      pk: raw.ownPk,
      username: raw.ownUsername,
      kind: 'self',
      targetStatus: null,
      chainIndex: null,
      memberCount: 0,
    },
    ...raw.hubs.map(
      (h): GraphHub => ({
        pk: h.pk,
        username: h.username,
        kind: 'target',
        targetStatus: h.status,
        chainIndex: h.chainIndex,
        memberCount: 0,
      }),
    ),
  ];
  const hubIdxByPk = new Map<string, number>(hubs.map((h, i) => [h.pk, i]));
  const SELF = 0;

  const statusIdx = new Map<GraphNodeStatus, number>(GRAPH_NODE_STATUSES.map((s, i) => [s, i]));
  const idx = (s: GraphNodeStatus): number => statusIdx.get(s) as number;
  const KNOWN = idx('known');
  const FOLLOWS_YOU = idx('follows_you');
  const YOU_FOLLOW = idx('you_follow');
  const MUTUAL = idx('mutual');

  const nodes = new Map<string, WorkingNode>();
  const isAnchor = (pk: string): boolean => hubIdxByPk.has(pk);

  for (const row of raw.crowd) {
    if (isAnchor(row.pk) || nodes.has(row.pk)) continue; // first hub (chain order) wins
    nodes.set(row.pk, {
      username: row.username,
      followers: row.followers,
      statusIdx: KNOWN,
      progress: -1,
      hubIdx: hubIdxByPk.get(row.hubPk) ?? SELF,
    });
  }

  for (const row of raw.ownFollowers) {
    if (isAnchor(row.pk)) continue;
    const existing = nodes.get(row.pk);
    if (existing) {
      existing.statusIdx = FOLLOWS_YOU;
    } else {
      nodes.set(row.pk, {
        username: row.username,
        followers: row.followers,
        statusIdx: FOLLOWS_YOU,
        progress: -1,
        hubIdx: SELF,
      });
    }
  }

  for (const row of raw.ownFollowing) {
    if (isAnchor(row.pk)) continue;
    const existing = nodes.get(row.pk);
    if (existing) {
      existing.statusIdx = existing.statusIdx === FOLLOWS_YOU ? MUTUAL : YOU_FOLLOW;
    } else {
      nodes.set(row.pk, {
        username: row.username,
        followers: row.followers,
        statusIdx: YOU_FOLLOW,
        progress: -1,
        hubIdx: SELF,
      });
    }
  }

  for (const r of raw.records) {
    if (isAnchor(r.pk)) continue;
    const status = RECORD_STATUS[r.state];
    const existing = nodes.get(r.pk);
    const hubIdx =
      (r.targetPk !== null ? hubIdxByPk.get(r.targetPk) : undefined) ?? existing?.hubIdx ?? SELF;
    nodes.set(r.pk, {
      username: r.username ?? existing?.username ?? null,
      followers: r.followers ?? existing?.followers ?? null,
      statusIdx: idx(status),
      progress: timerProgress(status, r, opts),
      hubIdx,
    });
  }

  const n = nodes.size;
  const pks = new Array<string>(n);
  const usernames = new Array<string | null>(n);
  const statuses = new Uint8Array(n);
  const progress = new Float32Array(n);
  const hubIndex = new Int32Array(n);
  const followers = new Float64Array(n);
  const counts = Object.fromEntries(GRAPH_NODE_STATUSES.map((s) => [s, 0])) as Record<
    GraphNodeStatus,
    number
  >;

  let i = 0;
  for (const [pk, node] of nodes) {
    pks[i] = pk;
    usernames[i] = node.username;
    statuses[i] = node.statusIdx;
    progress[i] = node.progress;
    hubIndex[i] = node.hubIdx;
    followers[i] = node.followers ?? -1;
    counts[GRAPH_NODE_STATUSES[node.statusIdx] as GraphNodeStatus] += 1;
    const hub = hubs[node.hubIdx];
    if (hub) hub.memberCount += 1;
    i += 1;
  }

  return { at: opts.now, hubs, pks, usernames, statuses, progress, hubIndex, followers, counts };
}

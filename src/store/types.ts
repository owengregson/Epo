export type Source =
  | 'followers-list' | 'following-list' | 'friend-requests' | 'show-many' | 'profile'
  | 'activity-feed' | 'search' | 'action';
export const SOURCE_CONFIDENCE: Record<Source, number> = {
  'followers-list': 40, 'following-list': 40, 'friend-requests': 40, search: 40,
  'activity-feed': 60, 'show-many': 80, profile: 90, action: 100,
};
export type EnrichmentLevel = 'stub' | 'listed' | 'profiled';
export interface AccountFields {
  username?: string; followers?: number; following?: number;
  /** How many accounts WE follow also follow this one ("followed by x and N others"). */
  mutuals?: number;
  isPrivate?: boolean; isVerified?: boolean; activitySignal?: number;
  /** Profile bio text ('' = fetched and empty; absent = not observed yet). */
  bio?: string;
}
export interface Observation {
  accountPk: string; observedAt: number; source: Source; fields: AccountFields;
}
export interface AccountState {
  pk: string; username?: string; enrichment: EnrichmentLevel;
  followers?: number; following?: number; ratio?: number; mutuals?: number;
  isPrivate?: boolean; isVerified?: boolean; activitySignal?: number;
  /** Profile bio text ('' = fetched and empty; absent = not observed yet). */
  bio?: string;
  role?: string;
  /**
   * Set when a profile-enrichment fetch returned a PERMANENTLY unusable body
   * (deleted/suspended account, unparseable payload). Enrichment selection
   * skips marked accounts so a dead account at the head of the pool can never
   * consume every enrichment pass of every cycle. Transient failures (rate
   * wall, sentinel) never set this.
   */
  enrichFailedAt?: number;
  statsObservedAt?: number; statsSource?: Source; firstSeenAt: number; lastSeenAt: number;
}
export type EdgeType = 'follows';
export interface Edge {
  srcPk: string; dstPk: string; type: EdgeType;
  firstSeenAt: number; lastConfirmedAt: number; status: 'active' | 'removed';
}
export type FollowState =
  | 'queued'
  | 'pending_followback'   // we followed; waiting for them to follow back (unfollow clock not started)
  | 'followed_back'        // they reciprocated; hold_until set
  | 'unfollow_queued'      // hold elapsed OR no-followback timeout — ready to unfollow
  | 'unfollowed'           // terminal (success or reclaimed)
  | 'abandoned'            // terminal (retries exhausted)
  | 'external';            // terminal — an external actor owns the relationship; Epo backs off

export interface FollowRecord {
  accountPk: string;
  targetPk: string | null;
  state: FollowState;
  followedAt?: number;
  followedBackAt?: number;
  holdUntil?: number;
  unfollowDueAt?: number;
  retryCount: number;
  /**
   * The Scorer's composite score at enqueue time (higher = better). Drives the
   * follow ORDER (`nextDue`) and the queue-list DISPLAY order, so the best
   * candidate acts and shows first. Undefined for records not created by the
   * Scanner (e.g. an externally-observed follow being reconciled).
   */
  score?: number;
}

// --- Graph-view source rows -------------------------------------------------
// Raw joined reads feeding the Graph view's snapshot (shaped in
// `src/main/foundation-reads.ts`). Nullable columns stay `| null` — these are
// SQL rows, not projected state.

/** The account fields every graph row carries for display. */
export interface GraphAccountRow {
  pk: string;
  username: string | null;
  followers: number | null;
}

/** One follow_record joined to its account. */
export interface GraphRecordRow extends GraphAccountRow {
  state: FollowState;
  followedAt: number | null;
  followedBackAt: number | null;
  holdUntil: number | null;
  targetPk: string | null;
}

/** One observed follower of a chain target (`hubPk`), in chain order. */
export interface GraphCrowdRow extends GraphAccountRow {
  hubPk: string;
}

/** One chain target, joined to its account username, in chain order. */
export interface GraphHubRow {
  pk: string;
  username: string | null;
  status: Target['status'];
  chainIndex: number | null;
}

/** Everything the graph-view shaper reads, in one store call. */
export interface GraphSourceRows {
  ownPk: string;
  ownUsername: string | null;
  hubs: GraphHubRow[];
  records: GraphRecordRow[];
  /** Followers of chain targets (chain order — the first hub seen wins). */
  crowd: GraphCrowdRow[];
  ownFollowers: GraphAccountRow[];
  ownFollowing: GraphAccountRow[];
}

/** A node in the poaching chain (§3.5). Maps 1:1 to a row in the `targets` table. */
export interface Target {
  accountPk: string;
  source: 'seed' | 'discovered' | 'own_followers';
  status: 'active' | 'exhausted' | 'retained';
  chainIndex: number | null;
  /**
   * When the chain concluded this target's pool was drained (evidence-stamped
   * by `setTargetStatus(pk, 'exhausted', at)`) — the fact that makes the
   * exhaustion verdict REVERSIBLE: the engine's chain dead-end self-heal
   * re-verifies only targets stamped within a recent window. Absent on active/
   * retained targets and on deliberate retirements (restart-from-seed), which
   * are never auto-revived.
   */
  exhaustedAt?: number;
}

/**
 * The durable snapshot of the latest COMPLETED prune scan (Phase 5): the census
 * counts plus the candidates a run has not yet visited. Saved when a scan
 * completes, consumed row-by-row as a run acts, cleared when the whitelist
 * changes or a new scan begins — so a restart restores exactly the prune data
 * that was live when the app quit. Structurally matches the engine's
 * `PruneCandidate` ({pk, username}).
 */
export interface PruneScanSnapshot {
  /** Epoch ms the scan completed — drives the run-without-rescan freshness window. */
  at: number;
  following: number;
  followers: number;
  /** Size of the candidate set the scan yielded (fixed; `remaining` shrinks). */
  candidateCount: number;
  /** Candidates not yet visited by a run, in scan order. */
  remaining: Array<{ pk: string; username: string | null }>;
}

export const ratioOf = (followers?: number, following?: number): number | undefined =>
  followers && followers > 0 && following !== undefined ? following / followers : undefined;

/**
 * Order follow-records BEST-first: descending `score` (the Scorer's composite),
 * with a scoreless record sorting last and `accountPk` as the deterministic
 * tie-break. The single source of ordering shared by the churn scheduler's
 * `nextDue` (execution order) and the queue-list reader (display order), so a
 * candidate acts and shows in the same rank — never pk/insertion order.
 */
export const compareByScoreDesc = (a: FollowRecord, b: FollowRecord): number => {
  const sa = a.score ?? Number.NEGATIVE_INFINITY;
  const sb = b.score ?? Number.NEGATIVE_INFINITY;
  if (sa !== sb) return sb - sa;
  return a.accountPk < b.accountPk ? -1 : a.accountPk > b.accountPk ? 1 : 0;
};

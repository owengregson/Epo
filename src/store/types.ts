export type Source =
  | 'followers-list' | 'show-many' | 'profile' | 'activity-feed' | 'search' | 'action';
export const SOURCE_CONFIDENCE: Record<Source, number> = {
  'followers-list': 40, search: 40, 'activity-feed': 60, 'show-many': 80, profile: 90, action: 100,
};
export type EnrichmentLevel = 'stub' | 'listed' | 'profiled';
export interface AccountFields {
  username?: string; followers?: number; following?: number;
  isPrivate?: boolean; isVerified?: boolean; activitySignal?: number;
}
export interface Observation {
  accountPk: string; observedAt: number; source: Source; fields: AccountFields;
}
export interface AccountState {
  pk: string; username?: string; enrichment: EnrichmentLevel;
  followers?: number; following?: number; ratio?: number;
  isPrivate?: boolean; isVerified?: boolean; activitySignal?: number;
  role?: string;
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
  | 'abandoned';           // terminal (retries exhausted)

export interface FollowRecord {
  accountPk: string;
  targetPk: string | null;
  state: FollowState;
  followedAt?: number;
  followedBackAt?: number;
  holdUntil?: number;
  unfollowDueAt?: number;
  retryCount: number;
}

export const ratioOf = (followers?: number, following?: number): number | undefined =>
  followers && followers > 0 && following !== undefined ? following / followers : undefined;

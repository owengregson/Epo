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
  statsObservedAt?: number; statsSource?: Source; firstSeenAt: number; lastSeenAt: number;
}
export type EdgeType = 'follows';
export interface Edge {
  srcPk: string; dstPk: string; type: EdgeType;
  firstSeenAt: number; lastConfirmedAt: number; status: 'active' | 'removed';
}
export const ratioOf = (followers?: number, following?: number): number | undefined =>
  followers && followers > 0 && following !== undefined ? following / followers : undefined;

/** One "started following you" event, as the notifications drawer reports it. */
export interface FollowbackEvent {
  pk: string;
  username: string | null;
  /** Event time in epoch ms when the feed carried one; `null` otherwise. */
  atMs: number | null;
}

/** One follow request the drawer pass ACCEPTED (they follow us as of the accept). */
export interface FollowbackAccepted {
  pk: string | null;
  username: string;
}

/** What the follow-back appliers read from Settings. */
export interface FollowbackConfig {
  /** How long to hold a reciprocated follow before it can be unfollowed. Sets `holdUntil`. */
  holdAfterFollowbackMs: number;
  /** Accept incoming follow requests in the sweep's drawer pass (a private account's follow-backs). */
  autoAcceptRequests: boolean;
}

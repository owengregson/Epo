import { MS_PER_DAY } from '../timing/units';

/** One "started following you" event, as the notifications source reports it. */
export interface FollowbackEvent {
  pk: string;
  username: string | null;
  /** Event time in epoch ms when the feed carried one; `null` otherwise. */
  atMs: number | null;
}

/** One follow request the source ACCEPTED (they follow us as of the accept). */
export interface FollowbackAccepted {
  pk: string | null;
  username: string;
}

/**
 * The follow-back watcher's Instagram source: one bounded read of the RECENT
 * "started following you" events (the live implementation clicks the
 * notifications drawer and parses the observed news-inbox response), plus —
 * when `acceptRequests` is passed — the drawer's "Follow requests" subtab,
 * auto-accepting pending requests (a PRIVATE account's follow-backs arrive as
 * requests and never surface as follow events until accepted). A failed read
 * is `ok: false` — never an empty success, so "nobody followed back" and
 * "could not read" stay distinguishable. Tests inject a scripted fake.
 */
export interface FollowbackNotifications {
  fetchRecent(opts?: { acceptRequests?: boolean }): Promise<{
    ok: boolean;
    events: FollowbackEvent[];
    accepted?: FollowbackAccepted[];
    pendingRequestPks?: string[];
    reason?: string;
    retryAt?: number;
  }>;
}

/** Tunable knobs for the Follow-back Watcher. Exposed in Settings. */
export interface FollowbackConfig {
  /** How long to hold a reciprocated follow before it can be unfollowed. Sets `holdUntil`. */
  holdAfterFollowbackMs: number;
  /**
   * Auto-accept incoming follow requests during each check (private accounts:
   * a requester is a follow-back the moment we accept). The source soft-skips
   * when no requests entry exists, so this is free for public accounts.
   */
  autoAcceptRequests: boolean;
  maxWaitForFollowbackMs?: number;
}

export interface FollowbackCheckResult {
  detected: string[];
  outcome: 'complete' | 'partial' | 'failed';
  reconciledAt: number | null;
  unresolved: number;
  deferred?: 'read-budget' | 'pending-requests' | 'reconciliation-progress';
  retryAt?: number;
}

export interface FollowbackCensus {
  fetchAllPks(): Promise<{
    pks: string[]; complete: boolean; authoritative?: boolean;
    reason?: string; retryAt?: number;
  }>;
}

/** Fresh expected-PK observations of managed relationships, independent of audience size. */
export interface FollowbackRelationships {
  read(accountPk: string, username: string): Promise<
    { ok: true; followsUs: boolean; observedAt: number }
    | { ok: false; reason: 'read-budget' | 'unavailable'; retryAt?: number }
  >;
}

export const RELATIONSHIP_FRESH_MS = MS_PER_DAY;

/** Design defaults: 2-day hold; requests auto-accepted. */
export const FOLLOWBACK_DEFAULTS: FollowbackConfig = {
  holdAfterFollowbackMs: 2 * MS_PER_DAY,
  autoAcceptRequests: true,
};

/**
 * Instagram adapter field notes — the SINGLE source of truth for everything
 * Instagram-specific, distilled from a LIVE capture (Task E) of real responses
 * and DOM on 2026-08-12. When Instagram changes its surface, this file (plus the
 * Reader/Actor that consume it) is the one place to update.
 *
 * Reads come from the JSON/GraphQL data layer (structure-stable). DOM is touched
 * only to click buttons and scroll — and DOM class names are obfuscated and
 * rotate (e.g. `_aswp _aswr`), so the Actor matches by TEXT/ROLE, never by class.
 */

/** Capture provenance — bump when these notes are re-verified against live IG. */
export const ADAPTER_VERSION = '2026-08-12';

/** Instagram web app id — required header for the private JSON API. */
export const IG_APP_ID = '936619743392459';

export const IG_ORIGIN = 'https://www.instagram.com';

/**
 * Response-URL matchers. The Reader tests an intercepted response's URL against
 * these to decide how to parse it. Order matters for callers: test `friendshipShow`
 * before `showMany`/`followersList` (all live under `/friendships/`).
 */
export const ENDPOINTS = {
  /** GET /api/v1/friendships/<userId>/followers/?...&max_id=<cursor> */
  followersList: /\/api\/v1\/friendships\/\d+\/followers\//,
  /** POST /api/v1/friendships/show_many/ — batched relationship status (following only) */
  showMany: /\/api\/v1\/friendships\/show_many\//,
  /** GET /api/v1/friendships/show/<pk>/ — single relationship, BOTH directions */
  friendshipShow: /\/api\/v1\/friendships\/show\/\d+\//,
  /** GET /api/v1/users/web_profile_info/?username=<u> — profile incl. counts */
  webProfileInfo: /\/api\/v1\/users\/web_profile_info\//,
  /** POST /graphql/query — many shapes; profile/timeline queries land here */
  graphql: /\/graphql\/query/,
  /** GET /api/v1/news/inbox/ — activity feed (new-follower events) */
  activityFeed: /\/api\/v1\/news\/inbox\//,
} as const;

/**
 * Observed max user-ids per `show_many` request. Conservative; the Follow-back
 * Watcher batches at or below this. Refine if a live request proves a higher cap.
 */
export const SHOW_MANY_MAX_BATCH = 200;

/**
 * JSON shapes (documented; the Reader implements the accessors and is unit-tested
 * against sanitized fixtures derived from these exact live responses).
 *
 * followers-list  { users: [{ pk, username, full_name, is_private, is_verified }],
 *                   next_max_id, has_more }            // next_max_id is the REAL resume cursor
 *
 * web_profile_info { data: { user: {
 *                     id,                               // numeric pk (string)
 *                     username, is_private, is_verified,
 *                     edge_followed_by: { count },      // FOLLOWERS count
 *                     edge_follow:      { count } } } }  // FOLLOWING count
 *
 * friendships/show/<pk>  { following, followed_by,      // followed_by => THEY follow us (follow-back!)
 *                          is_private, incoming_request, outgoing_request, blocking }
 *
 * show_many        { friendship_statuses: { <pk>: {
 *                     following,                        // WE follow them (NO followed_by here)
 *                     is_private, incoming_request, outgoing_request } } }
 */
export const JSON_PATHS = {
  followersList: {
    users: 'users',
    userPk: 'pk',
    userName: 'username',
    fullName: 'full_name',
    isPrivate: 'is_private',
    isVerified: 'is_verified',
    nextMaxId: 'next_max_id',
    hasMore: 'has_more',
  },
  webProfileInfo: {
    user: 'data.user',
    id: 'id',
    username: 'username',
    followersCount: 'edge_followed_by.count',
    followingCount: 'edge_follow.count',
    isPrivate: 'is_private',
    isVerified: 'is_verified',
  },
  friendshipShow: {
    following: 'following',
    followedBy: 'followed_by',
    isPrivate: 'is_private',
  },
  showMany: {
    statuses: 'friendship_statuses',
    following: 'following',
    isPrivate: 'is_private',
  },
} as const;

/**
 * DOM contact points (Actor only). Class names rotate — match by text/role.
 */
export const SELECTORS = {
  /** The followers/following modal. */
  dialog: '[role="dialog"]',
  /** Profile link that opens the followers modal (logged-in web). */
  followersLink: (username: string): string => `a[href="/${username}/followers/"]`,
  /**
   * Profile action button lives in the profile header as a `<button type="button">`.
   * Its textContent LEADS with the state word but may include icon alt text
   * (observed: "FollowingDown chevron icon"), so match the leading word only.
   */
  profileActionButtonRole: 'header button, header [role="button"]',
  followText: /^\s*follow(\s|$)/i,
  followingText: /^\s*following/i,
  requestedText: /^\s*requested/i,
  followBackText: /^\s*follow back/i,
  /** The confirm control in the unfollow dialog — exact text "Unfollow". */
  unfollowConfirmText: /^\s*unfollow\s*$/i,
} as const;

/**
 * Followers-dialog scroll container. Class names are unstable, so locate at
 * runtime: within the dialog, the descendant with the largest scrollable height
 * (`scrollHeight > clientHeight` and computed `overflow-y` auto|scroll). Scrolling
 * it is what triggers the paginated `followers/` API the Reader intercepts.
 */
export const SCROLL_CONTAINER_HEURISTIC =
  'within [role="dialog"]: the descendant div with the greatest scrollHeight whose ' +
  'computed overflow-y is auto|scroll and scrollHeight > clientHeight';

/**
 * Block / challenge / logged-out signatures (Sentinel). URL checks are the most
 * reliable; text checks are best-effort (no block screen was captured live — refine
 * the first time one is hit). Any match => halt the engine and alert.
 */
export const BLOCK_SIGNATURES = {
  urls: [/\/challenge\//i, /\/accounts\/suspended\//i, /\/accounts\/login\//i],
  texts: [
    /action blocked/i,
    /try again later/i,
    /we restrict certain activity/i,
    /confirm it['’]s you/i,
    /your account has been/i,
  ],
} as const;

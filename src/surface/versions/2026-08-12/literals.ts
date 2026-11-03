/**
 * Instagram literals — capture 2026-08-12.
 *
 * THE one home for everything Instagram-specific: URLs, JSON paths, selectors,
 * text matchers, app id, block signatures, page sizes. Nothing outside
 * `src/surface/versions/<capture-date>/` may carry an Instagram fact; the
 * adapter's version module (`src/adapter/versions/2026-08-12.ts`) is now a
 * migration shim that imports from here and declares nothing of its own, and
 * the page bundle receives all of it as JSON config (ADR 0301).
 *
 * Verified live 2026-08-12 against real responses and DOM. When Instagram
 * changes, add a sibling directory and re-point `src/surface/index.ts`.
 *
 * AMENDED 2026-09-18: the profile read was re-verified live after Instagram
 * retired `/api/v1/users/web_profile_info/` (see `URLS.profileInfo`).
 *
 * AMENDED 2026-10-08 (`npm run probe`, phases traffic/endpoints/drawer/visit):
 * `/users/<pk>/info/` now answers HTTP 429 with an empty body and
 * `accounts/current_user/` a 200 HTML page at `/` — Epo composes NEITHER any
 * more; a profile is read by VISITING it (the page's own GraphQL body, see
 * `PROFILE_GRAPHQL_FRIENDLY_NAME`). The news inbox is now a POST. The nav rail
 * re-renders on hover (settle-then-press, `src/adapter/settle-press.ts`). The
 * list endpoints, show_many, friendships/pending and topsearch still answer
 * their captured shapes.
 *
 * AMENDED 2026-11-02 (`EPO_PROBE=verify`): the notifications drawer's client
 * moved its feed and its follow-requests panel to GraphQL (operations below);
 * the stories and user rows inside are unchanged, only wrapped.
 */

import { SELECTORS } from '@/surface/versions/2026-08-12/literals-dom';

/** Capture provenance — bump when these notes are re-verified against live IG. */
export const VERSION = '2026-08-12';

/** Instagram web app id — required header for the private JSON API. */
export const IG_APP_ID = '936619743392459';

export const IG_ORIGIN = 'https://www.instagram.com';

/**
 * A genuine desktop Chrome-on-macOS User-Agent. Electron's default advertises
 * `Electron/<version>`, which Instagram's private JSON endpoints reject with
 * "useragent mismatch"; the persistent session pins this one so the API calls
 * the Reader depends on are accepted. Bump alongside {@link VERSION}.
 */
export const IG_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/**
 * Page size for DIRECT friendships-list pagination. The dialog's own scroll batches
 * carry ~12 users; the API accepts a larger `count` — 50 is the widely-exercised value,
 * well under any observed rejection threshold. A SERVER tolerance (see ADR 0802).
 */
export const LIST_PAGE_COUNT = 50;
/** FOLLOWING only: the default order is re-ranked per request; this one is fixed and answers the whole list. */
export const FOLLOWING_LIST_ORDER = '&order=date_followed_earliest';

// ---------------------------------------------------------------------------
// Endpoint URL patterns. ORDER MATTERS in the document's endpoint array:
// `friendship-show` is tested before `show-many`/`followers-list` (all live under
// `/friendships/`, and a `show/<pk>/` URL also contains a numeric segment).
// ---------------------------------------------------------------------------

export const URLS = {
  /** GET /api/v1/friendships/show/<pk>/ — single relationship, BOTH directions. */
  friendshipShow: /\/api\/v1\/friendships\/show\/\d+\//,
  friendshipShowPk: /\/friendships\/show\/(\d+)\//,
  /** POST /api/v1/friendships/show_many/ — batched status (following only). */
  showMany: /\/api\/v1\/friendships\/show_many\//,
  /** GET /api/v1/friendships/<userId>/followers/?…&max_id=<cursor> */
  followersList: /\/api\/v1\/friendships\/\d+\/followers\//,
  followersListTargetPk: /\/friendships\/(\d+)\/followers\//,
  /** GET /api/v1/friendships/<userId>/following/ — same paginated body shape. */
  followingList: /\/api\/v1\/friendships\/\d+\/following\//,
  followingListTargetPk: /\/friendships\/(\d+)\/following\//,
  /**
   * GET /api/v1/users/<pk>/info/ — profile incl. counts.
   *
   * RETIRED 2026-09-18: `/api/v1/users/web_profile_info/?username=<u>` used to
   * serve this. Instagram now answers it with a 21,600-byte HTML shell under
   * HTTP 429 for EVERY request shape — no headers, the full
   * app-id/csrf/www-claim/asbd set, Chrome 128 and Chrome 152 all get the same
   * page, while profile pages and every other endpoint in this file stay
   * healthy on the same session. Instagram's own web client stopped calling it
   * (it reads profiles through `/api/graphql`, see {@link graphql}), so
   * this is a retirement, not a rate wall. Verified live 2026-09-18.
   *
   * WALLED TOO 2026-10-08: this replacement answers HTTP 429 with an EMPTY body
   * (since ~2026-09-20) while topsearch and the list endpoints answer JSON on
   * the same session — and the web client never calls it either. Kept as an
   * observe-only route; Epo no longer requests it (profiles are visited).
   */
  profileInfo: /\/api\/v1\/users\/\d+\/info\//,
  profileInfoPk: /\/api\/v1\/users\/(\d+)\/info\//,
  /** POST /api/v1/news/inbox/ — the activity feed's REST form (the client's read until 2026-10). */
  activityFeed: /\/api\/v1\/news\/inbox\//,
  /** GET /api/v1/friendships/pending/ — follow requests' REST form (until 2026-10). */
  friendRequests: /\/api\/v1\/friendships\/pending\//,
  /**
   * Any GraphQL path the client posts to (`/api/graphql`, `/graphql/query`), routed by operation
   * name. The profile query (`PolarisProfilePageContentQuery`, what Instagram's own client fires
   * on a profile page) is OBSERVED here, never composed: a profile is visited and this body read.
   */
  graphql: /\/graphql(?:[/?#]|$)/,
} as const;

/**
 * Fetch paths built in page context — the ONLY place a request URL is composed.
 * Since 2026-10-08 the list pages are the only reads Epo composes (Instagram's
 * own client calls the same endpoint); profiles are visited, never fetched.
 */
export const PATHS = {
  friendshipsList: '/api/v1/friendships/',
} as const;

/**
 * The friendly-name header value that marks a profile-carrying GraphQL response.
 * Matched case-insensitively against the LOWER-CASED request headers the tab records.
 */
export const PROFILE_GRAPHQL_FRIENDLY_NAME = /PolarisProfilePageContentQuery/i;

/** The notifications drawer's reads since 2026-11: the feed, and the follow-requests panel. */
export const ACTIVITY_FEED_GRAPHQL_FRIENDLY_NAME = /PolarisActivityFeedStoriesViewQuery/i;
export const FOLLOW_REQUESTS_GRAPHQL_FRIENDLY_NAME = /PolarisActivityFeedFollowRequestsViewQuery/i;
/** The follow-requests panel's GraphQL root field (live 2026-11-02, every captured body). */
export const FOLLOW_REQUESTS_ROOT_FIELDS: readonly string[] = ['xdt_friendships_pending_users'];

/**
 * Media types that carry a PARSEABLE body on an API URL.
 *
 * The REST endpoints answer `application/json`, but `/api/graphql` answers
 * `text/javascript` — a strict json-only gate silently drops every observed
 * GraphQL profile body. Anything else on an API URL (notably `text/html`) is a
 * wall, not data.
 */
export const BODY_MIME_PARSEABLE = /json|javascript|multipart\/mixed/i;

// ---------------------------------------------------------------------------
// Relationship MUTATIONS — the requests the action button fires.
//
//   POST /api/v1/web/friendships/<pk>/follow/     → { result: "following"|"requested", status: "ok" }
//   POST /api/v1/web/friendships/<pk>/unfollow/   → { status: "ok" }
//   POST /api/v1/friendships/create|destroy/<pk>/ (app-style form; same keys)
//   POST <any GraphQL path> + x-fb-friendly-name: …FollowMutation / …UnfollowMutation
//     → { data: { <op>: { friendship_status: {…} } }, status: "ok" }. The path is matched
//     loosely: GraphQL moved `/graphql/query` → `/api/graphql` (2026-09) and a matcher
//     pinned to the old path left EVERY click unobserved. The friendly name is the identity.
//     Live 2026-10-08 (one follow+unfollow of @instagram): `usePolarisFollowMutation` /
//     `usePolarisUnfollowMutation` on `/api/graphql`, answering `xdt_create_friendship` /
//     `xdt_destroy_friendship` — both observed, both verdicts `ok`.
// A THROTTLED action (no dialog, the button just snaps back) answers HTTP 400 with
//   { message: "feedback_required", spam: true, feedback_title: "Try Again Later",
//     feedback_message: "We restrict certain activity…", status: "fail" }
// ---------------------------------------------------------------------------

export const MUTATION_URLS = {
  follow: /\/web\/friendships\/(\d+)\/follow\/?(?:[?#]|$)/,
  unfollow: /\/web\/friendships\/(\d+)\/unfollow\/?(?:[?#]|$)/,
  followApp: /\/api\/v1\/friendships\/create\/(\d+)\//,
  unfollowApp: /\/api\/v1\/friendships\/destroy\/(\d+)\//,
  graphql: /\/graphql(?:[/?#]|$)/,
} as const;

/** The request header naming a GraphQL operation (lower-cased by the tab). */
export const GRAPHQL_FRIENDLY_NAME_HEADER = 'x-fb-friendly-name';
export const GRAPHQL_MUTATION_NAME = /mutation/i;
export const GRAPHQL_UNFOLLOW_NAME = /unfollow/i;
export const GRAPHQL_FOLLOW_NAME = /follow/i;

// JSON paths, DOM contact points and signals live in sibling modules,
// re-exported here so every consumer keeps one import site.
export {
  AVATAR_ALT_RE,
  NAV_PROFILE_PATH_RE,
  PROFILE_PATH_RE,
  RESERVED_ROUTES,
  ROLES,
  ROW_PROFILE_PATH_RE,
  SCOPES,
  SELECTORS,
  USERNAME_RE,
} from '@/surface/versions/2026-08-12/literals-dom';
export { JSON_PATHS, MUTATION_JSON } from '@/surface/versions/2026-08-12/literals-json';
export {
  MUTATION_REFUSAL_SIGNATURES,
  TEXT_BLOCK_SIGNATURES,
  URL_BLOCK_SIGNATURES,
} from '@/surface/versions/2026-08-12/literals-signals';

// ---------------------------------------------------------------------------
// Capture-harness extras — broader, URL-substring heuristics the live capture
// harness uses BEFORE bodies exist. Kept here so the harness owns no literals.
// ---------------------------------------------------------------------------

export const CAPTURE_PATTERNS = {
  /** The list-dialog deep link: navigating here opens the modal directly. */
  listDialogUrl: (username: string, which: 'followers' | 'following'): string =>
    `${IG_ORIGIN}/${username}/${which}/`,
  /** The modal container the harness snapshots (`outerHTML`). */
  dialogSelector: SELECTORS.dialog,
  /** Any GraphQL path — many shapes; profile/timeline queries land here. */
  graphql: '/graphql',
  /** A POSTed operation worth saving even when the mutation table does not know it. */
  mutationSuspectName: /follow|friendship/i,
  /** Broad REST followers heuristic parts (any friendships URL naming followers). */
  friendshipsFragment: 'friendships/',
  followersFragment: 'followers',
  /** GraphQL queries that mention followers (singular matches plural too). */
  followerWord: 'follower',
  /** Any per-user REST endpoint (e.g. /api/v1/users/<pk>/info/). */
  usersApi: '/api/v1/users/',
  /** URL fragments that mark an Instagram JSON API response worth capturing. */
  apiMarkers: ['/api/v1/', '/graphql', 'users/', 'friendships', 'news/inbox'],
} as const;

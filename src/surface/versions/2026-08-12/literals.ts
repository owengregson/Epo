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
 * retired `/api/v1/users/web_profile_info/` (see `URLS.profileInfo`). Only that
 * endpoint moved — followers-list, following-list, friendship-show,
 * news/inbox and friendships/pending were all re-probed on the same session
 * and still answer their captured shapes.
 */

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
   * (it reads profiles through `/api/graphql`, see {@link profileGraphql}), so
   * this is a retirement, not a rate wall. Verified live 2026-09-18.
   */
  profileInfo: /\/api\/v1\/users\/\d+\/info\//,
  profileInfoPk: /\/api\/v1\/users\/(\d+)\/info\//,
  /**
   * POST /api/graphql with `x-fb-friendly-name: PolarisProfilePageContentQuery`
   * — what Instagram's OWN client fires when it opens a profile. Epo never
   * composes this request (it needs a rotating `doc_id` plus scraped
   * `fb_dtsg`/`lsd` tokens); it is OBSERVED so ordinary profile navigation
   * keeps streaming counts into the graph (docs/PRINCIPLES.md §1).
   */
  profileGraphql: /\/api\/graphql\/?(?:[?#]|$)/,
  /** GET /api/v1/web/search/topsearch/?query=<u> — username → pk resolution. */
  topsearch: /\/api\/v1\/web\/search\/topsearch\//,
  /** GET /api/v1/news/inbox/ — activity feed (new-follower events). */
  activityFeed: /\/api\/v1\/news\/inbox\//,
  /** GET /api/v1/friendships/pending/ — incoming follow requests; list shape + `friend_requests`. */
  friendRequests: /\/api\/v1\/friendships\/pending\//,
} as const;

/** Fetch paths built in page context — the ONLY place a request URL is composed. */
export const PATHS = {
  /** A profile read is `${usersPrefix}<pk>${profileInfoSuffix}`. */
  usersPrefix: '/api/v1/users/',
  profileInfoSuffix: '/info/',
  /** Username → pk, the first hop of a profile read (see `URLS.profileInfo`). */
  topsearch: '/api/v1/web/search/topsearch/?context=blended&query=',
  currentUser: '/api/v1/accounts/current_user/',
  friendshipShow: '/api/v1/friendships/show/',
  friendshipsList: '/api/v1/friendships/',
} as const;

/**
 * The friendly-name header value that marks a profile-carrying GraphQL response.
 * Matched case-insensitively against the LOWER-CASED request headers the tab records.
 */
export const PROFILE_GRAPHQL_FRIENDLY_NAME = /PolarisProfilePageContentQuery/i;

/**
 * Media types that carry a PARSEABLE body on an API URL.
 *
 * The REST endpoints answer `application/json`, but `/api/graphql` answers
 * `text/javascript` — a strict json-only gate silently drops every observed
 * GraphQL profile body. Anything else on an API URL (notably `text/html`) is a
 * wall, not data.
 */
export const BODY_MIME_PARSEABLE = /json|javascript/i;

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

/** Verdict keys of a mutation body (REST form; a GraphQL `data` child nests the same). */
export const MUTATION_JSON = {
  status: 'status',
  ok: 'ok',
  fail: 'fail',
  message: 'message',
  spam: 'spam',
  feedbackTitle: 'feedback_title',
  feedbackMessage: 'feedback_message',
  result: 'result',
  errors: 'errors',
  data: 'data',
  friendshipStatus: 'friendship_status',
  following: 'following',
  outgoingRequest: 'outgoing_request',
} as const;

// ---------------------------------------------------------------------------
// JSON paths (verified live 2026-08-12)
// ---------------------------------------------------------------------------

export const JSON_PATHS = {
  followersList: {
    users: 'users',
    userPk: 'pk',
    userName: 'username',
    isPrivate: 'is_private',
    isVerified: 'is_verified',
    nextMaxId: 'next_max_id',
    hasMore: 'has_more',
    /** Alternate more-pages flag carried by some friendships-list responses. */
    bigList: 'big_list',
  },
  /**
   * The profile USER record. Both profile sources carry the same field names —
   * `/users/<pk>/info/` nests it under `user`, the GraphQL profile query under
   * `data.user` — so one field map serves both (`PROFILE_USER_AT` names the
   * container per source).
   *
   * These are the app-API names (`follower_count`), not the retired
   * `web_profile_info` edge shape (`edge_followed_by.count`).
   */
  profileUser: {
    id: 'pk',
    /** `/users/<pk>/info/` answers `pk` as a NUMBER; `id` is its string twin. */
    altId: 'id',
    username: 'username',
    followersCount: 'follower_count',
    followingCount: 'following_count',
    /** MUTUALS: the number behind "Followed by x and N others". */
    mutualCount: 'mutual_followers_count',
    isPrivate: 'is_private',
    isVerified: 'is_verified',
    biography: 'biography',
    /**
     * Viewer-side relationship. Carried by the GraphQL profile body only —
     * `/users/<pk>/info/` omits it, so a caller that needs it reads
     * `friendships/show/<pk>/` (which is unaffected by the retirement).
     */
    followedByViewer: 'friendship_status.following',
    requestedByViewer: 'friendship_status.outgoing_request',
    followsViewer: 'friendship_status.followed_by',
  },
  /** Where each profile source puts that user record. */
  profileUserAt: {
    info: 'user',
    graphql: 'data.user',
  },
  /** The username → pk hop. `users[].user`, matched on an exact username. */
  topsearch: {
    users: 'users',
    user: 'user',
    pk: 'pk',
    username: 'username',
  },
  friendshipShow: {
    following: 'following',
    followedBy: 'followed_by',
    isPrivate: 'is_private',
    outgoingRequest: 'outgoing_request',
  },
  showMany: {
    statuses: 'friendship_statuses',
    following: 'following',
    isPrivate: 'is_private',
    outgoingRequest: 'outgoing_request',
  },
  currentUser: {
    username: 'user.username',
  },
  activityFeed: {
    storySections: ['new_stories', 'old_stories'] as readonly string[],
    storyType: 'story_type',
    followStoryType: 101,
    args: 'args',
    profileId: 'profile_id',
    profileName: 'profile_name',
    /** Feed timestamps are epoch SECONDS (float). */
    timestamp: 'timestamp',
    text: 'text',
    followText: /started following you/i,
  },
} as const;

// ---------------------------------------------------------------------------
// DOM contact points. Class names rotate — match by TEXT/ROLE (ADR 0302).
// ---------------------------------------------------------------------------

export const SELECTORS = {
  /** The followers/following modal. */
  dialog: '[role="dialog"]',
  /**
   * The header COUNTS are `<a href="#">` that open the modal via JS — NOT
   * `/<user>/followers/` links. Located by TEXT: an anchor/button whose text
   * names one stat and NOT the other (`\bfollowers?\b` does not match "following").
   */
  followersStatText: /\bfollowers?\b/i,
  followingStatText: /\bfollowing\b/i,
  /**
   * Profile action button. Renders inside a semantic `<header>`; its textContent
   * LEADS with the state word but may include icon alt text (observed:
   * "FollowingDown chevron icon"), so the matchers are PREFIX tests.
   */
  profileActionButtonRole: 'header button, header [role="button"]',
  followText: /^\s*follow(\s|$)/i,
  followingText: /^\s*following/i,
  requestedText: /^\s*requested/i,
  followBackText: /^\s*follow back/i,
  /** The confirm control in the unfollow / cancel-request dialog (PREFIX match). */
  unfollowConfirmText: /^\s*(unfollow|cancel request)\b/i,
  /** The left-nav notifications control, by accessible name (not an href link). */
  notificationsLabelText: /^\s*notifications\s*$/i,
  /** The "Follow requests" entry inside the open notifications drawer. */
  followRequestsEntryText: /^\s*follow requests\b/i,
  /** The per-row accept control in the follow-requests panel. */
  confirmRequestText: /^\s*confirm\s*$/i,
  /** The "Follows" category filter chip inside the notifications drawer. */
  followsFilterText: /^\s*follows\s*$/i,
  /** The drawer's close (X) control, by accessible name. */
  drawerCloseLabelText: /^\s*close\s*$/i,
  /** The nav avatar image, by its alt-text shape. */
  avatarImage: 'img[alt*="profile picture"], img[alt*="profile photo"]',
  /**
   * Where a block interstitial renders. Deliberately NOT the whole body — a
   * candidate's bio is stranger-controlled text.
   */
  blockTextContainers: '[role="dialog"], [role="alertdialog"], [role="alert"]',
  blockTextHeadings: 'h1, h2',
} as const;

/**
 * Generic DOM vocabulary the searches use. Not Instagram knowledge, but kept
 * beside the selectors so one directory holds everything a new capture retunes.
 */
export const ROLES = {
  /** Anything the page treats as a press target. */
  clickable: 'a, button, [role="button"], [role="link"]',
  /** Role-marked controls, menu items included (the confirm menu's primary pass). */
  menuControl: 'button, [role="button"], [role="menuitem"]',
  /** Press-shaped ancestors a self-recovery hit may resolve to. */
  menuClickable: 'button, [role="button"], [role="menuitem"], [tabindex], a',
  /** Bare containers the self-recovery pass scans when the role query goes blind. */
  bareContainer: 'div, span, a, [tabindex]',
  /** Nodes scanned for a smallest-text match (drawer entries, filter chips). */
  textNode: 'span, div, a, button, [role="button"]',
  /** Elements that can carry an accessible name. */
  labeled: 'svg[aria-label], [aria-label]',
  /** Elements a wheel must not rest on — they open hover cards that eat it. */
  hoverTrigger: 'a, button, [role="button"], img, canvas, video, [role="link"]',
  button: 'button, [role="button"]',
} as const;

/** Scope lists, in the priority order each search walks. */
export const SCOPES = {
  /** Profile header first, then main, then the whole body. */
  profile: ['header', 'main', 'body'],
  /** The nav rail before page content — a stray profile link must never win. */
  nav: ['nav', '[role="navigation"]'],
  navThenBody: ['nav', '[role="navigation"]', 'body'],
  /** The open drawer/modal before page content. */
  drawer: ['[role="dialog"]', '[role="alertdialog"]', 'aside'],
  drawerThenBody: ['[role="dialog"]', '[role="alertdialog"]', 'aside', 'body'],
} as const;

// ---------------------------------------------------------------------------
// Identity knowledge
// ---------------------------------------------------------------------------

/** Non-username first path segments that must never be taken as a username. */
export const RESERVED_ROUTES: ReadonlySet<string> = new Set([
  'explore', 'reels', 'reel', 'direct', 'stories', 'p', 'tv', 'accounts', 'about',
  'legal', 'privacy', 'terms', 'api', 'directory', 'your_activity', 'emails',
  'session', 'challenge', 'oauth', 'developer', 'ads', 'business', 'help',
]);

export const USERNAME_RE = /^[A-Za-z0-9._]+$/;

/** A bare profile path: `/<username>/`. */
export const PROFILE_PATH_RE = /^\/([A-Za-z0-9._]+)\/?$/;

/**
 * The nav avatar link's href shape — the trailing slash is REQUIRED so a
 * partial/relative link elsewhere in the rail cannot pass for our own profile.
 */
export const NAV_PROFILE_PATH_RE = /^\/[A-Za-z0-9._]+\/$/;

/** A follow-request row's profile link; the trailing slash is optional there. */
export const ROW_PROFILE_PATH_RE = /^\/[A-Za-z0-9._]+\/?$/;

/** Avatar alt text: "<username>'s profile picture" (straight or curly quote). */
export const AVATAR_ALT_RE = /^([A-Za-z0-9._]+)['’]s profile/;

// ---------------------------------------------------------------------------
// Signals (Sentinel + mutation refusals)
// ---------------------------------------------------------------------------

/**
 * URL block / challenge / logged-out signatures. The login redirect means the
 * session expired (`logged-out`); `/challenge/` and `/accounts/suspended/` are
 * account interstitials (`challenge`).
 */
export const URL_BLOCK_SIGNATURES = [
  { pattern: /\/challenge\//i, status: 'challenge' },
  { pattern: /\/accounts\/suspended\//i, status: 'challenge' },
  { pattern: /\/accounts\/login\//i, status: 'logged-out' },
] as const;

/** Body-text signatures (best-effort; refine the first time a wall is hit). */
export const TEXT_BLOCK_SIGNATURES = [
  { pattern: /action blocked/i, status: 'action-blocked' },
  { pattern: /try again later/i, status: 'action-blocked' },
  { pattern: /we restrict certain activity/i, status: 'action-blocked' },
  { pattern: /confirm it['’]s you/i, status: 'action-blocked' },
  { pattern: /your account has been/i, status: 'action-blocked' },
] as const;

/**
 * Refusal signatures over a FAILED mutation verdict's message + feedback text.
 * The throttle family maps to `action-blocked` (the ladder waits it out); the
 * session walls map to their sentinel statuses.
 */
export const MUTATION_REFUSAL_SIGNATURES = [
  { pattern: /feedback_required/i, status: 'action-blocked' },
  { pattern: /try again later/i, status: 'action-blocked' },
  { pattern: /we restrict certain activity/i, status: 'action-blocked' },
  { pattern: /rate.?limit|wait a few minutes/i, status: 'action-blocked' },
  { pattern: /checkpoint_required|challenge_required/i, status: 'challenge' },
  { pattern: /login_required/i, status: 'logged-out' },
] as const;

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
  /** Manifest keys for the two fetches the harness drives itself. */
  topsearchKey: (username: string): string =>
    `${PATHS.topsearch}${encodeURIComponent(username)}`,
  profileInfoKey: (pk: string): string =>
    `${PATHS.usersPrefix}${pk}${PATHS.profileInfoSuffix}`,
  friendshipShowKey: (pk: string): string => `${PATHS.friendshipShow}${pk}/`,
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

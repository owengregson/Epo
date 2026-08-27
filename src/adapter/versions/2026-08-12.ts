/**
 * Instagram surface — capture 2026-08-12.
 *
 * The SINGLE source of truth for everything Instagram-specific, distilled from
 * a LIVE capture (Task E) of real responses and DOM on 2026-08-12. When
 * Instagram changes its surface, THIS module (or a successor version module)
 * is the one place to update; the rest of the app consumes the stable
 * `IgSurface` interface (`src/adapter/ig-surface.ts`) and never carries an
 * Instagram literal.
 *
 * Reads come from the JSON/GraphQL data layer (structure-stable). DOM is
 * touched only to click buttons and scroll — and DOM class names are
 * obfuscated and rotate (e.g. `_aswp _aswr`), so the Actor scripts match by
 * TEXT/ROLE, never by class.
 */

import type {
  BlockSignature,
  EndpointIds,
  EndpointKind,
  FollowEvent,
  FollowersListResult,
  FriendshipShowResult,
  IgSurface,
  ShowManyEntry,
  StaleComponent,
} from '@/adapter/ig-surface';
import {
  asBool,
  asCount,
  asStringId,
  getPath,
  isRecord,
  SHAPE_MISMATCH,
  type ShapeMismatch,
} from '@/adapter/parse-helpers';
import type { Observation } from '@/store/types';

/** Capture provenance — bump when these notes are re-verified against live IG. */
const VERSION = '2026-08-12';

/** Instagram web app id — required header for the private JSON API. */
const IG_APP_ID = '936619743392459';

const IG_ORIGIN = 'https://www.instagram.com';

/**
 * A genuine desktop Chrome-on-macOS User-Agent.
 *
 * Electron's default UA advertises `Electron/<version>`, which Instagram's
 * private JSON endpoints reject with "useragent mismatch". The persistent
 * session pins this real Chrome UA so the intercepted API calls the Reader
 * depends on are accepted. Bump alongside `VERSION` when re-verified.
 */
const IG_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/**
 * Page size for DIRECT friendships-list pagination (`listPageScript`). The
 * dialog's own scroll batches carry ~12 users; the API itself accepts a larger
 * `count` — 50 is the widely-exercised value (Instagram's own web surfaces and
 * long-standing third-party tooling both request it), well under any observed
 * rejection threshold.
 */
const LIST_PAGE_COUNT = 50;

/**
 * Observed max user-ids per `show_many` request. Conservative; the Follow-back
 * Watcher batches at or below this. Refine if a live request proves a higher cap.
 */
const SHOW_MANY_MAX_BATCH = 200;

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/**
 * Response-URL matchers plus the ids each URL carries. ORDER MATTERS:
 * `friendship-show` is tested before `show-many`/`followers-list` (all live
 * under `/friendships/`, and a `show/<pk>/` URL also contains a numeric
 * segment).
 */
const ENDPOINT_TABLE: ReadonlyArray<{
  kind: EndpointKind;
  /** GET /api/v1/... — see per-entry comments. */
  pattern: RegExp;
  ids?: { pk?: RegExp; targetPk?: RegExp };
}> = [
  {
    // GET /api/v1/friendships/show/<pk>/ — single relationship, BOTH directions
    kind: 'friendship-show',
    pattern: /\/api\/v1\/friendships\/show\/\d+\//,
    ids: { pk: /\/friendships\/show\/(\d+)\// },
  },
  {
    // POST /api/v1/friendships/show_many/ — batched relationship status (following only)
    kind: 'show-many',
    pattern: /\/api\/v1\/friendships\/show_many\//,
  },
  {
    // GET /api/v1/friendships/<userId>/followers/?...&max_id=<cursor>
    kind: 'followers-list',
    pattern: /\/api\/v1\/friendships\/\d+\/followers\//,
    ids: { targetPk: /\/friendships\/(\d+)\/followers\// },
  },
  {
    // GET /api/v1/friendships/<userId>/following/?...&max_id=<cursor> — same
    // paginated body shape as followers-list (users + next_max_id).
    kind: 'following-list',
    pattern: /\/api\/v1\/friendships\/\d+\/following\//,
    ids: { targetPk: /\/friendships\/(\d+)\/following\// },
  },
  {
    // GET /api/v1/users/web_profile_info/?username=<u> — profile incl. counts
    kind: 'web-profile-info',
    pattern: /\/api\/v1\/users\/web_profile_info\//,
  },
  {
    // GET /api/v1/news/inbox/ — activity feed (new-follower events)
    kind: 'activity-feed',
    pattern: /\/api\/v1\/news\/inbox\//,
  },
  {
    // GET /api/v1/friendships/pending/ — incoming follow requests (private
    // accounts). Fired when the notifications drawer's "Follow requests"
    // entry opens the pending panel; body carries the followers-list shape.
    kind: 'friend-requests',
    pattern: /\/api\/v1\/friendships\/pending\//,
  },
];

// ---------------------------------------------------------------------------
// JSON shapes (verified live 2026-08-12; unit-tested against sanitized
// fixtures derived from these exact live responses).
//
// followers-list  { users: [{ pk, username, full_name, is_private, is_verified }],
//                   next_max_id, has_more }            // next_max_id is the REAL resume cursor
//
// web_profile_info { data: { user: {
//                     id,                               // numeric pk (string)
//                     username, is_private, is_verified,
//                     edge_followed_by: { count },      // FOLLOWERS count
//                     edge_follow:      { count },       // FOLLOWING count
//                     edge_mutual_followed_by: { count } } } }  // MUTUALS ("followed by x and N others")
//
// friendships/show/<pk>  { following, followed_by,      // followed_by => THEY follow us (follow-back!)
//                          is_private, incoming_request, outgoing_request, blocking }
//
// show_many        { friendship_statuses: { <pk>: {
//                     following,                        // WE follow them (NO followed_by here)
//                     is_private, incoming_request, outgoing_request } } }
// ---------------------------------------------------------------------------
const JSON_PATHS = {
  followersList: {
    users: 'users',
    userPk: 'pk',
    userName: 'username',
    isPrivate: 'is_private',
    isVerified: 'is_verified',
    nextMaxId: 'next_max_id',
    hasMore: 'has_more',
    // Alternate more-pages flag: the friendships list endpoints carry
    // `big_list` on some responses instead of (or as well as) `has_more`.
    bigList: 'big_list',
  },
  webProfileInfo: {
    user: 'data.user',
    id: 'id',
    username: 'username',
    followersCount: 'edge_followed_by.count',
    followingCount: 'edge_follow.count',
    // MUTUALS: how many accounts WE follow also follow this profile — the
    // number behind the header's "Followed by x and N others". A strong
    // follow-back predictor, captured in the same profile-info fetch as the
    // counts (no extra request).
    mutualCount: 'edge_mutual_followed_by.count',
    isPrivate: 'is_private',
    isVerified: 'is_verified',
    // The profile's bio text — the fact behind the prune bio filter.
    biography: 'biography',
    // Whether WE already follow this account. For a private account this is what
    // makes its followers list viewable (we can read followers of anyone we follow).
    followedByViewer: 'followed_by_viewer',
    // Whether we have a PENDING follow request to this (private) account —
    // `followed_by_viewer` is false while the request awaits acceptance.
    requestedByViewer: 'requested_by_viewer',
  },
  friendshipShow: {
    following: 'following',
    followedBy: 'followed_by',
    isPrivate: 'is_private',
    // A follow-REQUEST we sent that a private account has not yet accepted.
    // `following` is FALSE for a pending request, so any consumer that treats
    // "not following" as ground truth MUST also read this flag — otherwise the
    // reconciler destroys every private-account follow request on sight.
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
  // news/inbox — the activity feed the notifications drawer fetches. Follow
  // events live in the story arrays; `story_type` 101 is the long-standing
  // "started following you" type, with the text matcher as a belt-and-braces
  // qualifier (either signal admits an entry, so one drifting doesn't blind us).
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
// DOM contact points (Actor scripts only). Class names rotate — match by
// text/role.
// ---------------------------------------------------------------------------
const SELECTORS = {
  /** The followers/following modal. */
  dialog: '[role="dialog"]',
  /**
   * Re-verified 2026-08-12 against live DOM: the followers/following COUNTS in the
   * profile header are now `<a href="#">` that open the modal via JS — NOT
   * `/<user>/followers/` links (that selector can never match). So the followers
   * control is located by TEXT: an anchor/button whose text names "followers"
   * (and NOT "following"; note `\bfollowers?\b` does not match "following").
   */
  followersStatText: /\bfollowers?\b/i,
  followingStatText: /\bfollowing\b/i,
  /**
   * Profile action button. Live capture (2026-08-12) confirms it renders inside a
   * semantic `<header>` on current Instagram, so this stays the PRIMARY anchor.
   * Its textContent LEADS with the state word but may include icon alt text
   * (observed: "FollowingDown chevron icon"), so match the leading word only.
   */
  profileActionButtonRole: 'header button, header [role="button"]',
  followText: /^\s*follow(\s|$)/i,
  followingText: /^\s*following/i,
  requestedText: /^\s*requested/i,
  followBackText: /^\s*follow back/i,
  /**
   * The confirm control in the unfollow / cancel-request dialog. PREFIX match
   * (`\b`, not `$`): the menu item's text can carry a suffix (e.g. "Unfollow
   * @name" or icon alt text) and the exact-match variant went blind to it.
   * Only one menu item leads with either word, so the prefix stays unambiguous.
   */
  unfollowConfirmText: /^\s*(unfollow|cancel request)\b/i,
  /**
   * The left-nav notifications control. It is NOT an href link (clicking
   * toggles the activity drawer in place), so it is located by the accessible
   * name Instagram puts on the bell/heart icon and its nav row.
   */
  notificationsLabelText: /^\s*notifications\s*$/i,
  /** The "Follow requests" entry inside the open notifications drawer. */
  followRequestsEntryText: /^\s*follow requests\b/i,
  /** The per-row accept control in the follow-requests panel. */
  confirmRequestText: /^\s*confirm\s*$/i,
  /** The "Follows" category filter chip inside the notifications drawer. */
  followsFilterText: /^\s*follows\s*$/i,
  /** The drawer's close (X) control, by accessible name. */
  drawerCloseLabelText: /^\s*close\s*$/i,
} as const;

// NOTE (2026-08-14): the old document-wide fallback anchor
// (`main button, …, button, [role="button"]`) was REMOVED deliberately. It
// could match a "Follow" button belonging to a DIFFERENT account (suggestion
// carousels, hover cards) while the header was still hydrating, click it, and
// then "verify" against the same wrong button — writing a ledger row, a state
// transition, and a graph edge for an account that was never followed. The
// verified `<header>` anchor is the only safe scope; when Instagram moves the
// button, the loud `AdapterStaleError` is the designed failure mode.

// Followers-dialog scroll container: class names are unstable, so the scroll
// script locates, within the dialog, the descendant with the greatest
// scrollHeight whose computed overflow-y is auto|scroll and
// scrollHeight > clientHeight. Scrolling it triggers the paginated
// `followers/` API the Reader intercepts.

/**
 * Block / challenge / logged-out signatures (Sentinel). URL checks are the most
 * reliable; text checks are best-effort (no block screen was captured live —
 * refine the first time one is hit). Any non-`ok` match => halt the engine and
 * alert. The login redirect means the session expired (`logged-out`);
 * `/challenge/` and `/accounts/suspended/` are account interstitials
 * (`challenge`).
 */
const URL_BLOCK_SIGNATURES: readonly BlockSignature[] = [
  { pattern: /\/challenge\//i, status: 'challenge' },
  { pattern: /\/accounts\/suspended\//i, status: 'challenge' },
  { pattern: /\/accounts\/login\//i, status: 'logged-out' },
];

const TEXT_BLOCK_SIGNATURES: readonly BlockSignature[] = [
  { pattern: /action blocked/i, status: 'action-blocked' },
  { pattern: /try again later/i, status: 'action-blocked' },
  { pattern: /we restrict certain activity/i, status: 'action-blocked' },
  { pattern: /confirm it['’]s you/i, status: 'action-blocked' },
  { pattern: /your account has been/i, status: 'action-blocked' },
];

// ---------------------------------------------------------------------------
// Identity knowledge
// ---------------------------------------------------------------------------

/** Non-username first path segments that must never be taken as a username. */
const RESERVED_ROUTES: ReadonlySet<string> = new Set([
  'explore', 'reels', 'reel', 'direct', 'stories', 'p', 'tv', 'accounts', 'about',
  'legal', 'privacy', 'terms', 'api', 'directory', 'your_activity', 'emails',
  'session', 'challenge', 'oauth', 'developer', 'ads', 'business', 'help',
]);

const USERNAME_RE = /^[A-Za-z0-9._]+$/;

/** A bare profile path: `/<username>/`. */
const PROFILE_PATH_RE = /^\/([A-Za-z0-9._]+)\/?$/;

/** Avatar alt text: "<username>'s profile picture" (straight or curly quote). */
const AVATAR_ALT_RE = /^([A-Za-z0-9._]+)['’]s profile/;

// ---------------------------------------------------------------------------
// In-page script builders
// ---------------------------------------------------------------------------

/** A RegExp serialized for reconstruction inside the page context. */
const regexLiteral = (r: RegExp): { source: string; flags: string } => ({
  source: r.source,
  flags: r.flags,
});

/**
 * Wrap a fetch of `urlExpr` (a JS expression evaluated in page context) so it
 * ALWAYS resolves to a `FetchEnvelope` — `r.json()` is only called on a JSON
 * 2xx, an HTML/error body yields `{ ok: false, ..., textHead }`, and a network
 * error yields `{ ok: false, status: 0, contentType: '', textHead }`. The
 * private API requires the `x-ig-app-id` header + session credentials.
 */
const envelopeFetchScript = (urlExpr: string): string =>
  `fetch(${urlExpr}, { headers: { 'x-ig-app-id': '${IG_APP_ID}' }, credentials: 'include' })
  .then(function (r) {
    var ct = '';
    try { ct = (r.headers && r.headers.get('content-type')) || ''; } catch (e) { ct = ''; }
    var fail = function (head) {
      return { ok: false, status: r.status, contentType: ct, finalUrl: r.url, textHead: String(head).slice(0, 256) };
    };
    if (r.ok && ct.toLowerCase().indexOf('json') !== -1) {
      return r.json().then(
        function (j) { return { ok: true, status: r.status, contentType: ct, finalUrl: r.url, json: j }; },
        function (err) { return fail(err); }
      );
    }
    return r.text().then(function (t) { return fail(t); }, function (err) { return fail(err); });
  })
  .catch(function (err) { return { ok: false, status: 0, contentType: '', textHead: String(err).slice(0, 256) }; })`;

// In-page script: read the nav profile-avatar link's href (`/<username>/`).
// The profile link is the anchor whose href is a bare profile path AND that
// contains the avatar <img>; prefer ones inside a <nav>/[role=navigation].
const READ_PROFILE_HREF = `(() => {
  const isProfilePath = (h) => /^\\/[A-Za-z0-9._]+\\/$/.test(h || '');
  const scopes = Array.prototype.slice.call(document.querySelectorAll('nav, [role="navigation"]'));
  scopes.push(document.body);
  for (const scope of scopes) {
    const anchors = scope.querySelectorAll('a[href]');
    for (const a of anchors) {
      const h = a.getAttribute('href');
      if (isProfilePath(h) && a.querySelector('img')) return h;
    }
  }
  return null;
})()`;

// In-page script: click the nav profile-avatar link (to navigate to our profile).
const CLICK_PROFILE_LINK = `(() => {
  const isProfilePath = (h) => /^\\/[A-Za-z0-9._]+\\/$/.test(h || '');
  const scopes = Array.prototype.slice.call(document.querySelectorAll('nav, [role="navigation"]'));
  for (const scope of scopes) {
    const anchors = scope.querySelectorAll('a[href]');
    for (const a of anchors) {
      const h = a.getAttribute('href');
      if (isProfilePath(h) && a.querySelector('img')) { a.click(); return true; }
    }
  }
  return false;
})()`;

// In-page script: the avatar's raw alt text ("<username>'s profile picture").
// Extraction happens main-process side via `usernameFromAvatarAlt`.
const READ_AVATAR_ALT = `(() => {
  const img = document.querySelector('img[alt*="profile picture"], img[alt*="profile photo"]');
  return img ? (img.getAttribute('alt') || null) : null;
})()`;

/**
 * Build the in-page script that locates the profile action button by leading
 * text (NEVER by class) and, for `follow`, clicks when it reads Follow /
 * Follow Back. For `unfollow`, clicks when it reads Following and signals that
 * a confirm click is required. Order of tests matters: `Follow Back` and
 * `Following` are checked before the bare `Follow` regex which would also
 * match their leading word.
 */
function findAndActScript(op: 'follow' | 'unfollow'): string {
  const regexes = {
    followBack: regexLiteral(SELECTORS.followBackText),
    following: regexLiteral(SELECTORS.followingText),
    requested: regexLiteral(SELECTORS.requestedText),
    follow: regexLiteral(SELECTORS.followText),
  };
  // A2: search ONLY the verified header anchor. A broader fallback is unsafe:
  // it can match another account's Follow button (suggestion carousels, hover
  // cards) mid-hydration; drift must fail loud, never click the wrong control.
  return `(() => {
  const SEL = ${JSON.stringify(SELECTORS.profileActionButtonRole)};
  const RX = ${JSON.stringify(regexes)};
  const OP = ${JSON.stringify(op)};
  const mk = (o) => new RegExp(o.source, o.flags);
  const followBack = mk(RX.followBack);
  const following = mk(RX.following);
  const requested = mk(RX.requested);
  const follow = mk(RX.follow);
  const norm = (t) => (t || '').replace(/\\s+/g, ' ').trim();
  const search = (sel) => {
    const nodes = Array.from(document.querySelectorAll(sel));
    for (const n of nodes) {
      const t = norm(n.textContent);
      if (!t) continue;
      if (followBack.test(t)) return { btn: n, state: 'follow-back' };
      if (following.test(t)) return { btn: n, state: 'following' };
      if (requested.test(t)) return { btn: n, state: 'requested' };
      if (follow.test(t)) return { btn: n, state: 'follow' };
    }
    return null;
  };
  const hit = search(SEL);
  if (!hit) return { found: false };
  const btn = hit.btn;
  const state = hit.state;
  let clicked = false;
  let needsConfirm = false;
  if (OP === 'follow') {
    if (state === 'follow' || state === 'follow-back') { btn.click(); clicked = true; }
  } else {
    if (state === 'following') { btn.click(); clicked = true; needsConfirm = true; }
    else if (state === 'requested') { btn.click(); clicked = true; needsConfirm = true; }
  }
  return { found: true, state: state, clicked: clicked, needsConfirm: needsConfirm };
})()`;
}

/**
 * In-page probe: read the profile action button's current leading state,
 * searching the primary anchor first then the fallback (never by class). Used
 * by the Actor's post-click verification (A3).
 */
function probeStateScript(): string {
  const regexes = {
    followBack: regexLiteral(SELECTORS.followBackText),
    following: regexLiteral(SELECTORS.followingText),
    requested: regexLiteral(SELECTORS.requestedText),
    follow: regexLiteral(SELECTORS.followText),
  };
  return `(() => { /* actor:probe-state */
  const SEL = ${JSON.stringify(SELECTORS.profileActionButtonRole)};
  const RX = ${JSON.stringify(regexes)};
  const mk = (o) => new RegExp(o.source, o.flags);
  const followBack = mk(RX.followBack);
  const following = mk(RX.following);
  const requested = mk(RX.requested);
  const follow = mk(RX.follow);
  const norm = (t) => (t || '').replace(/\\s+/g, ' ').trim();
  const search = (sel) => {
    const nodes = Array.from(document.querySelectorAll(sel));
    for (const n of nodes) {
      const t = norm(n.textContent);
      if (!t) continue;
      if (followBack.test(t)) return 'follow-back';
      if (following.test(t)) return 'following';
      if (requested.test(t)) return 'requested';
      if (follow.test(t)) return 'follow';
    }
    return null;
  };
  const state = search(SEL);
  if (!state) return { found: false, state: 'unknown' };
  return { found: true, state: state };
})()`;
}

/** In-page script: click the confirm control in the unfollow menu/dialog. */
function confirmUnfollowScript(): string {
  const rx = regexLiteral(SELECTORS.unfollowConfirmText);
  return `(() => {
  const RX = ${JSON.stringify(rx)};
  const rx = new RegExp(RX.source, RX.flags);
  const norm = (t) => (t || '').replace(/\\s+/g, ' ').trim();
  // ALL dialog-ish scopes, not just the first [role=dialog]: the unfollow menu
  // can mount as a second dialog behind another overlay, and scoping to the
  // first one went blind to it. Document is the final fallback.
  const scopes = Array.prototype.slice.call(
    document.querySelectorAll('[role="dialog"], [role="alertdialog"]'),
  );
  scopes.push(document);
  for (const scope of scopes) {
    const nodes = Array.from(scope.querySelectorAll('button, [role="button"], [role="menuitem"]'));
    for (const n of nodes) {
      if (rx.test(norm(n.textContent))) { n.click(); return { confirmed: true }; }
    }
  }
  return { confirmed: false };
})()`;
}

/**
 * In-page script: click the followers-count control that opens the modal.
 *
 * On current Instagram the followers stat is an `<a href="#">` opened via JS
 * (not `/<user>/followers/`), so we locate it by TEXT — the anchor/button whose
 * text names "followers" (and not "following") — searching the profile header
 * first, then main, then the body. We click the nearest clickable ancestor.
 */
function clickFollowersStatScript(): string {
  const followers = regexLiteral(SELECTORS.followersStatText);
  const following = regexLiteral(SELECTORS.followingStatText);
  return `(() => {
  const RXF = ${JSON.stringify(followers)};
  const RXG = ${JSON.stringify(following)};
  const followers = new RegExp(RXF.source, RXF.flags);
  const following = new RegExp(RXG.source, RXG.flags);
  const norm = (t) => (t || '').replace(/\\s+/g, ' ').trim();
  const isFollowers = (t) => followers.test(t) && !following.test(t);
  const clickableOf = (el) => el.closest('a, button, [role="button"], [role="link"]') || el;
  const scopes = [document.querySelector('header'), document.querySelector('main'), document.body].filter(Boolean);
  for (const scope of scopes) {
    const cands = scope.querySelectorAll('a, [role="link"], [role="button"], button');
    for (const el of cands) {
      if (isFollowers(norm(el.textContent))) { clickableOf(el).click(); return { clicked: true }; }
    }
  }
  return { clicked: false };
})()`;
}

/**
 * In-page script: click the following-count control that opens the modal.
 *
 * The FOLLOWING stat is the sibling of the followers stat in the profile header
 * (verified 2026-08-12: both are `<a href="#">` opened via JS), so this mirrors
 * {@link clickFollowersStatScript} with the text tests swapped: the anchor/button
 * whose text names "following" (and not "followers").
 */
function clickFollowingStatScript(): string {
  const followers = regexLiteral(SELECTORS.followersStatText);
  const following = regexLiteral(SELECTORS.followingStatText);
  return `(() => {
  const RXF = ${JSON.stringify(followers)};
  const RXG = ${JSON.stringify(following)};
  const followers = new RegExp(RXF.source, RXF.flags);
  const following = new RegExp(RXG.source, RXG.flags);
  const norm = (t) => (t || '').replace(/\\s+/g, ' ').trim();
  const isFollowing = (t) => following.test(t) && !followers.test(t);
  const clickableOf = (el) => el.closest('a, button, [role="button"], [role="link"]') || el;
  const scopes = [document.querySelector('header'), document.querySelector('main'), document.body].filter(Boolean);
  for (const scope of scopes) {
    const cands = scope.querySelectorAll('a, [role="link"], [role="button"], button');
    for (const el of cands) {
      if (isFollowing(norm(el.textContent))) { clickableOf(el).click(); return { clicked: true }; }
    }
  }
  return { clicked: false };
})()`;
}

/**
 * In-page script implementing the scroll-container heuristic: within the
 * dialog, find the descendant with the greatest scrollHeight whose computed
 * overflow-y is auto|scroll and scrollHeight > clientHeight, then scroll it to
 * the bottom to trigger pagination.
 */
function scrollFollowersScript(): string {
  return `(() => {
  const dialog = document.querySelector(${JSON.stringify(SELECTORS.dialog)});
  if (!dialog) return { found: false };
  const nodes = Array.from(dialog.querySelectorAll('*'));
  let best = null;
  let bestH = 0;
  for (const el of nodes) {
    const style = window.getComputedStyle(el);
    const oy = style.overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) {
      if (el.scrollHeight > bestH) { bestH = el.scrollHeight; best = el; }
    }
  }
  if (!best) return { found: false };
  best.scrollTop = best.scrollHeight;
  return { found: true, scrollHeight: best.scrollHeight, scrollTop: best.scrollTop };
})()`;
}

// ---------------------------------------------------------------------------
// Interactor LOCATE scripts (additive, 2026-08-13). Each performs the SAME
// element search as its click-script counterpart above but returns the
// target's viewport bounding rect (getBoundingClientRect) WITHOUT clicking —
// the Interactor then clicks/scrolls with native input events. The click
// scripts above are untouched and remain the no-interactor fallback. Marker
// comments (`actor:locate-*`) identify each script to test fakes.
// ---------------------------------------------------------------------------

/** Serialize a bounding rect for the structured-clone trip back. */
const RECT_JS = `(el) => { const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height }; }`;

/**
 * Locate-only variant of {@link findAndActScript}: same primary→fallback
 * search and the same would-click decision table, but NO click — the rect and
 * decision come back for the Interactor to act on.
 */
function locateActionButtonScript(op: 'follow' | 'unfollow'): string {
  const regexes = {
    followBack: regexLiteral(SELECTORS.followBackText),
    following: regexLiteral(SELECTORS.followingText),
    requested: regexLiteral(SELECTORS.requestedText),
    follow: regexLiteral(SELECTORS.followText),
  };
  return `(() => { /* actor:locate-action */
  const SEL = ${JSON.stringify(SELECTORS.profileActionButtonRole)};
  const RX = ${JSON.stringify(regexes)};
  const OP = ${JSON.stringify(op)};
  const rectOf = ${RECT_JS};
  const mk = (o) => new RegExp(o.source, o.flags);
  const followBack = mk(RX.followBack);
  const following = mk(RX.following);
  const requested = mk(RX.requested);
  const follow = mk(RX.follow);
  const norm = (t) => (t || '').replace(/\\s+/g, ' ').trim();
  const search = (sel) => {
    const nodes = Array.from(document.querySelectorAll(sel));
    for (const n of nodes) {
      const t = norm(n.textContent);
      if (!t) continue;
      if (followBack.test(t)) return { btn: n, state: 'follow-back' };
      if (following.test(t)) return { btn: n, state: 'following' };
      if (requested.test(t)) return { btn: n, state: 'requested' };
      if (follow.test(t)) return { btn: n, state: 'follow' };
    }
    return null;
  };
  const hit = search(SEL);
  if (!hit) return { found: false };
  const state = hit.state;
  let wouldClick = false;
  let needsConfirm = false;
  if (OP === 'follow') {
    if (state === 'follow' || state === 'follow-back') wouldClick = true;
  } else {
    if (state === 'following') { wouldClick = true; needsConfirm = true; }
    else if (state === 'requested') { wouldClick = true; needsConfirm = true; }
  }
  return { found: true, state: state, wouldClick: wouldClick, needsConfirm: needsConfirm, rect: rectOf(hit.btn) };
})()`;
}

/** Locate-only variant of {@link confirmUnfollowScript}: the confirm control's rect. */
function locateConfirmUnfollowScript(): string {
  const rx = regexLiteral(SELECTORS.unfollowConfirmText);
  return `(() => { /* actor:locate-confirm */
  const RX = ${JSON.stringify(rx)};
  const rx = new RegExp(RX.source, RX.flags);
  const rectOf = ${RECT_JS};
  const norm = (t) => (t || '').replace(/\\s+/g, ' ').trim();
  // ALL dialog-ish scopes (see confirmUnfollowScript) — never just the first.
  const scopes = Array.prototype.slice.call(
    document.querySelectorAll('[role="dialog"], [role="alertdialog"]'),
  );
  scopes.push(document);
  for (const scope of scopes) {
    const nodes = Array.from(scope.querySelectorAll('button, [role="button"], [role="menuitem"]'));
    for (const n of nodes) {
      if (rx.test(norm(n.textContent))) return { found: true, rect: rectOf(n) };
    }
  }
  return { found: false };
})()`;
}

/**
 * Locate-only variant of the stat click scripts: the CLICKABLE ancestor's rect
 * for the followers or following count control (same text tests, same
 * `clickableOf` resolution — the Interactor must press what the JS would click).
 */
function locateStatScript(which: 'followers' | 'following'): string {
  const followers = regexLiteral(SELECTORS.followersStatText);
  const following = regexLiteral(SELECTORS.followingStatText);
  return `(() => { /* actor:locate-stat-${which} */
  const RXF = ${JSON.stringify(followers)};
  const RXG = ${JSON.stringify(following)};
  const WHICH = ${JSON.stringify(which)};
  const rectOf = ${RECT_JS};
  const followers = new RegExp(RXF.source, RXF.flags);
  const following = new RegExp(RXG.source, RXG.flags);
  const norm = (t) => (t || '').replace(/\\s+/g, ' ').trim();
  const wanted = (t) => WHICH === 'followers'
    ? (followers.test(t) && !following.test(t))
    : (following.test(t) && !followers.test(t));
  const clickableOf = (el) => el.closest('a, button, [role="button"], [role="link"]') || el;
  const scopes = [document.querySelector('header'), document.querySelector('main'), document.body].filter(Boolean);
  for (const scope of scopes) {
    const cands = scope.querySelectorAll('a, [role="link"], [role="button"], button');
    for (const el of cands) {
      if (wanted(norm(el.textContent))) return { found: true, rect: rectOf(clickableOf(el)) };
    }
  }
  return { found: false };
})()`;
}

/**
 * Locate-only variant of CLICK_PROFILE_LINK: the same avatar-anchor search
 * (nav scopes first, body fallback like READ_PROFILE_HREF), but it returns the
 * link's viewport rect instead of clicking — the Interactor presses it with native
 * input events (the SPA can ignore a synthetic `a.click()` here).
 */
function locateProfileLinkScript(): string {
  return `(() => { /* actor:locate-profile-link */
  const rectOf = ${RECT_JS};
  const isProfilePath = (h) => /^\\/[A-Za-z0-9._]+\\/$/.test(h || '');
  const scopes = Array.prototype.slice.call(document.querySelectorAll('nav, [role="navigation"]'));
  scopes.push(document.body);
  for (const scope of scopes) {
    if (!scope) continue;
    const anchors = scope.querySelectorAll('a[href]');
    for (const a of anchors) {
      const h = a.getAttribute('href');
      if (isProfilePath(h) && a.querySelector('img')) return { found: true, rect: rectOf(a) };
    }
  }
  return { found: false };
})()`;
}

/**
 * Locate the left-nav NOTIFICATIONS control's rect. The control is not an href
 * link (clicking toggles the activity drawer in place), so it is found by
 * accessible name: an `svg[aria-label]` or `[aria-label]` element whose label
 * says "Notifications", resolved to its clickable ancestor — the element the
 * page itself treats as the button. Nav scopes are searched first so a stray "Notifications"
 * string in page content can never win over the rail.
 */
function locateNotificationsLinkScript(): string {
  const rx = regexLiteral(SELECTORS.notificationsLabelText);
  return `(() => { /* actor:locate-notifications */
  const RX = ${JSON.stringify(rx)};
  const rx = new RegExp(RX.source, RX.flags);
  const rectOf = ${RECT_JS};
  const clickableOf = (el) => el.closest('a, button, [role="button"], [role="link"]') || el.parentElement || el;
  const scopes = Array.prototype.slice.call(document.querySelectorAll('nav, [role="navigation"]'));
  scopes.push(document.body);
  for (const scope of scopes) {
    if (!scope) continue;
    const labeled = scope.querySelectorAll('svg[aria-label], [aria-label]');
    for (const el of labeled) {
      const label = el.getAttribute('aria-label') || '';
      if (rx.test(label)) return { found: true, rect: rectOf(clickableOf(el)) };
    }
  }
  return { found: false };
})()`;
}

/**
 * Locate the "Follow requests" entry inside the OPEN notifications drawer.
 * Text-matched on the smallest element whose own text leads with the label,
 * resolved to its clickable ancestor. Drawer/dialog scopes are searched first
 * so page content can never win; `found: false` when the entry is absent
 * (public account or nothing pending) — a soft skip for the caller.
 */
function locateFollowRequestsEntryScript(): string {
  const rx = regexLiteral(SELECTORS.followRequestsEntryText);
  return `(() => { /* actor:locate-follow-requests */
  const RX = ${JSON.stringify(rx)};
  const rx = new RegExp(RX.source, RX.flags);
  const rectOf = ${RECT_JS};
  const norm = (t) => (t || '').replace(/\\s+/g, ' ').trim();
  const clickableOf = (el) => el.closest('a, button, [role="button"], [role="link"], [role="menuitem"]') || el;
  const scopes = Array.prototype.slice.call(
    document.querySelectorAll('[role="dialog"], [role="alertdialog"], aside'),
  );
  scopes.push(document.body);
  for (const scope of scopes) {
    if (!scope) continue;
    const nodes = scope.querySelectorAll('span, div, a, button, [role="button"]');
    for (const n of nodes) {
      // Smallest matching element: its own text matches but no matching child does
      // (otherwise every ancestor of the label would match first).
      if (!rx.test(norm(n.textContent))) continue;
      let smallest = true;
      for (const c of n.children) {
        if (rx.test(norm(c.textContent))) { smallest = false; break; }
      }
      if (smallest) return { found: true, rect: rectOf(clickableOf(n)) };
    }
  }
  return { found: false };
})()`;
}

/**
 * Locate the "Follows" category filter chip inside the open notifications
 * drawer (exact text, smallest element, drawer scopes first) — clicking it
 * narrows the feed to follow events. Soft: absent on layouts without filters.
 */
function locateNotificationsFollowsFilterScript(): string {
  const rx = regexLiteral(SELECTORS.followsFilterText);
  return `(() => { /* actor:locate-follows-filter */
  const RX = ${JSON.stringify(rx)};
  const rx = new RegExp(RX.source, RX.flags);
  const rectOf = ${RECT_JS};
  const norm = (t) => (t || '').replace(/\\s+/g, ' ').trim();
  const clickableOf = (el) => el.closest('a, button, [role="button"], [role="tab"], [role="link"]') || el;
  const scopes = Array.prototype.slice.call(
    document.querySelectorAll('[role="dialog"], [role="alertdialog"], aside'),
  );
  scopes.push(document.body);
  for (const scope of scopes) {
    if (!scope) continue;
    const nodes = scope.querySelectorAll('span, div, button, [role="button"], [role="tab"]');
    for (const n of nodes) {
      if (!rx.test(norm(n.textContent))) continue;
      let smallest = true;
      for (const c of n.children) {
        if (rx.test(norm(c.textContent))) { smallest = false; break; }
      }
      if (smallest) return { found: true, rect: rectOf(clickableOf(n)) };
    }
  }
  return { found: false };
})()`;
}

/**
 * Locate the notifications drawer's CLOSE (X) control by accessible name —
 * pressing it is the supported way to leave the drawer so the tab is genuinely
 * neutral for whatever acts next. Soft: the caller falls back to toggling the
 * bell when no close control exists.
 */
function locateNotificationsCloseScript(): string {
  const rx = regexLiteral(SELECTORS.drawerCloseLabelText);
  return `(() => { /* actor:locate-drawer-close */
  const RX = ${JSON.stringify(rx)};
  const rx = new RegExp(RX.source, RX.flags);
  const rectOf = ${RECT_JS};
  const clickableOf = (el) => el.closest('a, button, [role="button"]') || el.parentElement || el;
  const scopes = Array.prototype.slice.call(
    document.querySelectorAll('[role="dialog"], [role="alertdialog"], aside'),
  );
  scopes.push(document.body);
  for (const scope of scopes) {
    if (!scope) continue;
    const labeled = scope.querySelectorAll('svg[aria-label], [aria-label]');
    for (const el of labeled) {
      const label = el.getAttribute('aria-label') || '';
      if (rx.test(label)) return { found: true, rect: rectOf(clickableOf(el)) };
    }
  }
  return { found: false };
})()`;
}

/**
 * Locate the notifications drawer's scroll container (largest scrollable
 * descendant of the drawer scope) + metrics — the caller wheel-scrolls it to
 * load older notification pages. `found: false` when the list fits.
 */
function locateNotificationsScrollScript(): string {
  return `(() => { /* actor:locate-notifications-scroll */
  const rectOf = ${RECT_JS};
  const scopes = Array.prototype.slice.call(
    document.querySelectorAll('[role="dialog"], [role="alertdialog"], aside'),
  );
  for (const scope of scopes) {
    if (!scope) continue;
    const nodes = Array.from(scope.querySelectorAll('*'));
    let best = null;
    let bestH = 0;
    for (const el of nodes) {
      const style = window.getComputedStyle(el);
      const oy = style.overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) {
        if (el.scrollHeight > bestH) { bestH = el.scrollHeight; best = el; }
      }
    }
    if (best) {
      return {
        found: true,
        rect: rectOf(best),
        scrollTop: best.scrollTop,
        scrollHeight: best.scrollHeight,
        clientHeight: best.clientHeight,
      };
    }
  }
  return { found: false };
})()`;
}

/**
 * Locate the FIRST "Confirm" control in the open follow-requests panel, plus
 * the username of the row it belongs to (nearest ancestor containing a
 * profile-path link) and how many Confirm controls remain — the caller uses
 * the username/count to verify each accept made progress.
 */
function locateConfirmFollowRequestScript(): string {
  const rx = regexLiteral(SELECTORS.confirmRequestText);
  return `(() => { /* actor:locate-confirm-request */
  const RX = ${JSON.stringify(rx)};
  const rx = new RegExp(RX.source, RX.flags);
  const rectOf = ${RECT_JS};
  const norm = (t) => (t || '').replace(/\\s+/g, ' ').trim();
  const isProfilePath = (h) => /^\\/[A-Za-z0-9._]+\\/?$/.test(h || '');
  const scopes = Array.prototype.slice.call(
    document.querySelectorAll('[role="dialog"], [role="alertdialog"], aside'),
  );
  scopes.push(document.body);
  for (const scope of scopes) {
    if (!scope) continue;
    const buttons = Array.prototype.filter.call(
      scope.querySelectorAll('button, [role="button"]'),
      (b) => rx.test(norm(b.textContent)),
    );
    if (buttons.length === 0) continue;
    const btn = buttons[0];
    // The row's username: walk up until an ancestor holds a profile link.
    let username = null;
    let node = btn.parentElement;
    for (let depth = 0; node && depth < 8 && username === null; depth++, node = node.parentElement) {
      const anchors = node.querySelectorAll('a[href]');
      for (const a of anchors) {
        const h = a.getAttribute('href');
        if (isProfilePath(h)) { username = h.replace(/\\//g, ''); break; }
      }
    }
    return { found: true, rect: rectOf(btn), username: username, remaining: buttons.length };
  }
  return { found: false };
})()`;
}

/**
 * Locate-only variant of {@link scrollFollowersScript}: the same
 * largest-scrollable-descendant heuristic, but it reports the container's rect
 * and scroll metrics instead of jumping `scrollTop` — the Interactor then
 * scrolls it with real wheel events.
 */
function locateScrollContainerScript(): string {
  return `(() => { /* actor:locate-scroll */
  const rectOf = ${RECT_JS};
  const dialog = document.querySelector(${JSON.stringify(SELECTORS.dialog)});
  if (!dialog) return { found: false };
  const nodes = Array.from(dialog.querySelectorAll('*'));
  let best = null;
  let bestH = 0;
  for (const el of nodes) {
    const style = window.getComputedStyle(el);
    const oy = style.overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) {
      if (el.scrollHeight > bestH) { bestH = el.scrollHeight; best = el; }
    }
  }
  if (!best) return { found: false };

  // Hover-safe rest point: a spot inside the container that is NOT over a
  // username link, avatar image, or follow button — so a wheel there scrolls
  // the list instead of opening Instagram's hover-preview card (which overlays
  // the row and eats the wheel). Probe elementFromPoint across the container's
  // left/right gutters and mid columns at several row heights; the gutters
  // (row background, no interactive child) are the most reliable and tried
  // first. Absent when nothing safe is found (a dense list) — the caller then
  // uses its default entry point.
  const r = best.getBoundingClientRect();
  const INTERACTIVE = 'a, button, [role="button"], img, canvas, video, [role="link"]';
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const vh = window.innerHeight || document.documentElement.clientHeight || r.bottom;
  const topV = clamp(r.top, 0, vh);
  const botV = clamp(r.bottom, 0, vh);
  const isSafe = (x, y) => {
    const el = document.elementFromPoint(Math.round(x), Math.round(y));
    if (!el) return false;
    if (el !== best && !best.contains(el)) return false; // outside the scroller
    return !el.closest(INTERACTIVE);
  };
  // Gutters first (left padding, then right — inset past the ~15px scrollbar),
  // then interior columns as a fallback.
  const xs = [r.left + 6, r.left + 14, r.right - 26, r.right - 18,
              r.left + r.width * 0.5, r.left + r.width * 0.34, r.left + r.width * 0.66];
  const yFracs = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74];
  let safe = null;
  for (let yi = 0; yi < yFracs.length && !safe; yi++) {
    const y = topV + (botV - topV) * yFracs[yi];
    for (let xi = 0; xi < xs.length; xi++) {
      if (isSafe(xs[xi], y)) { safe = { x: xs[xi], y: y }; break; }
    }
  }

  const out = {
    found: true,
    rect: rectOf(best),
    scrollTop: best.scrollTop,
    scrollHeight: best.scrollHeight,
    clientHeight: best.clientHeight,
  };
  if (safe) out.safePoint = safe;
  return out;
})()`;
}

// ---------------------------------------------------------------------------
// Response extractors
// ---------------------------------------------------------------------------

function extractFollowersList(
  body: unknown,
  at: number,
  source: 'followers-list' | 'following-list' | 'friend-requests' = 'followers-list',
): FollowersListResult | ShapeMismatch {
  const empty: FollowersListResult = { observations: [], cursor: null, hasMore: false };
  if (!isRecord(body)) return empty;

  const p = JSON_PATHS.followersList;
  const users = getPath(body, p.users);
  if (!Array.isArray(users)) return SHAPE_MISMATCH;

  const observations: Observation[] = [];
  for (const entry of users) {
    if (!isRecord(entry)) continue;
    const pk = asStringId(entry[p.userPk]);
    if (pk === null) continue;
    observations.push({
      accountPk: pk,
      observedAt: at,
      source,
      fields: {
        username: typeof entry[p.userName] === 'string'
          ? (entry[p.userName] as string)
          : undefined,
        isPrivate: asBool(entry[p.isPrivate]),
        isVerified: asBool(entry[p.isVerified]),
      },
    });
  }

  const nextMaxId = getPath(body, p.nextMaxId);
  const cursor = typeof nextMaxId === 'string' && nextMaxId.length > 0
    ? nextMaxId
    : null;
  // More-pages detection must be resilient to which flag this response carries:
  // `has_more`, the alternate `big_list`, or neither — a present pagination
  // cursor ALWAYS means another page exists. A false negative here ends the
  // scroll loop after one page and silently truncates a whole-list scan.
  const hasMore =
    getPath(body, p.hasMore) === true || getPath(body, p.bigList) === true || cursor !== null;
  return { observations, cursor, hasMore };
}

function extractProfileInfo(body: unknown, at: number): Observation | null | ShapeMismatch {
  if (!isRecord(body)) return null;

  const p = JSON_PATHS.webProfileInfo;
  const user = getPath(body, p.user);
  if (!isRecord(user)) {
    // Distinguish "genuinely no user" from "unexpected shape": a body whose
    // `data` container exists with an empty/null user is Instagram saying the
    // profile is gone; anything else (a `{status:'fail'}` soft-block body,
    // shape drift) must surface as SHAPE_MISMATCH so consumers never treat a
    // transient wall as proof of a deleted account.
    const data = (body as Record<string, unknown>).data;
    return isRecord(data) ? null : SHAPE_MISMATCH;
  }

  const pk = asStringId(user[p.id]);
  if (pk === null) return SHAPE_MISMATCH;

  return {
    accountPk: pk,
    observedAt: at,
    source: 'profile',
    fields: {
      username: typeof user[p.username] === 'string'
        ? (user[p.username] as string)
        : undefined,
      followers: asCount(getPath(user, p.followersCount)),
      following: asCount(getPath(user, p.followingCount)),
      mutuals: asCount(getPath(user, p.mutualCount)),
      isPrivate: asBool(user[p.isPrivate]),
      isVerified: asBool(user[p.isVerified]),
      bio: typeof user[p.biography] === 'string' ? (user[p.biography] as string) : undefined,
    },
  };
}

function extractProfileFollowedByViewer(body: unknown): boolean | null {
  if (!isRecord(body)) return null;
  const p = JSON_PATHS.webProfileInfo;
  const user = getPath(body, p.user);
  if (!isRecord(user)) return null;
  const v = user[p.followedByViewer];
  return typeof v === 'boolean' ? v : null;
}

function extractProfileRequestedByViewer(body: unknown): boolean | null {
  if (!isRecord(body)) return null;
  const p = JSON_PATHS.webProfileInfo;
  const user = getPath(body, p.user);
  if (!isRecord(user)) return null;
  const v = user[p.requestedByViewer];
  return typeof v === 'boolean' ? v : null;
}

function extractShowMany(body: unknown): ShowManyEntry[] | ShapeMismatch {
  if (!isRecord(body)) return [];

  const p = JSON_PATHS.showMany;
  const statuses = getPath(body, p.statuses);
  if (!isRecord(statuses)) return SHAPE_MISMATCH;

  const out: ShowManyEntry[] = [];
  for (const [pk, status] of Object.entries(statuses)) {
    if (!isRecord(status)) continue;
    out.push({
      pk,
      following: status[p.following] === true,
      // A pending request to a private account: `following` is false but the
      // relationship is OURS — consumers must not read it as "not following".
      outgoingRequest: status[p.outgoingRequest] === true,
      isPrivate: asBool(status[p.isPrivate]),
    });
  }
  return out;
}

function extractFriendshipShow(body: unknown, pk: string): FriendshipShowResult | ShapeMismatch {
  if (!isRecord(body)) return SHAPE_MISMATCH;
  const p = JSON_PATHS.friendshipShow;
  // Guard on the expected keys, not merely "is it an object": an error body
  // (e.g. {"status":"fail"}) would otherwise parse cleanly to all-false — a
  // FALSE "we do not follow them" fact that flows into the reconciler and
  // terminates held records. The interface contract demands SHAPE_MISMATCH so
  // "no relationship" and "unparsed" stay distinguishable.
  if (typeof body[p.following] !== 'boolean' && typeof body[p.followedBy] !== 'boolean') {
    return SHAPE_MISMATCH;
  }
  return {
    pk,
    following: body[p.following] === true,
    followedBy: body[p.followedBy] === true,
    outgoingRequest: body[p.outgoingRequest] === true,
    isPrivate: asBool(body[p.isPrivate]),
  };
}

function extractCurrentUsername(body: unknown): string | null {
  const username = getPath(body, JSON_PATHS.currentUser.username);
  return typeof username === 'string' && username.length > 0 ? username : null;
}

/**
 * Parse the news-inbox (activity feed) body into "started following you"
 * events. An entry qualifies through EITHER signal — the numeric follow
 * `story_type` or the text matcher — so a drift in one doesn't blind the
 * follow-back watcher. `SHAPE_MISMATCH` when the body carries NONE of the
 * expected story containers (drift / error body); empty sections are a valid
 * "no recent follows" result.
 */
function extractActivityFeed(body: unknown): FollowEvent[] | ShapeMismatch {
  if (!isRecord(body)) return SHAPE_MISMATCH;
  const p = JSON_PATHS.activityFeed;

  const sections = p.storySections
    .map((key) => body[key])
    .filter((section): section is unknown[] => Array.isArray(section));
  if (sections.length === 0) return SHAPE_MISMATCH;

  const out: FollowEvent[] = [];
  for (const section of sections) {
    for (const entry of section) {
      if (!isRecord(entry)) continue;
      const args = entry[p.args];
      if (!isRecord(args)) continue;
      const text = args[p.text];
      const isFollow =
        entry[p.storyType] === p.followStoryType ||
        (typeof text === 'string' && p.followText.test(text));
      if (!isFollow) continue;
      const pk = asStringId(args[p.profileId]);
      if (pk === null) continue;
      const name = args[p.profileName];
      const ts = asCount(args[p.timestamp]);
      out.push({
        pk,
        username: typeof name === 'string' && name.length > 0 ? name : null,
        atMs: ts !== undefined ? Math.round(ts * 1000) : null,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// URL / DOM utilities
// ---------------------------------------------------------------------------

function usernameFromProfileUrl(url: string): string | null {
  let path = url;
  try {
    path = new URL(url, `${IG_ORIGIN}/`).pathname;
  } catch {
    // treat `url` as already a path
  }
  const m = path.match(PROFILE_PATH_RE);
  if (!m) return null;
  const candidate = m[1];
  if (!USERNAME_RE.test(candidate) || RESERVED_ROUTES.has(candidate.toLowerCase())) return null;
  return candidate;
}

function usernameFromAvatarAlt(alt: string): string | null {
  const m = alt.match(AVATAR_ALT_RE);
  return m ? m[1] : null;
}

const STALE_LABELS: Record<StaleComponent, string> = {
  'action-button': SELECTORS.profileActionButtonRole,
  'unfollow-confirm': String(SELECTORS.unfollowConfirmText),
  'followers-stat': String(SELECTORS.followersStatText),
  'following-stat': String(SELECTORS.followingStatText),
  'notifications-link': String(SELECTORS.notificationsLabelText),
  dialog: SELECTORS.dialog,
};

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

export const SURFACE_2026_08_12: IgSurface = {
  version: VERSION,
  capturedAt: VERSION,

  matchEndpoint(url: string): EndpointKind | null {
    for (const entry of ENDPOINT_TABLE) {
      if (entry.pattern.test(url)) return entry.kind;
    }
    return null;
  },

  extractIds(kind: EndpointKind, url: string): EndpointIds {
    const entry = ENDPOINT_TABLE.find((e) => e.kind === kind);
    if (!entry?.ids) return {};
    const out: EndpointIds = {};
    if (entry.ids.pk) {
      const m = entry.ids.pk.exec(url);
      if (m) out.pk = m[1];
    }
    if (entry.ids.targetPk) {
      const m = entry.ids.targetPk.exec(url);
      if (m) out.targetPk = m[1];
    }
    return out;
  },

  extractFollowersList,
  extractProfileRequestedByViewer,
  extractProfileInfo,
  extractProfileFollowedByViewer,
  extractShowMany,
  extractFriendshipShow,
  extractCurrentUsername,
  extractActivityFeed,

  profileInfoScript: (username: string): string =>
    envelopeFetchScript(
      `'/api/v1/users/web_profile_info/?username=' + encodeURIComponent(${JSON.stringify(username)})`,
    ),
  currentUserScript: (): string =>
    envelopeFetchScript(`'/api/v1/accounts/current_user/'`),
  friendshipShowScript: (pk: string): string =>
    envelopeFetchScript(
      `'/api/v1/friendships/show/' + encodeURIComponent(${JSON.stringify(pk)}) + '/'`,
    ),
  listPageScript: (pk: string, which: 'followers' | 'following', maxId: string | null): string =>
    envelopeFetchScript(
      `'/api/v1/friendships/' + encodeURIComponent(${JSON.stringify(pk)}) + '/${which}/?count=${LIST_PAGE_COUNT}'` +
        (maxId === null
          ? ''
          : ` + '&max_id=' + encodeURIComponent(${JSON.stringify(maxId)})`),
    ),
  // The friendships list `max_id` is a ROW OFFSET (verified live: pages hand
  // back "50", "100", …), so the window just past everything received starts
  // at the number of rows fetched. Used to verify an end-of-list claim that
  // arrived WITHOUT a resume cursor. Failure mode is safe either way: if a
  // future capture makes cursors opaque, IG ignores the bogus offset and
  // returns head rows — all duplicates — which still reads as "nothing new
  // past the end" (a confirmation, never a false continuation).
  listEndProbeCursor: (rowsFetched: number): string => String(rowsFetched),

  // Sentinel text probe. NOT the whole body: during actions the tab sits on a
  // CANDIDATE's profile, whose bio/captions/comments are stranger-controlled
  // text — a bio containing "try again later" would otherwise permanently halt
  // the engine. Block interstitials render as dialogs/alerts or headline the
  // page, so the probe reads only dialog/alert containers and top headings.
  bodyTextProbeScript: (): string =>
    `(() => {
  const parts = [];
  const push = (el) => { if (el && el.innerText) parts.push(el.innerText); };
  for (const el of document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="alert"]')) push(el);
  for (const el of document.querySelectorAll('h1, h2')) push(el);
  return parts.join('\\n');
})()`,

  findAndActScript,
  probeStateScript,
  confirmUnfollowScript,
  clickFollowersStatScript,
  clickFollowingStatScript,
  dialogPresentScript: (): string =>
    `(() => ({ present: !!document.querySelector(${JSON.stringify(SELECTORS.dialog)}) }))()`,
  scrollFollowersScript,

  locateActionButtonScript,
  locateConfirmUnfollowScript,
  locateFollowersStatScript: (): string => locateStatScript('followers'),
  locateFollowingStatScript: (): string => locateStatScript('following'),
  locateProfileLinkScript,
  locateNotificationsLinkScript,
  locateNotificationsFollowsFilterScript,
  locateNotificationsCloseScript,
  locateNotificationsScrollScript,
  locateFollowRequestsEntryScript,
  locateConfirmFollowRequestScript,
  locateScrollContainerScript,

  readProfileHrefScript: (): string => READ_PROFILE_HREF,
  clickProfileLinkScript: (): string => CLICK_PROFILE_LINK,
  readAvatarAltScript: (): string => READ_AVATAR_ALT,

  profileUrl: (username: string): string => `${IG_ORIGIN}/${username}/`,
  staleSelectorLabel: (component: StaleComponent): string => STALE_LABELS[component],
  usernameFromAvatarAlt,
  usernameFromProfileUrl,
  reservedRoutes: RESERVED_ROUTES,
  usernameRegex: USERNAME_RE,
  profilePathRegex: PROFILE_PATH_RE,

  blockSignatures: URL_BLOCK_SIGNATURES,
  textSignatures: TEXT_BLOCK_SIGNATURES,

  appId: IG_APP_ID,
  origin: IG_ORIGIN,
  userAgent: IG_USER_AGENT,
  showManyMaxBatch: SHOW_MANY_MAX_BATCH,
};

// ---------------------------------------------------------------------------
// Capture-harness extras (src/capture) — broader, URL-substring heuristics the
// live capture harness uses BEFORE bodies exist. Kept here so the harness owns
// no Instagram literals of its own.
// ---------------------------------------------------------------------------
export const CAPTURE_PATTERNS = {
  /** POST /graphql/query and friends — many shapes; profile/timeline queries land here. */
  graphql: '/graphql',
  /** Broad REST followers heuristic parts (any friendships URL naming followers). */
  friendshipsFragment: 'friendships/',
  followersFragment: 'followers',
  /** GraphQL queries that mention followers (singular matches plural too). */
  followerWord: 'follower',
  /** Any per-user REST endpoint (e.g. /api/v1/users/<pk>/info/). */
  usersApi: '/api/v1/users/',
  /** URL fragments that mark an Instagram JSON API response worth capturing. */
  apiMarkers: ['/api/v1/', '/graphql', 'web_profile_info', 'friendships', 'news/inbox'],
} as const;

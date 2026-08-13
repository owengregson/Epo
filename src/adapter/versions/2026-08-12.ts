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
  FollowersListResult,
  FriendshipShowResult,
  IgSurface,
  ShowManyEntry,
  StaleComponent,
} from '@/adapter/ig-surface';
import {
  SHAPE_MISMATCH,
  type ShapeMismatch,
  asBool,
  asCount,
  asStringId,
  getPath,
  isRecord,
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
//                     edge_follow:      { count } } } }  // FOLLOWING count
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
  },
  webProfileInfo: {
    user: 'data.user',
    id: 'id',
    username: 'username',
    followersCount: 'edge_followed_by.count',
    followingCount: 'edge_follow.count',
    isPrivate: 'is_private',
    isVerified: 'is_verified',
    // Whether WE already follow this account. For a private account this is what
    // makes its followers list viewable (we can read followers of anyone we follow).
    followedByViewer: 'followed_by_viewer',
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
  currentUser: {
    username: 'user.username',
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
  /**
   * Defensive fallback anchor used only when the primary yields no state-text
   * match — tolerates a future layout change that moves the button out of the
   * `<header>` without breaking the verified path. Still matched by TEXT, never
   * by class; the first state-matching button in document order wins.
   */
  profileActionButtonRoleFallback:
    'main button, main [role="button"], button, [role="button"]',
  followText: /^\s*follow(\s|$)/i,
  followingText: /^\s*following/i,
  requestedText: /^\s*requested/i,
  followBackText: /^\s*follow back/i,
  /** The confirm control in the unfollow dialog — exact text "Unfollow". */
  unfollowConfirmText: /^\s*unfollow\s*$/i,
} as const;

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
  // A2: search the verified primary anchor first; only if it yields no
  // state-text match, fall back to the broader selector and take the FIRST
  // state-matching button in document order. Never matched by class.
  return `(() => {
  const SEL = ${JSON.stringify(SELECTORS.profileActionButtonRole)};
  const SEL2 = ${JSON.stringify(SELECTORS.profileActionButtonRoleFallback)};
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
  let hit = search(SEL);
  if (!hit) hit = search(SEL2);
  if (!hit) return { found: false };
  const btn = hit.btn;
  const state = hit.state;
  let clicked = false;
  let needsConfirm = false;
  if (OP === 'follow') {
    if (state === 'follow' || state === 'follow-back') { btn.click(); clicked = true; }
  } else {
    if (state === 'following') { btn.click(); clicked = true; needsConfirm = true; }
    else if (state === 'requested') { btn.click(); clicked = true; }
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
  const SEL2 = ${JSON.stringify(SELECTORS.profileActionButtonRoleFallback)};
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
  let state = search(SEL);
  if (!state) state = search(SEL2);
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
  const dialog = document.querySelector(${JSON.stringify(SELECTORS.dialog)});
  const scope = dialog || document;
  const nodes = Array.from(scope.querySelectorAll('button, [role="button"], [role="menuitem"]'));
  for (const n of nodes) {
    if (rx.test(norm(n.textContent))) { n.click(); return { confirmed: true }; }
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
// Response extractors
// ---------------------------------------------------------------------------

function extractFollowersList(body: unknown, at: number): FollowersListResult | ShapeMismatch {
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
      source: 'followers-list',
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
  return { observations, cursor, hasMore: getPath(body, p.hasMore) === true };
}

function extractProfileInfo(body: unknown, at: number): Observation | null | ShapeMismatch {
  if (!isRecord(body)) return null;

  const p = JSON_PATHS.webProfileInfo;
  const user = getPath(body, p.user);
  if (!isRecord(user)) return null;

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
      isPrivate: asBool(user[p.isPrivate]),
      isVerified: asBool(user[p.isVerified]),
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
      isPrivate: asBool(status[p.isPrivate]),
    });
  }
  return out;
}

function extractFriendshipShow(body: unknown, pk: string): FriendshipShowResult | ShapeMismatch {
  if (!isRecord(body)) return SHAPE_MISMATCH;
  const p = JSON_PATHS.friendshipShow;
  return {
    pk,
    following: body[p.following] === true,
    followedBy: body[p.followedBy] === true,
    isPrivate: asBool(body[p.isPrivate]),
  };
}

function extractCurrentUsername(body: unknown): string | null {
  const username = getPath(body, JSON_PATHS.currentUser.username);
  return typeof username === 'string' && username.length > 0 ? username : null;
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
  extractProfileInfo,
  extractProfileFollowedByViewer,
  extractShowMany,
  extractFriendshipShow,
  extractCurrentUsername,

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

  bodyTextProbeScript: (): string =>
    `(() => (document.body ? document.body.innerText : ''))()`,

  findAndActScript,
  probeStateScript,
  confirmUnfollowScript,
  clickFollowersStatScript,
  clickFollowingStatScript,
  dialogPresentScript: (): string =>
    `(() => ({ present: !!document.querySelector(${JSON.stringify(SELECTORS.dialog)}) }))()`,
  scrollFollowersScript,

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

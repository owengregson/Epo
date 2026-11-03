/**
 * Instagram literals of this capture: the DOM contact points (selectors, roles,
 * scopes) and the identity regexes. Re-exported by `literals.ts`.
 */

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
  /**
   * A profile that does not exist (or is hidden from us): a `<span>` in `main`,
   * and the page's client fetches no profile (live 2026-10-08).
   */
  profileUnavailableText: /^\s*sorry, this page isn['’]t available/i,
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

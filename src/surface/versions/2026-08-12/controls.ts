/**
 * The Instagram surface's CONTROLS — capture 2026-08-12.
 *
 * Every control the Actor drives, as a descriptor the page bundle's `locate()`
 * interprets (`src/adapter/page/locate.ts`). Split out of `./surface.ts`
 * (2026-10-08) when the profile-unavailable control joined; the document
 * still owns them (`SURFACE_DOC_2026_08_12.controls`). Every literal comes
 * from `./literals.ts`; this file supplies only the STRUCTURE.
 */

import type { ControlDescriptor } from '@/surface/schema/surface';
import {
  NAV_PROFILE_PATH_RE,
  ROLES,
  ROW_PROFILE_PATH_RE,
  SCOPES,
  SELECTORS,
} from '@/surface/versions/2026-08-12/literals';

/** A RegExp serialized for the JSON trip into page context. */
const rx = (r: RegExp): { source: string; flags: string } => ({ source: r.source, flags: r.flags });


/** The action button's anchor + state matchers. ORDER is load-bearing (ADR 0302). */
const ACTION_BUTTON: ControlDescriptor = {
  strategy: 'leading-text',
  // No widening tier, ever: a broader scope can press a DIFFERENT account's
  // Follow button and then "verify" against it.
  allowFallback: false,
  sel: SELECTORS.profileActionButtonRole,
  states: [
    ['follow-back', rx(SELECTORS.followBackText)],
    ['following', rx(SELECTORS.followingText)],
    ['requested', rx(SELECTORS.requestedText)],
    ['follow', rx(SELECTORS.followText)],
  ],
};

/** One stat control: named by matching its own word and NOT the other's. */
const stat = (which: 'followers' | 'following'): ControlDescriptor => ({
  strategy: 'smallest-text',
  which,
  rx: { followers: rx(SELECTORS.followersStatText), following: rx(SELECTORS.followingStatText) },
  // The presence of `exclude` selects the stat rule inside `smallest-text`:
  // match one word and NOT the other, first candidate wins.
  exclude: true,
  scopes: SCOPES.profile,
  candSel: `${ROLES.clickable}, button`,
  clickableSel: ROLES.clickable,
});

export const CONTROLS: Record<string, ControlDescriptor> = {
  'action-button': ACTION_BUTTON,
  'unfollow-confirm': {
    strategy: 'role-then-deep-text',
    rx: rx(SELECTORS.unfollowConfirmText),
    scopes: SCOPES.drawer.slice(0, 2),
    roleSel: ROLES.menuControl,
    deepSel: ROLES.bareContainer,
    clickableSel: ROLES.menuClickable,
    maxChildren: 3,
    maxTextLen: 40,
  },
  'followers-stat': stat('followers'),
  'following-stat': stat('following'),
  // Presence only (never pressed): the page a missing profile renders.
  'profile-unavailable': {
    strategy: 'smallest-text',
    rx: rx(SELECTORS.profileUnavailableText),
    scopes: SCOPES.profile,
    nodeSel: ROLES.textNode,
    clickableSel: ROLES.textNode,
  },
  'notifications-link': {
    strategy: 'aria-label',
    rx: rx(SELECTORS.notificationsLabelText),
    scopes: SCOPES.navThenBody,
    labeledSel: ROLES.labeled,
    clickableSel: ROLES.clickable,
  },
  'drawer-close': {
    strategy: 'aria-label',
    rx: rx(SELECTORS.drawerCloseLabelText),
    scopes: SCOPES.drawerThenBody,
    labeledSel: ROLES.labeled,
    clickableSel: ROLES.button,
  },
  'notifications-follows-filter': {
    strategy: 'smallest-text',
    rx: rx(SELECTORS.followsFilterText),
    scopes: SCOPES.drawerThenBody,
    nodeSel: ROLES.textNode,
    clickableSel: `${ROLES.clickable}, [role="tab"]`,
  },
  'follow-requests-entry': {
    strategy: 'smallest-text',
    rx: rx(SELECTORS.followRequestsEntryText),
    scopes: SCOPES.drawerThenBody,
    nodeSel: ROLES.textNode,
    clickableSel: `${ROLES.clickable}, [role="menuitem"]`,
  },
  'confirm-follow-request': {
    strategy: 'row-with-profile-link',
    rx: rx(SELECTORS.confirmRequestText),
    scopes: SCOPES.drawerThenBody,
    buttonSel: ROLES.button,
    profilePathRx: rx(ROW_PROFILE_PATH_RE),
    maxDepth: 8,
  },
  'list-scroller': {
    strategy: 'largest-scrollable',
    rootSel: SELECTORS.dialog,
    interactiveSel: ROLES.hoverTrigger,
  },
  'drawer-scroller': {
    strategy: 'largest-scrollable',
    scopes: SCOPES.drawer,
  },
  // ---- ESCAPE TIER (ADR 0305) ------------------------------------------------
  // The identity resolver runs BEFORE any Interactor exists — it is what names
  // the account the graph is built for — so its four page functions keep their
  // bespoke shapes (an anchor that is BOTH a bare profile path AND contains the
  // avatar image; a synthetic click). None of the six strategies expresses that
  // without over-abstracting, so it is declared as an escape and cited.
  'profile-link': {
    strategy: 'escape',
    adr: '0305',
    fn: 'locateProfileLink',
    cfg: { profilePathRx: rx(NAV_PROFILE_PATH_RE), scopes: SCOPES.navThenBody },
  },
  'profile-link-click': {
    strategy: 'escape',
    adr: '0305',
    fn: 'clickProfileLink',
    cfg: { profilePathRx: rx(NAV_PROFILE_PATH_RE), scopes: SCOPES.nav },
  },
  'profile-href': {
    strategy: 'escape',
    adr: '0305',
    fn: 'readProfileHref',
    cfg: { profilePathRx: rx(NAV_PROFILE_PATH_RE), scopes: SCOPES.navThenBody },
  },
  'avatar-alt': {
    strategy: 'escape',
    adr: '0305',
    fn: 'readAvatarAlt',
    cfg: { sel: SELECTORS.avatarImage },
  },
};

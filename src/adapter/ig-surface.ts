/**
 * IgSurface — the STABLE, version-agnostic interface over everything
 * Instagram-specific.
 *
 * The adapter core (Reader / Actor / Sentinel / identity) is written purely
 * against this interface and carries ZERO Instagram literals. All concrete
 * facts — URLs, JSON paths, selectors, app id, block signatures, in-page
 * scripts — live in exactly one tiny versioned module under
 * `src/adapter/versions/`. When Instagram changes its API or UI, only a
 * version module changes (or a new one is added and `SURFACE` re-pointed);
 * everything else in the app stays untouched.
 */

import type { Observation } from '@/store/types';
import type { ShapeMismatch } from '@/adapter/parse-helpers';

// Re-export the shape-mismatch sentinel as part of the stable surface (it is
// defined in `parse-helpers.ts` so version modules can import it at runtime
// without a module cycle).
export { SHAPE_MISMATCH, isShapeMismatch, type ShapeMismatch } from '@/adapter/parse-helpers';

/** The endpoint kinds the surface knows how to route. */
export type EndpointKind =
  | 'followers-list'
  | 'following-list'
  | 'show-many'
  | 'friendship-show'
  | 'web-profile-info'
  | 'activity-feed';

/**
 * The uniform result EVERY in-page fetch script resolves to. In page context
 * the script checks `r.ok` and the content type and never lets `r.json()`
 * reject on an HTML/error body:
 *
 *  - JSON 2xx              → `{ ok: true,  status, contentType, json }`
 *  - non-JSON / non-ok     → `{ ok: false, status, contentType, textHead }`
 *  - network error / throw → `{ ok: false, status: 0, contentType: '', textHead: String(err) }`
 */
export interface FetchEnvelope {
  ok: boolean;
  status: number;
  contentType: string;
  json?: unknown;
  /** First 256 chars of a non-JSON body (or the error string). */
  textHead?: string;
  /** The response's final URL (after redirects) — lets callers spot login/challenge walls. */
  finalUrl?: string;
}

/** Narrow an unknown `evaluate` result to a {@link FetchEnvelope}, else `null`. */
export function asFetchEnvelope(value: unknown): FetchEnvelope | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.ok !== 'boolean') return null;
  if (typeof v.status !== 'number') return null;
  if (typeof v.contentType !== 'string') return null;
  return value as unknown as FetchEnvelope;
}

/** Whether a (failed) envelope looks like an HTML wall rather than an API body. */
export function envelopeLooksLikeHtml(env: FetchEnvelope): boolean {
  if (env.contentType.toLowerCase().includes('text/html')) return true;
  const head = env.textHead ?? '';
  return head.trimStart().startsWith('<');
}

/** Sentinel classification of the tab / a response URL. */
export type SentinelStatus = 'ok' | 'action-blocked' | 'challenge' | 'logged-out';

/**
 * A labelled block/challenge/logged-out signature. Replaces the old positional
 * `BLOCK_SIGNATURES.urls` index→label contract: each pattern carries the
 * status it maps to.
 */
export interface BlockSignature {
  pattern: RegExp;
  status: SentinelStatus;
}

/** The DOM contact points the Actor can find stale (for `AdapterStaleError`). */
export type StaleComponent =
  | 'action-button'
  | 'unfollow-confirm'
  | 'followers-stat'
  | 'following-stat'
  | 'dialog';

/** Result of parsing one paginated followers page. */
export interface FollowersListResult {
  observations: Observation[];
  /** Resume cursor for the next page; `null` when there is no next page. */
  cursor: string | null;
  hasMore: boolean;
}

/** One relationship row from the batched shape (carries no followed-by). */
export interface ShowManyEntry {
  pk: string;
  following: boolean;
  isPrivate?: boolean;
}

/** The single-relationship shape — both directions known. */
export interface FriendshipShowResult {
  pk: string;
  following: boolean;
  /** `followedBy` => THEY follow us (the follow-back signal). */
  followedBy: boolean;
  isPrivate?: boolean;
}

// ---------------------------------------------------------------------------
// Humanizer locate-script results (additive). The locate scripts perform the
// SAME element search as the click scripts but return the target's viewport
// bounding rect (getBoundingClientRect) WITHOUT clicking — the Humanizer then
// performs the click/scroll with real trusted input events.
// ---------------------------------------------------------------------------

/** A viewport bounding rect as the locate scripts report it (CSS px). */
export interface LocatedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Result of a plain locate script (confirm control, stat controls). */
export interface LocateRectResult {
  found: boolean;
  rect?: LocatedRect;
}

/** Locate-only variant of `findAndActScript`: same search + decision, no click. */
export interface LocateActionResult {
  found: boolean;
  state?: 'follow' | 'follow-back' | 'following' | 'requested';
  /** Whether the op would click this button (the Humanizer then performs it). */
  wouldClick?: boolean;
  needsConfirm?: boolean;
  rect?: LocatedRect;
}

/** Locate-only variant of `scrollFollowersScript`: container rect + metrics. */
export interface LocateScrollResult {
  found: boolean;
  rect?: LocatedRect;
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
}

/** Ids a surface can pull out of an endpoint URL (the bodies often carry none). */
export interface EndpointIds {
  /** Subject pk of a single-relationship URL. */
  pk?: string;
  /** Target pk of a followers-list URL. */
  targetPk?: string;
}

/**
 * EVERYTHING Instagram-specific, behind one interface. Implemented once per
 * verified capture in `src/adapter/versions/<capture-date>.ts`.
 */
export interface IgSurface {
  /** Capture provenance — the version module's date. */
  version: string;
  /** When these facts were last verified against live Instagram. */
  capturedAt: string;

  // --- Endpoints ----------------------------------------------------------
  /** Route a response URL to the endpoint kind that handles it, or `null`. */
  matchEndpoint(url: string): EndpointKind | null;
  /** Pull the pk/targetPk a `kind`'s URL carries (empty object on no match). */
  extractIds(kind: EndpointKind, url: string): EndpointIds;

  // --- Response extractors (already-parsed JSON bodies) -------------------
  /** Parse a followers page. `SHAPE_MISMATCH` on an unexpected record shape. */
  extractFollowersList(body: unknown, at: number): FollowersListResult | ShapeMismatch;
  /**
   * Parse a profile-info body into a profile observation. `null` when the user
   * is genuinely absent; `SHAPE_MISMATCH` when a user is present but unreadable.
   */
  extractProfileInfo(body: unknown, at: number): Observation | null | ShapeMismatch;
  /** Whether the viewer already follows this profile; `null` when absent. */
  extractProfileFollowedByViewer(body: unknown): boolean | null;
  /** Parse the batched relationship map. `SHAPE_MISMATCH` on unexpected shape. */
  extractShowMany(body: unknown): ShowManyEntry[] | ShapeMismatch;
  /**
   * Parse the single `friendships/show/<pk>` shape. `SHAPE_MISMATCH` on an
   * unexpected shape — so "no relationship" and "unparsed" stay distinguishable.
   */
  extractFriendshipShow(body: unknown, pk: string): FriendshipShowResult | ShapeMismatch;
  /** The logged-in username from a `current_user` body, or `null`. */
  extractCurrentUsername(body: unknown): string | null;

  // --- In-page FETCH scripts (each resolves to a FetchEnvelope) -----------
  profileInfoScript(username: string): string;
  currentUserScript(): string;
  friendshipShowScript(pk: string): string;

  // --- In-page non-fetch probes -------------------------------------------
  /** Read the page's visible body text (Sentinel's block-text backstop). */
  bodyTextProbeScript(): string;

  // --- Actor scripts (embed the verified selectors / text matchers) --------
  findAndActScript(op: 'follow' | 'unfollow'): string;
  probeStateScript(): string;
  confirmUnfollowScript(): string;
  clickFollowersStatScript(): string;
  clickFollowingStatScript(): string;
  dialogPresentScript(): string;
  scrollFollowersScript(): string;

  // --- Humanizer locate scripts (OPTIONAL — additive) ----------------------
  // Same element searches as the click scripts above, but they RETURN the
  // target's bounding rect instead of clicking; the Actor uses them only when
  // a Humanizer is wired, and falls back to the click scripts when a surface
  // version does not provide them.
  locateActionButtonScript?(op: 'follow' | 'unfollow'): string;
  locateConfirmUnfollowScript?(): string;
  locateFollowersStatScript?(): string;
  locateFollowingStatScript?(): string;
  locateScrollContainerScript?(): string;

  // --- Identity scripts ----------------------------------------------------
  readProfileHrefScript(): string;
  clickProfileLinkScript(): string;
  readAvatarAltScript(): string;

  // --- DOM / URL utilities --------------------------------------------------
  profileUrl(username: string): string;
  /** The selector/text label reported when `component` is found stale. */
  staleSelectorLabel(component: StaleComponent): string;
  /** Extract a username from the avatar's alt text. */
  usernameFromAvatarAlt(alt: string): string | null;
  /** Extract a username from a profile URL/path (`/foo/`); `null` otherwise. */
  usernameFromProfileUrl(href: string): string | null;
  /** First path segments that must never be taken as a username. */
  reservedRoutes: ReadonlySet<string>;
  usernameRegex: RegExp;
  profilePathRegex: RegExp;

  // --- Sentinel signatures --------------------------------------------------
  /** URL block/challenge/logged-out signatures (labelled). */
  blockSignatures: readonly BlockSignature[];
  /** Body-text signatures (all label `action-blocked`). */
  textSignatures: readonly BlockSignature[];

  // --- Constants ------------------------------------------------------------
  /** Web app id — required header for the private JSON API. */
  appId: string;
  /** The site origin (no trailing slash). */
  origin: string;
  /** The desktop UA the persistent session pins (private API rejects Electron's). */
  userAgent: string;
  /** Observed max user-ids per batched relationship request. */
  showManyMaxBatch: number;
}

// ---------------------------------------------------------------------------
// The ACTIVE surface. When Instagram changes, add a new version module and
// re-point this import — nothing else in the app changes.
// ---------------------------------------------------------------------------
import { SURFACE_2026_08_12 } from '@/adapter/versions/2026-08-12';

export const SURFACE: IgSurface = SURFACE_2026_08_12;

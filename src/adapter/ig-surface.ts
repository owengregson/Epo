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

import {
  classifyEnvelopeWith,
  type EnvelopeClassification,
  type FetchEnvelope,
} from '@/adapter/envelope';
import { classifyMutationWith, type MutationClassification } from '@/adapter/mutation-classify';
import type { MutationKind, MutationMatch, MutationRequest, MutationVerdict } from '@/adapter/mutation-types';
import type { ShapeMismatch } from '@/adapter/parse-helpers';
import type {
  BlockSignature,
  EndpointIds,
  FollowEvent,
  FollowersListResult,
  FriendshipShowResult,
  Observation,
  ShowManyEntry,
  StaleComponent,
} from '@/adapter/surface-types';

// The envelope, mutation and result types live in sibling modules that import
// nothing from here; re-exported so every consumer keeps one import site.
export {
  asFetchEnvelope,
  type EnvelopeClassification,
  type EnvelopeKind,
  envelopeLooksLikeHtml,
  type FetchEnvelope,
} from '@/adapter/envelope';
export type { MutationClassification, MutationOutcomeKind } from '@/adapter/mutation-classify';
export type { MutationKind, MutationMatch, MutationRequest, MutationVerdict } from '@/adapter/mutation-types';
// Re-export the shape-mismatch sentinel as part of the stable surface (it is
// defined in `parse-helpers.ts` so version modules can import it at runtime
// without a module cycle).
export { isShapeMismatch, SHAPE_MISMATCH, type ShapeMismatch } from '@/adapter/parse-helpers';
export type {
  BlockSignature,
  EndpointIds,
  FollowEvent,
  FollowersListResult,
  FriendshipShowResult,
  LocateActionResult,
  LocateConfirmRequestResult,
  LocatedRect,
  LocateRectResult,
  LocateScrollResult,
  ProfileViewer,
  SentinelStatus,
  ShowManyEntry,
  StaleComponent,
} from '@/adapter/surface-types';

/** The endpoint kinds the surface knows how to route. */
export type EndpointKind =
  | 'followers-list'
  | 'following-list'
  | 'friend-requests'
  | 'show-many'
  | 'friendship-show'
  /** `/api/v1/users/<pk>/info/` — what Epo fetches for a profile. */
  | 'profile-info'
  /** The GraphQL profile query Instagram's own client fires; OBSERVED only. */
  | 'profile-graphql'
  | 'activity-feed';

/**
 * Classify a fetch envelope into its failure family against the active
 * surface's signatures (see `classifyEnvelopeWith` in `envelope.ts`).
 */
export function classifyEnvelope(env: FetchEnvelope): EnvelopeClassification {
  return classifyEnvelopeWith(env, SURFACE);
}

/**
 * Classify a mutation response against the active surface's refusal
 * signatures (see `classifyMutationWith` in `mutation-classify.ts`).
 */
export function classifyMutationResponse(
  httpStatus: number,
  verdict: MutationVerdict | ShapeMismatch,
): MutationClassification {
  return classifyMutationWith(httpStatus, verdict, SURFACE.mutationRefusalSignatures);
}

/**
 * EVERYTHING Instagram-specific, behind one interface. Implemented once per
 * verified capture in `src/adapter/versions/<capture-date>.ts`.
 */
export interface IgSurface {
  /** Capture provenance — the version module's date. */
  version: string;

  // --- Endpoints ----------------------------------------------------------
  /**
   * Route a response URL to the endpoint kind that handles it, or `null`.
   *
   * `friendlyName` is the GraphQL operation name the REQUEST carried (see
   * {@link IgSurface.friendlyName}). One URL can serve many operations, so an
   * endpoint identified by its operation name matches only when that name is
   * supplied and matches.
   */
  matchEndpoint(url: string, friendlyName?: string): EndpointKind | null;

  /**
   * The GraphQL operation name a request carried, read off its (lower-cased)
   * headers. Keeps the header's NAME an Instagram literal of the surface.
   */
  friendlyName(requestHeaders?: Record<string, string>): string | undefined;

  /**
   * Whether a response's media type carries a parseable body. An API URL that
   * answers anything else is a wall (HTML interstitial), not data.
   */
  parseableMime(mimeType: string): boolean;
  /** Pull the pk/targetPk a `kind`'s URL carries (empty object on no match). */
  extractIds(kind: EndpointKind, url: string): EndpointIds;

  // --- Response extractors (already-parsed JSON bodies) -------------------
  /**
   * Parse a followers/following page. `SHAPE_MISMATCH` on an unexpected record
   * shape. `source` labels the observations' provenance (default
   * `'followers-list'`); the following-list endpoint shares the shape but its
   * observations must not claim the wrong endpoint.
   */
  extractFollowersList(
    body: unknown,
    at: number,
    source?: 'followers-list' | 'following-list' | 'friend-requests',
  ): FollowersListResult | ShapeMismatch;
  /**
   * Parse a profile-info body into a profile observation. `null` when the user
   * is genuinely absent; `SHAPE_MISMATCH` when a user is present but unreadable.
   */
  extractProfileInfo(body: unknown, at: number): Observation | null | ShapeMismatch;
  /** Whether the viewer already follows this profile; `null` when absent. */
  extractProfileFollowedByViewer(body: unknown): boolean | null;
  /** Whether the viewer has a PENDING follow request to this profile; `null` when absent. */
  extractProfileRequestedByViewer(body: unknown): boolean | null;
  /** Whether this profile follows the viewer (`followed_by`); `null` when absent. */
  extractProfileFollowsViewer(body: unknown): boolean | null;
  /** Parse the batched relationship map. `SHAPE_MISMATCH` on unexpected shape. */
  extractShowMany(body: unknown): ShowManyEntry[] | ShapeMismatch;
  /**
   * Parse the single `friendships/show/<pk>` shape. `SHAPE_MISMATCH` on an
   * unexpected shape — so "no relationship" and "unparsed" stay distinguishable.
   */
  extractFriendshipShow(body: unknown, pk: string): FriendshipShowResult | ShapeMismatch;
  /**
   * Parse the activity-feed (news inbox) body into the "started following you"
   * events it carries. `SHAPE_MISMATCH` when the body is present but carries
   * none of the expected story containers; an empty list is a VALID result (no
   * recent follows).
   */
  extractActivityFeed(body: unknown): FollowEvent[] | ShapeMismatch;

  // --- Mutations (the action button's own requests) ------------------------
  /**
   * Recognise the follow/unfollow mutation request the web client fires when
   * the action button is pressed — by URL, and for GraphQL by the request's
   * friendly-name header. `null` for reads and everything else.
   */
  matchMutation(req: MutationRequest): MutationMatch | null;
  /** The server's verdict from a mutation body; `SHAPE_MISMATCH` when unreadable. */
  extractMutationVerdict(body: unknown, kind?: MutationKind): MutationVerdict | ShapeMismatch;
  /**
   * Refusal signatures matched against a FAILED verdict's message + feedback
   * text (`feedback_required`, "Try Again Later", `checkpoint_required`, …),
   * each labelled with the wall it means.
   */
  mutationRefusalSignatures: readonly BlockSignature[];

  // --- In-page FETCH scripts (each resolves to a FetchEnvelope) -----------
  // Only the list pages: Instagram's own client calls the same endpoint.
  // Profiles are VISITED, never fetched (`rim/profile-visit.ts`, 2026-10-08).
  /**
   * Fetch ONE page of a friendships list (`followers` or `following`) straight
   * from the paginated API — the same endpoint the list dialog paginates, but
   * at the API's full page size instead of the dialog's small scroll batches.
   * `maxId` is the previous page's resume cursor (`null` for the first page);
   * the body parses with {@link extractFollowersList}.
   */
  listPageScript(pk: string, which: 'followers' | 'following', maxId: string | null, endProbe?: boolean): string;
  /**
   * A synthesized cursor pointing just PAST `rowsFetched` rows — used to probe
   * one page beyond a claimed end-of-list so the end is VERIFIED, not trusted.
   * Must be safe when cursor semantics drift: a bogus value should make IG
   * return already-seen rows (a confirmation), never new phantom data.
   */
  listEndProbeCursor(rowsFetched: number): string;

  // --- In-page non-fetch probes -------------------------------------------
  /** Read the page's visible body text (Sentinel's block-text backstop). */
  bodyTextProbeScript(): string;

  // --- Actor probes -------------------------------------------------------
  /** Read the profile action button's current leading state (post-click check). */
  probeStateScript(): string;
  /** Whether the list modal is on screen. */
  dialogPresentScript(): string;

  // --- Actor LOCATE scripts -----------------------------------------------
  // Each searches for a control and returns its viewport rect WITHOUT clicking;
  // the Interactor then presses/scrolls it with native input events. There is
  // no in-page `.click()` tier: the SPA ignores a synthetic click on several of
  // these controls, so a version module must implement every locate script.
  locateActionButtonScript(op: 'follow' | 'unfollow'): string;
  locateConfirmUnfollowScript(): string;
  locateFollowersStatScript(): string;
  /** The page a missing / hidden profile renders (presence only, never pressed). */
  locateProfileUnavailableScript(): string;
  locateFollowingStatScript(): string;
  locateScrollContainerScript(): string;
  /** The nav profile-avatar link's rect — the Interactor clicks it to land on our profile. */
  locateProfileLinkScript(): string;
  /** The nav notifications control — opening the drawer fires the feed read the Reader observes. */
  locateNotificationsLinkScript(): string;
  /** The "Follows" category filter chip inside the open drawer. */
  locateNotificationsFollowsFilterScript(): string;
  /** The drawer's CLOSE (X) control — the supported way to leave the drawer. */
  locateNotificationsCloseScript(): string;
  /** The drawer's scroll container + metrics (for loading older pages). */
  locateNotificationsScrollScript(): string;
  /**
   * The "Follow requests" entry INSIDE the open notifications drawer —
   * clicking it opens the pending-requests panel, which fires the
   * friendships/pending fetch. `found: false` when no requests entry exists
   * (public account / nothing pending) — a soft skip, never stale.
   */
  locateFollowRequestsEntryScript(): string;
  /**
   * The FIRST "Confirm" control in the open follow-requests panel, plus the
   * row's username (from its profile link) so the caller knows WHO it is
   * accepting and can verify progress between clicks.
   */
  locateConfirmFollowRequestScript(): string;

  // --- Identity scripts ----------------------------------------------------
  readProfileHrefScript(): string;
  /**
   * Click the nav profile-avatar link IN PAGE. The identity resolver runs
   * before any Interactor exists (it is what names the account the graph is
   * built for), so this one control keeps a JS-click script; every Actor
   * control goes through a locate script + native input instead.
   */
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
}

// ---------------------------------------------------------------------------
// The ACTIVE surface. When Instagram changes, add a new version module and
// re-point this import — nothing else in the app changes.
// ---------------------------------------------------------------------------
import { SURFACE_2026_08_12 } from '@/adapter/versions/2026-08-12';

export const SURFACE: IgSurface = SURFACE_2026_08_12;

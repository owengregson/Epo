/**
 * Instagram surface — capture 2026-08-12 (ADAPTER FAÇADE).
 *
 * This module used to be the single source of truth for everything
 * Instagram-specific. It is now a MIGRATION SHIM: every literal it once
 * declared lives in `src/surface/versions/2026-08-12/literals.ts`, and the
 * routing tables (endpoints, mutations, signals) are read off the validated
 * surface DOCUMENT (`src/surface/versions/2026-08-12/surface.ts`). What is left
 * here is the `IgSurface` shape the adapter core still programs against — eight
 * hand-written extractors and the in-page script builders — which the schemas
 * subsume endpoint by endpoint as each one flips from `observe` to `enforce`.
 *
 * The constraint is unchanged and now stronger: this file carries NO Instagram
 * literal of its own. Everything below reads from the document or the literals
 * module, so a capture change still touches exactly one directory.
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
import { pageCall as callPage } from '@/adapter/page-call';
import {
  asBool,
  asCount,
  asStringId,
  getPath,
  isRecord,
  isShapeMismatch,
  SHAPE_MISMATCH,
  type ShapeMismatch,
} from '@/adapter/parse-helpers';
import { extractMutationVerdict, matchMutation } from '@/adapter/versions/2026-08-12.mutations';
import { activityFeedRoot, followRequestsPage } from '@/adapter/versions/2026-08-12.notifications';
import type { Observation } from '@/store/types';
import {
  AVATAR_ALT_RE,
  BODY_MIME_PARSEABLE,
  FOLLOWING_LIST_ORDER,
  GRAPHQL_FRIENDLY_NAME_HEADER,
  IG_APP_ID,
  JSON_PATHS,
  LIST_PAGE_COUNT,
  PATHS,
  PROFILE_PATH_RE,
  RESERVED_ROUTES,
  SELECTORS,
  USERNAME_RE,
} from '@/surface/versions/2026-08-12/literals';
import { SURFACE_DOC_2026_08_12 as DOC } from '@/surface/versions/2026-08-12/surface';

/** Everything routed below is read off the validated document, never re-typed. */
const SIGNALS = (surface: 'url' | 'text' | 'refusal'): readonly BlockSignature[] =>
  DOC.signals
    .filter((s) => s.surface === surface)
    .map((s) => ({ pattern: s.pattern, status: s.status }));

const URL_BLOCK_SIGNATURES = SIGNALS('url');
const TEXT_BLOCK_SIGNATURES = SIGNALS('text');
const MUTATION_REFUSAL_SIGNATURES = SIGNALS('refusal');

// ---------------------------------------------------------------------------
// In-page script builders
// ---------------------------------------------------------------------------

/**
 * Wrap a fetch of `urlExpr` (a JS expression evaluated in page context) so it
 * ALWAYS resolves to a `FetchEnvelope` — `r.json()` is only called on a JSON
 * 2xx, an HTML/error body yields `{ ok: false, ..., textHead }`, and a network
 * error yields `{ ok: false, status: 0, contentType: '', textHead }`. The
 * private API requires the `x-ig-app-id` header + session credentials.
 *
 * The fetch is abort-bounded so a never-responding endpoint settles as an
 * envelope failure instead of leaving the caller's evaluate pending. The
 * 20000 literal is inlined because page scripts cannot import — it mirrors
 * `TAB.FETCH_ABORT_MS` in `@/timing/config`; keep the two in sync.
 */
const envelopeFetchScript = (urlExpr: string): string =>
  `fetch(${urlExpr}, { headers: { 'x-ig-app-id': '${IG_APP_ID}' }, credentials: 'include', signal: AbortSignal.timeout(20000) })
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

// ---------------------------------------------------------------------------
// In-page CALLS. Every DOM mechanic lives in `src/adapter/page/*.ts` (real
// TypeScript: type-checked, linted, DOM-tested) and is bundled into
// `PAGE_BUNDLE`, scoped locally by `pageCall`. This module supplies ONLY
// the Instagram literals, as a JSON config per call — so a DOM change on
// Instagram's side still touches nothing but the tables above.
// ---------------------------------------------------------------------------

/**
 * A page call on a CONTROL DESCRIPTOR. Every control the Actor drives is one
 * entry in the document's `controls` record; the page bundle's `locate` /
 * `probe` interpret the strategy it names (see `src/adapter/page/locate.ts`).
 * The `locate*Script` members below are now thin wrappers over that — the Actor
 * is unchanged, and a new capture edits data instead of adding a method.
 */
const control = (id: string, extra: Record<string, unknown> = {}): string =>
  callPage('locate', { control: id, ...DOC.controls[id], ...extra });

/** The action button's state probe rides the same descriptor. */
const probeControl = (id: string): string =>
  callPage('probe', { control: id, ...DOC.controls[id] });

// ---------------------------------------------------------------------------
// Response extractors
// ---------------------------------------------------------------------------

function extractFollowersList(
  raw: unknown,
  at: number,
  source: 'followers-list' | 'following-list' | 'friend-requests' = 'followers-list',
): FollowersListResult | ShapeMismatch {
  const body = source === 'friend-requests' ? followRequestsPage(raw) : raw;
  if (!isRecord(body)) return SHAPE_MISMATCH;

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

/**
 * The profile USER record out of either profile body.
 *
 * Epo FETCHES `/users/<pk>/info/` (`{ user }`) and OBSERVES the GraphQL profile
 * query Instagram's own client fires (`{ data: { user } }`). The records inside
 * are the same shape, so one reader serves both containers.
 *
 * Returns `null` for "Instagram says this profile is gone" (a container that
 * exists with an empty user) and `SHAPE_MISMATCH` for anything else — a
 * `{status:'fail'}` soft-block body must never be read as a deletion (ADR 0303).
 */
function profileUserOf(body: unknown): Record<string, unknown> | null | ShapeMismatch {
  if (!isRecord(body)) return SHAPE_MISMATCH;
  const at = JSON_PATHS.profileUserAt;
  for (const path of [at.info, at.graphql]) {
    const user = getPath(body, path);
    if (isRecord(user)) return user;
  }
  // Neither container held a record. A container that is PRESENT but empty is
  // the "gone" answer; a body carrying no container at all is drift. The
  // GraphQL container is the parent of its `user` leaf, derived from the same
  // path rather than spelled a second time.
  const graphqlParent = at.graphql.slice(0, at.graphql.lastIndexOf('.'));
  const present =
    at.info in (body as Record<string, unknown>) || isRecord(getPath(body, graphqlParent));
  return present ? null : SHAPE_MISMATCH;
}

function extractProfileInfo(body: unknown, at: number): Observation | null | ShapeMismatch {
  const user = profileUserOf(body);
  if (user === null || isShapeMismatch(user)) return user;

  const p = JSON_PATHS.profileUser;
  // `/users/<pk>/info/` sends `pk` as a NUMBER and `id` as its string twin;
  // the GraphQL body sends a string `pk`. Either spelling is the same id.
  const pk = asStringId(user[p.id]) ?? asStringId(user[p.altId]);
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

/**
 * The viewer-side flags. Carried by the GraphQL profile body only —
 * `/users/<pk>/info/` omits `friendship_status` entirely, so these answer
 * `null` (UNKNOWN) for a fetched profile and the caller reads
 * `friendships/show/<pk>/` when it needs the relationship.
 */
function profileViewerFlag(body: unknown, path: string): boolean | null {
  const user = profileUserOf(body);
  if (user === null || isShapeMismatch(user)) return null;
  const v = getPath(user, path);
  return typeof v === 'boolean' ? v : null;
}

function extractProfileFollowedByViewer(body: unknown): boolean | null {
  return profileViewerFlag(body, JSON_PATHS.profileUser.followedByViewer);
}

function extractProfileRequestedByViewer(body: unknown): boolean | null {
  return profileViewerFlag(body, JSON_PATHS.profileUser.requestedByViewer);
}

function extractProfileFollowsViewer(body: unknown): boolean | null {
  return profileViewerFlag(body, JSON_PATHS.profileUser.followsViewer);
}

function extractShowMany(body: unknown): ShowManyEntry[] | ShapeMismatch {
  if (!isRecord(body)) return SHAPE_MISMATCH;

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

/**
 * Parse the news-inbox (activity feed) body into "started following you"
 * events. An entry qualifies through EITHER signal — the numeric follow
 * `story_type` or the text matcher — so a drift in one doesn't blind the
 * follow-back watcher. `SHAPE_MISMATCH` when the body carries NONE of the
 * expected story containers (drift / error body); empty sections are a valid
 * "no recent follows" result.
 */
function extractActivityFeed(raw: unknown): FollowEvent[] | ShapeMismatch {
  const body = activityFeedRoot(raw);
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
    path = new URL(url, `${DOC.origin}/`).pathname;
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
  version: DOC.id,

  matchEndpoint(url: string, friendlyName?: string): EndpointKind | null {
    for (const entry of DOC.endpoints) {
      if (!entry.match.url.test(url)) continue;
      // See `matchEndpoint` in `@/surface/index`: an endpoint identified by a
      // GraphQL operation name needs that name to have been observed.
      if (entry.match.friendlyName !== undefined) {
        if (friendlyName === undefined || !entry.match.friendlyName.test(friendlyName)) continue;
      }
      return entry.kind;
    }
    return null;
  },

  friendlyName(requestHeaders?: Record<string, string>): string | undefined {
    return requestHeaders?.[GRAPHQL_FRIENDLY_NAME_HEADER];
  },

  parseableMime: (mimeType: string): boolean => BODY_MIME_PARSEABLE.test(mimeType),

  extractIds(kind: EndpointKind, url: string): EndpointIds {
    const ids = DOC.endpoints.find((e) => e.kind === kind)?.match.ids;
    if (ids === undefined) return {};
    const out: EndpointIds = {};
    if (ids.pk) {
      const m = ids.pk.exec(url);
      if (m) out.pk = m[1];
    }
    if (ids.targetPk) {
      const m = ids.targetPk.exec(url);
      if (m) out.targetPk = m[1];
    }
    return out;
  },

  extractFollowersList,
  extractProfileRequestedByViewer,
  extractProfileInfo,
  extractProfileFollowedByViewer,
  extractProfileFollowsViewer,
  extractShowMany,
  extractFriendshipShow,
  extractActivityFeed,

  matchMutation,
  extractMutationVerdict,
  mutationRefusalSignatures: MUTATION_REFUSAL_SIGNATURES,

  // FOLLOWING is read in a FIXED order: Instagram re-ranks the default order on
  // every request (each page carries a fresh `follow_ranking_token`), so offset
  // paging repeated 405 of 3,447 rows and never returned 404 accounts (live
  // 2026-09-20). The ordered form answers the WHOLE list and ignores `max_id` —
  // so the past-the-end probe asks in the plain form, where an offset past the
  // end is empty, instead of downloading the entire list again.
  listPageScript: (pk, which, maxId, endProbe = false): string =>
    envelopeFetchScript(
      `'${PATHS.friendshipsList}' + encodeURIComponent(${JSON.stringify(pk)}) + '/${which}/?count=${LIST_PAGE_COUNT}${which === 'following' && !endProbe ? FOLLOWING_LIST_ORDER : ''}'` +
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

  bodyTextProbeScript: (): string =>
    callPage('blockText', {
      containerSel: SELECTORS.blockTextContainers,
      headingSel: SELECTORS.blockTextHeadings,
    }),

  probeStateScript: (): string => probeControl('action-button'),
  dialogPresentScript: (): string => callPage('dialogPresent', { sel: SELECTORS.dialog }),

  locateActionButtonScript: (op: 'follow' | 'unfollow'): string =>
    control('action-button', { op }),
  locateConfirmUnfollowScript: (): string => control('unfollow-confirm'),
  locateFollowersStatScript: (): string => control('followers-stat'),
  locateProfileUnavailableScript: (): string => control('profile-unavailable'),
  locateFollowingStatScript: (): string => control('following-stat'),
  locateProfileLinkScript: (): string => control('profile-link'),
  locateNotificationsLinkScript: (): string => control('notifications-link'),
  locateNotificationsFollowsFilterScript: (): string => control('notifications-follows-filter'),
  locateNotificationsCloseScript: (): string => control('drawer-close'),
  locateNotificationsScrollScript: (): string => control('drawer-scroller'),
  locateFollowRequestsEntryScript: (): string => control('follow-requests-entry'),
  locateConfirmFollowRequestScript: (): string => control('confirm-follow-request'),
  locateScrollContainerScript: (): string => control('list-scroller'),

  readProfileHrefScript: (): string => control('profile-href'),
  clickProfileLinkScript: (): string => control('profile-link-click'),
  readAvatarAltScript: (): string => control('avatar-alt'),

  profileUrl: (username: string): string => `${DOC.origin}/${username}/`,
  staleSelectorLabel: (component: StaleComponent): string => STALE_LABELS[component],
  usernameFromAvatarAlt,
  usernameFromProfileUrl,

  blockSignatures: URL_BLOCK_SIGNATURES,
  textSignatures: TEXT_BLOCK_SIGNATURES,

  appId: DOC.appId,
  origin: DOC.origin,
  userAgent: DOC.userAgent,
};

// ---------------------------------------------------------------------------
// Capture-harness extras (src/capture) — broader, URL-substring heuristics the
// live capture harness uses BEFORE bodies exist. Declared with the rest of the
// literals; re-exported here so the harness keeps one import site.
// ---------------------------------------------------------------------------
export { CAPTURE_PATTERNS } from '@/surface/versions/2026-08-12/literals';

/**
 * Instagram surface — capture 2026-08-12 (ADAPTER FAÇADE).
 *
 * This module used to be the single source of truth for everything
 * Instagram-specific. It is now a MIGRATION SHIM: every literal it once
 * declared lives in `src/surface/versions/2026-08-12/literals.ts`, and the
 * routing tables (endpoints, mutations, signals) are read off the validated
 * surface DOCUMENT (`src/surface/versions/2026-08-12/surface.ts`). What is left
 * here is the `IgSurface` shape the adapter core still programs against — eight
 * hand-written extractors (`2026-08-12.extractors.ts`) and the in-page script
 * builders — which the schemas subsume endpoint by endpoint as each one flips
 * from `observe` to `enforce`.
 *
 * The constraint is unchanged and now stronger: this file carries NO Instagram
 * literal of its own. Everything below reads from the document or the literals
 * module, so a capture change still touches exactly one directory.
 */

import type {
  BlockSignature,
  EndpointIds,
  EndpointKind,
  IgSurface,
  StaleComponent,
} from '@/adapter/ig-surface';
import { pageCall as callPage } from '@/adapter/page-call';
import {
  extractActivityFeed,
  extractFollowersList,
  extractFriendshipShow,
  extractProfileInfo,
  extractProfileViewer,
  extractShowMany,
} from '@/adapter/versions/2026-08-12.extractors';
import { extractMutationVerdict, matchMutation } from '@/adapter/versions/2026-08-12.mutations';
import { CONTINUATION } from '@/surface/versions/2026-08-12/continuation-decl';
import {
  AVATAR_ALT_RE,
  BODY_MIME_PARSEABLE,
  FOLLOWING_LIST_ORDER,
  GRAPHQL_FRIENDLY_NAME_HEADER,
  IG_APP_ID,
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
  extractProfileInfo,
  extractProfileViewer,
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
  // The friendships list `max_id` is a ROW OFFSET (live: "50", "100", …), so the window just
  // past everything received starts at the rows fetched. An OPAQUE space is never probed so:
  // the server ignores the offset and returns the head, which is no evidence (spec §10.4).
  listEndProbeCursor: (rowsFetched: number): string => String(rowsFetched),
  listForm: (which) => CONTINUATION.composedForm[which],
  listCursorForm: (cursor) => (CONTINUATION.offsetCursor.test(cursor) ? 'offset' : 'opaque'),

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

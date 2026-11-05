/**
 * The Instagram surface DOCUMENT — capture 2026-08-12.
 *
 * Endpoints (match + response schema + `project()`), mutations, control
 * descriptors, signals and page sizes, as data. Every literal it uses comes
 * from `./literals.ts`; the projectors live in `./projectors.ts` and the
 * controls in `./controls.ts`; this file supplies only the STRUCTURE.
 *
 * `project()` is pure and synchronous by contract — that is what makes the
 * replay contract test (`tests/surface/replay.test.ts`) trivial and what keeps
 * enrichment out of the parse path. Each projector emits ONE fact per row so a
 * consumer writes through as it iterates (PRINCIPLES §1); it never returns a
 * completeness verdict, because completeness is the walker's to mint.
 */

import type { Source } from '@/store/types';
import type { ContainerDecl } from '@/surface/schema/decls';
import {
  defineEndpoint,
  type MutationSpec,
  type Signal,
  type SurfaceDocument,
} from '@/surface/schema/surface';
import { CONTAINERS } from '@/surface/versions/2026-08-12/containers';
import { CONTINUATION } from '@/surface/versions/2026-08-12/continuation-decl';
import { CONTROLS } from '@/surface/versions/2026-08-12/controls';
import { EXPECTED_KEYS, NOVELTY_BASELINE } from '@/surface/versions/2026-08-12/expected';
import {
  ACTIVITY_FEED_GRAPHQL_FRIENDLY_NAME,
  FOLLOW_REQUESTS_GRAPHQL_FRIENDLY_NAME,
  FOLLOW_REQUESTS_ROOT_FIELDS,
  IG_APP_ID,
  IG_ORIGIN,
  IG_USER_AGENT,
  JSON_PATHS,
  LIST_PAGE_COUNT,
  MUTATION_JSON,
  MUTATION_REFUSAL_SIGNATURES,
  MUTATION_URLS,
  PROFILE_GRAPHQL_FRIENDLY_NAME,
  TEXT_BLOCK_SIGNATURES,
  URL_BLOCK_SIGNATURES,
  URLS,
  VERSION,
} from '@/surface/versions/2026-08-12/literals';
import {
  projectActivityFeed,
  projectFriendshipShow,
  projectListPage,
  projectProfileUser,
  projectShowMany,
} from '@/surface/versions/2026-08-12/projectors';
import { RECOVERY_DECL } from '@/surface/versions/2026-08-12/recovery-decl';
import {
  ActivityFeedStories,
  FriendshipShowBody,
  ListPageBody,
  ProfileRecord,
  ShowManyBody,
} from '@/surface/versions/2026-08-12/schemas';
import { GRAPHQL, TRANSPORT } from '@/surface/versions/2026-08-12/transport-decl';

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

const SIGNALS: readonly Signal[] = [
  ...URL_BLOCK_SIGNATURES.map((s) => ({ ...s, surface: 'url' as const })),
  ...TEXT_BLOCK_SIGNATURES.map((s) => ({ ...s, surface: 'text' as const })),
  ...MUTATION_REFUSAL_SIGNATURES.map((s) => ({ ...s, surface: 'refusal' as const })),
];

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

const MUTATIONS: readonly MutationSpec[] = [
  { kind: 'follow', match: { method: 'POST', url: MUTATION_URLS.follow } },
  { kind: 'unfollow', match: { method: 'POST', url: MUTATION_URLS.unfollow } },
  { kind: 'follow', match: { method: 'POST', url: MUTATION_URLS.followApp } },
  { kind: 'unfollow', match: { method: 'POST', url: MUTATION_URLS.unfollowApp } },
  // GraphQL is opaque by URL: told apart from a query only by the friendly-name
  // request header. UNFOLLOW is listed first — `/follow/i` also matches
  // "unfollow", exactly as the leading-text state order is load-bearing.
  {
    kind: 'unfollow',
    match: { method: 'POST', url: MUTATION_URLS.graphql },
    friendlyName: /unfollow/i,
  },
  {
    kind: 'follow',
    match: { method: 'POST', url: MUTATION_URLS.graphql },
    friendlyName: /follow/i,
  },
];

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

const listEndpoint = (
  kind: 'followers-list' | 'following-list',
  url: RegExp,
  targetPk: RegExp,
  source: Source,
) =>
  defineEndpoint({
    kind,
    match: { method: 'GET', url, ids: { targetPk } },
    response: ListPageBody,
    project: projectListPage,
    source,
    containers: CONTAINERS.list,
  });

/**
 * The notifications drawer's reads. Since 2026-11 its client reads the feed and the
 * follow-requests panel through GraphQL; each GraphQL definition declares the container that
 * wraps the very same stories and `pending/` rows, so the projectors are shared.
 */
const drawerEndpoint = (kind: 'activity-feed' | 'friend-requests', rest: { url: RegExp; method: 'GET' | 'POST' },
  op: RegExp, containers: { rest: readonly [ContainerDecl, ...ContainerDecl[]]; graphql: readonly [ContainerDecl, ...ContainerDecl[]] }) =>
  [
    { match: rest, containers: containers.rest },
    { match: { method: 'POST' as const, url: URLS.graphql, friendlyName: op }, containers: containers.graphql, graphql: true },
  ].map((d) => kind === 'activity-feed'
    ? defineEndpoint({ kind, match: d.match, response: ActivityFeedStories, project: projectActivityFeed,
      source: 'activity-feed', containers: d.containers,
      ...(d.graphql === true ? { sideLists: { pendingPreview: JSON_PATHS.activityFeedPendingPreview } } : {}) })
    : defineEndpoint({ kind, match: d.match, response: ListPageBody, project: projectListPage,
      source: 'friend-requests', containers: d.containers,
      ...(d.graphql === true ? { rootFields: FOLLOW_REQUESTS_ROOT_FIELDS } : {}) }));

export const SURFACE_DOC_2026_08_12: SurfaceDocument = {
  id: VERSION,
  origin: IG_ORIGIN,
  appId: IG_APP_ID,
  userAgent: IG_USER_AGENT,
  pageSizes: { listPage: LIST_PAGE_COUNT },
  // ORDER MATTERS: `friendship-show` is tested before `show-many`/the list
  // endpoints (all live under `/friendships/`, and `show/<pk>/` also contains a
  // numeric segment).
  endpoints: [
    defineEndpoint({
      kind: 'friendship-show',
      match: { method: 'GET', url: URLS.friendshipShow, ids: { pk: URLS.friendshipShowPk } },
      response: FriendshipShowBody,
      project: projectFriendshipShow,
      containers: CONTAINERS.friendshipShow,
    }),
    defineEndpoint({
      kind: 'show-many',
      match: { method: 'POST', url: URLS.showMany },
      response: ShowManyBody,
      project: projectShowMany,
      source: 'show-many',
      containers: CONTAINERS.showMany,
    }),
    listEndpoint('followers-list', URLS.followersList, URLS.followersListTargetPk, 'followers-list'),
    listEndpoint('following-list', URLS.followingList, URLS.followingListTargetPk, 'following-list'),
    // The document drives both profile containers (flipped in order, spec §10.3); `/users/<pk>/info/` is retired.
    defineEndpoint({
      kind: 'profile-info',
      match: { method: 'GET', url: URLS.profileInfo, ids: { pk: URLS.profileInfoPk } },
      response: ProfileRecord,
      project: projectProfileUser,
      source: 'profile',
      containers: CONTAINERS.profileInfo,
    }),
    // OBSERVE-ONLY: `/api/graphql` carries dozens of unrelated Polaris queries,
    // so this endpoint matches only when the request's friendly-name header
    // names the profile query. Without that guard every GraphQL response on the
    // page would route here and log drift.
    defineEndpoint({
      kind: 'profile-graphql',
      match: {
        method: 'POST',
        url: URLS.graphql,
        friendlyName: PROFILE_GRAPHQL_FRIENDLY_NAME,
      },
      response: ProfileRecord,
      project: projectProfileUser,
      source: 'profile',
      containers: CONTAINERS.profileGraphql,
    }),
    // The notifications drawer (GraphQL since 2026-11; live 2026-11-02), each beside its REST form.
    ...drawerEndpoint('activity-feed', { method: 'POST', url: URLS.activityFeed }, ACTIVITY_FEED_GRAPHQL_FRIENDLY_NAME,
      { rest: CONTAINERS.feedRest, graphql: CONTAINERS.feedGraphql }),
    ...drawerEndpoint('friend-requests', { method: 'GET', url: URLS.friendRequests }, FOLLOW_REQUESTS_GRAPHQL_FRIENDLY_NAME,
      { rest: CONTAINERS.requestsRest, graphql: CONTAINERS.requestsGraphql }),
  ],
  mutations: MUTATIONS,
  controls: CONTROLS,
  signals: SIGNALS,
  read: {
    transport: TRANSPORT,
    graphql: GRAPHQL,
    continuation: CONTINUATION,
    recovery: RECOVERY_DECL,
    signatures: MUTATION_REFUSAL_SIGNATURES,
    expected: EXPECTED_KEYS,
    novelty: NOVELTY_BASELINE,
  },
};

/** Re-exported so the mutation verdict reader has one import site. */
export { MUTATION_JSON };

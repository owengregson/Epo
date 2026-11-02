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

import { z } from 'zod';
import type { Source } from '@/store/types';
import {
  ActivityFeedGraphqlBody,
  ActivityFeedStories,
  FollowRequestsGraphqlBody,
  FriendshipShowBody,
  ListPageBody,
  ProfileGraphqlBody,
  ProfileInfoBody,
  ShowManyBody,
} from '@/surface/schema/endpoints';
import {
  defineEndpoint,
  type MutationSpec,
  type Signal,
  type SurfaceDocument,
} from '@/surface/schema/surface';
import { CONTROLS } from '@/surface/versions/2026-08-12/controls';
import {
  ACTIVITY_FEED_GRAPHQL_FRIENDLY_NAME,
  FOLLOW_REQUESTS_GRAPHQL_FRIENDLY_NAME,
  IG_APP_ID,
  IG_ORIGIN,
  IG_USER_AGENT,
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
  projectProfileGraphql,
  projectProfileInfo,
  projectShowMany,
} from '@/surface/versions/2026-08-12/projectors';

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

/**
 * The notifications drawer's reads, normalised. Since 2026-11 its client reads
 * the feed and the follow-requests panel through GraphQL; the bodies wrap the
 * very same stories and `pending/` rows, so each GraphQL branch is unwrapped to
 * the REST shape here and the projectors are shared.
 */
const FeedBody = z.union([
  ActivityFeedGraphqlBody.transform((b) => b.data.xdt_activity_inbox),
  ActivityFeedStories,
]);
const RequestsBody = z.union([
  FollowRequestsGraphqlBody.transform(({ data }) => {
    const { edges, page_info: info } = data.xdt_friendships_pending_users.users;
    return {
      users: edges.map((e) => e.node),
      next_max_id: info?.end_cursor ?? null,
      has_more: info?.has_next_page === true,
    };
  }),
  ListPageBody,
]);

const listEndpoint = (
  kind: 'followers-list' | 'following-list' | 'friend-requests',
  url: RegExp,
  targetPk: RegExp | undefined,
  source: Source,
) =>
  defineEndpoint({
    kind,
    mode: 'observe',
    match: { method: 'GET', url, ids: targetPk ? { targetPk } : undefined },
    response: ListPageBody,
    project: projectListPage,
    source,
  });

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
      mode: 'observe',
      match: { method: 'GET', url: URLS.friendshipShow, ids: { pk: URLS.friendshipShowPk } },
      response: FriendshipShowBody,
      project: projectFriendshipShow,
    }),
    defineEndpoint({
      kind: 'show-many',
      mode: 'observe',
      match: { method: 'POST', url: URLS.showMany },
      response: ShowManyBody,
      project: projectShowMany,
      source: 'show-many',
    }),
    listEndpoint('followers-list', URLS.followersList, URLS.followersListTargetPk, 'followers-list'),
    listEndpoint('following-list', URLS.followingList, URLS.followingListTargetPk, 'following-list'),
    defineEndpoint({
      kind: 'profile-info',
      mode: 'observe',
      match: { method: 'GET', url: URLS.profileInfo, ids: { pk: URLS.profileInfoPk } },
      response: ProfileInfoBody,
      project: projectProfileInfo,
      source: 'profile',
    }),
    // OBSERVE-ONLY: `/api/graphql` carries dozens of unrelated Polaris queries,
    // so this endpoint matches only when the request's friendly-name header
    // names the profile query. Without that guard every GraphQL response on the
    // page would route here and log drift.
    defineEndpoint({
      kind: 'profile-graphql',
      mode: 'observe',
      match: {
        method: 'POST',
        url: URLS.profileGraphql,
        friendlyName: PROFILE_GRAPHQL_FRIENDLY_NAME,
      },
      response: ProfileGraphqlBody,
      project: projectProfileGraphql,
      source: 'profile',
    }),
    defineEndpoint({
      kind: 'activity-feed',
      mode: 'observe',
      match: { method: 'POST', url: URLS.activityFeed },
      response: FeedBody,
      project: projectActivityFeed,
      source: 'activity-feed',
    }),
    // The notifications drawer's GraphQL reads (since 2026-11; live 2026-11-02):
    // the same feed stories and request rows, matched by their operation names.
    defineEndpoint({
      kind: 'activity-feed',
      mode: 'observe',
      match: { method: 'POST', url: URLS.graphql, friendlyName: ACTIVITY_FEED_GRAPHQL_FRIENDLY_NAME },
      response: FeedBody,
      project: projectActivityFeed,
      source: 'activity-feed',
    }),
    ...[URLS.friendRequests, URLS.graphql].map((url) =>
      defineEndpoint({
        kind: 'friend-requests',
        mode: 'observe',
        match: url === URLS.graphql
          ? { method: 'POST', url, friendlyName: FOLLOW_REQUESTS_GRAPHQL_FRIENDLY_NAME }
          : { method: 'GET', url },
        response: RequestsBody,
        project: projectListPage,
        source: 'friend-requests',
      }),
    ),
  ],
  mutations: MUTATIONS,
  controls: CONTROLS,
  signals: SIGNALS,
};

/** Re-exported so the mutation verdict reader has one import site. */
export { MUTATION_JSON };

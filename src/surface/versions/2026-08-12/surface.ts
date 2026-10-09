/**
 * The Instagram surface DOCUMENT — capture 2026-08-12.
 *
 * Endpoints (match + response schema + `project()`), mutations, control
 * descriptors, signals and page sizes, as data. Every literal it uses comes
 * from `./literals.ts`; this file supplies only the STRUCTURE.
 *
 * `project()` is pure and synchronous by contract — that is what makes the
 * replay contract test (`tests/surface/replay.test.ts`) trivial and what keeps
 * enrichment out of the parse path. Each projector emits ONE fact per row so a
 * consumer writes through as it iterates (PRINCIPLES §1); it never returns a
 * completeness verdict, because completeness is the walker's to mint.
 */

import type { z } from 'zod';
import type { Source } from '@/store/types';
import {
  ActivityFeedBody,
  FriendshipShowBody,
  ListPageBody,
  ListUserRow,
  ProfileGraphqlBody,
  ProfileInfoBody,
  type ProfileUser,
  ShowManyBody,
  ShowManyStatus,
} from '@/surface/schema/endpoints';
import {
  defineEndpoint,
  emptyProjection,
  type MutationSpec,
  type ProjectCtx,
  type Projection,
  type RowIssue,
  type Signal,
  type SurfaceDocument,
} from '@/surface/schema/surface';
import { CONTROLS } from '@/surface/versions/2026-08-12/controls';
import {
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

// ---------------------------------------------------------------------------
// Row helpers — the ONLY place a projector reaches into a row
// ---------------------------------------------------------------------------

/** Coerce an observed pk (string on most endpoints, number on `pending/`) to a string. */
const pkString = (v: string | number): string => String(v);

/**
 * Parse one row through `schema`, recording a {@link RowIssue} instead of
 * rejecting the whole page. A single malformed row must not cost the other
 * rows' facts (§1) — but it must not vanish either, so it is COUNTED.
 */
function parseRow<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  index: number,
  issues: RowIssue[],
): T | null {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  issues.push({
    index,
    path: first?.path.map(String).join('.') || '(root)',
    message: first?.message ?? 'row rejected',
  });
  return null;
}

// ---------------------------------------------------------------------------
// Projectors
// ---------------------------------------------------------------------------

/** One paginated friendships page → one observation per user row. */
const projectListPage = (body: z.infer<typeof ListPageBody>, ctx: ProjectCtx): Projection => {
  const out = emptyProjection();
  body.users.forEach((raw, index) => {
    const row = parseRow(ListUserRow, raw, index, out.rowIssues);
    if (row === null) return;
    out.facts.push({
      accountPk: pkString(row.pk),
      observedAt: ctx.at,
      source: ctx.source,
      fields: {
        username: row.username,
        isPrivate: row.is_private,
        isVerified: row.is_verified,
      },
    });
  });
  const next = body.next_max_id;
  // A cursor is a non-empty STRING. `null`/absent/'' all mean no next page —
  // and a numeric cursor (seen on some captures) stringifies to one.
  out.cursor = next === null || next === undefined || next === '' ? null : String(next);
  // More-pages detection must survive whichever flag this response carries:
  // `has_more`, the alternate `big_list`, or neither — a present cursor ALWAYS
  // means another page exists. A false negative here truncates a whole scan.
  out.hasMore = body.has_more === true || body.big_list === true || out.cursor !== null;
  return out;
};

/** The batched relationship map → one relationship fact per pk. */
const projectShowMany = (body: z.infer<typeof ShowManyBody>, _ctx: ProjectCtx): Projection => {
  const out = emptyProjection();
  Object.entries(body.friendship_statuses).forEach(([pk, raw], index) => {
    const status = parseRow(ShowManyStatus, raw, index, out.rowIssues);
    if (status === null) return;
    out.relationships.push({
      pk,
      following: status.following === true,
      // A pending request to a private account: `following` is false but the
      // relationship is OURS — consumers must not read it as "not following".
      outgoingRequest: status.outgoing_request === true,
      // This shape carries NO followed-by direction. `null`, never `false`.
      followedBy: null,
      isPrivate: status.is_private,
    });
  });
  return out;
};

/** The single-relationship shape → one relationship fact, both directions. */
const projectFriendshipShow = (
  body: z.infer<typeof FriendshipShowBody>,
  ctx: ProjectCtx,
): Projection => {
  const out = emptyProjection();
  out.relationships.push({
    pk: ctx.pk ?? '',
    following: body.following === true,
    followedBy: body.followed_by === true,
    outgoingRequest: body.outgoing_request === true,
    isPrivate: body.is_private,
  });
  return out;
};

/**
 * One profile user record → one observation (+ the viewer relationship when the
 * source carries it). Shared by both profile endpoints: `/users/<pk>/info/` and
 * the observed GraphQL profile query answer the same field names under
 * different containers.
 *
 * A record carrying neither `pk` nor `id` is DRIFT, not a profile — it is
 * counted as a row issue and yields no fact, so a reshaped body can never
 * become an observation against an empty pk.
 */
const projectProfileUser = (user: ProfileUser, ctx: ProjectCtx, out: Projection): void => {
  // Instagram spells "no value" as `null` on these fields, and an Observation
  // field spells it `undefined` — so every optional value is narrowed once,
  // here, rather than each call site coping with three states.
  const some = <T>(v: T | null | undefined): T | undefined => v ?? undefined;
  const id = user.pk ?? user.id;
  if (id === undefined || id === null) {
    out.rowIssues.push({
      index: 0,
      path: 'pk',
      message: 'profile user carries neither `pk` nor `id`',
    });
    return;
  }
  const pk = pkString(id);
  out.absent = false;
  out.facts.push({
    accountPk: pk,
    observedAt: ctx.at,
    source: ctx.source,
    fields: {
      username: some(user.username),
      followers: some(user.follower_count),
      following: some(user.following_count),
      mutuals: some(user.mutual_followers_count),
      isPrivate: some(user.is_private),
      isVerified: some(user.is_verified),
      bio: some(user.biography),
    },
  });
  // Viewer-side relationship: GraphQL profile bodies carry it, `/users/<pk>/
  // info/` does not. Absent means UNKNOWN — never a fabricated `false`.
  const fs = user.friendship_status;
  if (fs !== null && fs !== undefined && typeof fs.following === 'boolean') {
    out.relationships.push({
      pk,
      following: fs.following,
      outgoingRequest: fs.outgoing_request === true,
      followedBy: typeof fs.followed_by === 'boolean' ? fs.followed_by : null,
      isPrivate: some(user.is_private),
    });
  }
};

/** `/users/<pk>/info/` → one profile observation, or "the profile is gone". */
const projectProfileInfo = (body: z.infer<typeof ProfileInfoBody>, ctx: ProjectCtx): Projection => {
  const out = emptyProjection();
  if (body.user === null) {
    // The `user` key exists and is empty: Instagram is saying the profile is
    // gone. A body WITHOUT the key never reaches here — the schema rejects it,
    // so a soft-block body can never be read as a deletion.
    out.absent = true;
    return out;
  }
  projectProfileUser(body.user, ctx, out);
  return out;
};

/** The OBSERVED GraphQL profile body → the same projection, `data`-wrapped. */
const projectProfileGraphql = (
  body: z.infer<typeof ProfileGraphqlBody>,
  ctx: ProjectCtx,
): Projection => {
  const out = emptyProjection();
  const user = body.data.user;
  if (user === null || user === undefined) {
    out.absent = true;
    return out;
  }
  projectProfileUser(user, ctx, out);
  return out;
};

/**
 * The news inbox → the "started following you" events it carries. An entry
 * qualifies through EITHER signal — the numeric follow `story_type` or the text
 * matcher — so a drift in one does not blind the follow-back watcher.
 */
const projectActivityFeed = (
  body: z.infer<typeof ActivityFeedBody>,
  _ctx: ProjectCtx,
): Projection => {
  const out = emptyProjection();
  const p = JSON_PATHS.activityFeed;
  let index = 0;
  for (const section of [body.new_stories, body.old_stories]) {
    if (!Array.isArray(section)) continue;
    for (const entry of section) {
      const i = index++;
      const args = entry.args;
      if (args === undefined) continue;
      const isFollow =
        entry.story_type === p.followStoryType ||
        (typeof args.text === 'string' && p.followText.test(args.text));
      if (!isFollow) continue;
      if (args.profile_id === undefined) {
        out.rowIssues.push({ index: i, path: 'args.profile_id', message: 'follow story with no pk' });
        continue;
      }
      out.events.push({
        pk: pkString(args.profile_id),
        username: typeof args.profile_name === 'string' && args.profile_name !== ''
          ? args.profile_name
          : null,
        atMs: typeof args.timestamp === 'number' ? Math.round(args.timestamp * 1000) : null,
      });
    }
  }
  return out;
};

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
      response: ActivityFeedBody,
      project: projectActivityFeed,
      source: 'activity-feed',
    }),
    listEndpoint('friend-requests', URLS.friendRequests, undefined, 'friend-requests'),
  ],
  mutations: MUTATIONS,
  controls: CONTROLS,
  signals: SIGNALS,
};

/** Re-exported so the mutation verdict reader has one import site. */
export { MUTATION_JSON };

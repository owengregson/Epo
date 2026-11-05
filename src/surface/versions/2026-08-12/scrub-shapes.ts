/**
 * The scrub and novelty shapes of this capture. Novelty walks faithful twins of the response schemas (a key they
 * do not know is drift evidence); the scrubber walks wider twins that also declare every id alias, count, time
 * and container a real body carries, so a known field keeps a pseudonym instead of collapsing to its type name.
 */

import { z } from 'zod';
import type { EndpointKind } from '@/surface/schema/endpoints';
import {
  ActivityStory,
  ActivityStoryArgs,
  ListUserRow,
  ProfileUser,
  ShowManyStatus,
} from '@/surface/versions/2026-08-12/schemas';

type ScrubKind = 'pk' | 'url' | 'cursor' | 'count' | 'time';
const as = <T extends z.ZodType>(schema: T, kind: ScrubKind): T => schema.meta({ pii: kind }) as unknown as T;

// ---------------------------------------------------------------------------
// Novelty twins — what the response schemas know, containers typed
// ---------------------------------------------------------------------------

/**
 * A resume cursor is either a ROW OFFSET ("50") or an opaque server token. The offset form is provably
 * non-identity and survives verbatim; the opaque form is replaced by a synthetic token of the same shape.
 */
const cursorField = as(z.union([z.string(), z.number()]), 'cursor');

const listPage = (row: z.ZodType) =>
  z
    .object({
      users: z.array(row),
      next_max_id: cursorField.nullish(),
      has_more: z.boolean().optional(),
      big_list: z.boolean().optional(),
      page_size: z.number().optional(),
      status: z.string().optional(),
    })
    .loose();

const showMany = (status: z.ZodType) =>
  z.object({ friendship_statuses: z.record(z.string().meta({ pii: 'pk' }), status), status: z.string().optional() }).loose();

const FriendshipShow = z
  .object({
    following: z.boolean().optional(),
    followed_by: z.boolean().optional(),
    outgoing_request: z.boolean().optional(),
    incoming_request: z.boolean().optional(),
    is_private: z.boolean().optional(),
    status: z.string().optional(),
  })
  .loose();

const Stories = (story: z.ZodType) =>
  z.object({ new_stories: z.array(story).optional(), old_stories: z.array(story).optional() }).loose();

/** The scrub twin also declares the edge cursor, so its `null` stays `null` instead of a type name. */
const pendingConnection = (node: z.ZodType, edgeCursor = false) =>
  z
    .object({
      edges: z.array(z.object(edgeCursor ? { node, cursor: cursorField.nullish() } : { node }).loose()),
      page_info: z
        .object({ end_cursor: z.string().meta({ pii: 'cursor' }).nullish(), has_next_page: z.boolean().optional() })
        .loose()
        .optional(),
    })
    .loose();

/** The novelty shape for every endpoint kind (the ACTIVE response schemas' twins). */
export const NOVELTY_SHAPES: Record<EndpointKind, z.ZodType> = {
  'followers-list': listPage(ListUserRow),
  'following-list': listPage(ListUserRow),
  'friend-requests': z.union([
    z.object({ data: z.object({ xdt_friendships_pending_users: z.object({ users: pendingConnection(ListUserRow) })
      .loose() }).loose() }).loose(),
    listPage(ListUserRow),
  ]),
  'show-many': showMany(ShowManyStatus),
  'friendship-show': FriendshipShow,
  'profile-info': z.object({ user: ProfileUser.nullable(), status: z.string().optional() }).loose(),
  'profile-graphql': z.object({ data: z.object({ user: ProfileUser.nullish() }).loose(), status: z.string().optional() })
    .loose(),
  'activity-feed': z.union([
    z.object({ data: z.object({ xdt_activity_inbox: Stories(ActivityStory) }).loose() }).loose(),
    Stories(ActivityStory),
  ]),
};

// ---------------------------------------------------------------------------
// Scrub twins — every alias a pseudonym, counts rounded, times shifted
// ---------------------------------------------------------------------------

const pk = as(z.union([z.string(), z.number()]), 'pk');
const count = as(z.number(), 'count');
const url = as(z.string(), 'url');

/** The relationship booleans; an unknown boolean inside a known object survives as it is. */
const Friendship = z.object({}).loose();
/** GraphQL's envelope extras: the final flag survives, server timings collapse to their type. */
const Extensions = z.object({ is_final: z.boolean().optional() }).loose();
const Supervision = z.object({ id: pk.optional() }).loose();
const PicInfo = z.object({ url: url.optional() }).loose();

/** Every id spelling maps through the one pk table, so `pk`, `pk_id`, `id` and `strong_id__` still agree. */
const ids = {
  id: pk.optional(),
  pk_id: pk.optional(),
  strong_id__: pk.optional(),
  fbid_v2: pk.optional(),
  __typename: z.string().optional(),
  friendship_status: Friendship.nullish(),
  supervision_info: Supervision.nullish(),
  hd_profile_pic_url_info: PicInfo.optional(),
};
const UserRow = ListUserRow.extend(ids);
const ProfileRecord = ProfileUser.extend({
  ...ids,
  follower_count: count.nullish(),
  following_count: count.nullish(),
  mutual_followers_count: count.nullish(),
  media_count: count.nullish(),
  total_clips_count: count.nullish(),
});
const Story = ActivityStory.extend({
  pk: pk.optional(),
  __typename: z.string().optional(),
  args: ActivityStoryArgs.extend({
    timestamp: as(z.number(), 'time').optional(),
    users: z.array(UserRow).optional(),
    inline_follow: z.object({ user_info: UserRow.optional() }).loose().nullish(),
  }).optional(),
});
const Viewer = z.object({ user: z.object({ pk: pk.optional(), id: pk.optional(), supervision_info: Supervision.optional() })
  .loose().optional() }).loose();

/** The scrub shape for every endpoint kind. */
export const SCRUB_SHAPES: Record<EndpointKind, z.ZodType> = {
  'followers-list': listPage(UserRow),
  'following-list': listPage(UserRow),
  'friend-requests': z.union([
    z.object({ data: z.object({ xdt_friendships_pending_users: z.object({ users: pendingConnection(UserRow, true) }).loose() })
      .loose(), extensions: Extensions.optional() }).loose(),
    listPage(UserRow),
  ]),
  'show-many': showMany(ShowManyStatus),
  'friendship-show': FriendshipShow,
  'profile-info': z.object({ user: ProfileRecord.nullable(), status: z.string().optional() }).loose(),
  'profile-graphql': z.object({
    data: z.object({ user: ProfileRecord.nullish(), viewer: Viewer.optional() }).loose(),
    extensions: Extensions.optional(),
    status: z.string().optional(),
  }).loose(),
  'activity-feed': z.union([
    z.object({
      data: z.object({
        xdt_activity_inbox: Stories(Story),
        xdt_api__v1__friendships__pending: z.object({ users: z.array(UserRow) }).loose().optional(),
      }).loose(),
      extensions: Extensions.optional(),
    }).loose(),
    Stories(Story),
  ]),
};

// ---------------------------------------------------------------------------
// Corpus paths — where the ingester trims rows and reads its facets
// ---------------------------------------------------------------------------

/** Where each body keeps its rows and the facts a corpus diversifies on (dotted paths; no values). */
export const CORPUS_PATHS = {
  /** Row arrays: ingestion keeps the first few rows of each, the fingerprint buckets their length. */
  rows: {
    'activity-feed': ['data.xdt_activity_inbox.new_stories', 'data.xdt_activity_inbox.old_stories', 'new_stories',
      'old_stories'],
    'friend-requests': ['data.xdt_friendships_pending_users.users.edges', 'users'],
  } as Partial<Record<EndpointKind, readonly string[]>>,
  profileRelationship: 'data.user.friendship_status',
  profilePrivate: 'data.user.is_private',
  profileMutuals: 'data.user.mutual_followers_count',
  storyType: 'story_type',
  /** A request variable: whether the drawer asked for one filter of the feed. */
  feedFilter: 'selected_filters',
  requestsHasNext: 'data.xdt_friendships_pending_users.users.page_info.has_next_page',
} as const;

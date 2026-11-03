/**
 * The scrub and novelty shapes of capture 2026-08-12: faithful twins of the
 * response schemas with typed row containers. Re-exported by `lab/shape.ts`.
 */

import { z } from 'zod';
import type { EndpointKind } from '@/surface/schema/endpoints';
import {
  ActivityStory,
  ListUserRow,
  ProfileUser,
  ShowManyStatus,
} from '@/surface/versions/2026-08-12/schemas';

// ---------------------------------------------------------------------------
// Scrub shapes — the schemas the SCRUBBER walks
// ---------------------------------------------------------------------------

/**
 * The response schemas describe row containers as `z.array(z.unknown())` /
 * `z.record(…, z.unknown())`, because a malformed row must not reject a whole
 * page (see the version document). The scrubber needs the row shapes to keep
 * a row's known fields, so it walks these faithful twins instead — same fields,
 * containers typed.
 */
const ListPageScrub = z
  .object({
    users: z.array(ListUserRow),
    // A resume cursor is either a ROW OFFSET ("50") or an opaque server token.
    // The offset form is provably non-identity and survives verbatim; the
    // opaque form is an encrypted blob nobody can vouch for, so it is replaced
    // by a synthetic token of the same shape (see `Scrubber.pii('cursor')`).
    next_max_id: z
      .union([z.string(), z.number()])
      .meta({ pii: 'cursor' })
      .nullish(),
    has_more: z.boolean().optional(),
    big_list: z.boolean().optional(),
    page_size: z.number().optional(),
    status: z.string().optional(),
  })
  .loose();

const ShowManyScrub = z
  .object({
    friendship_statuses: z.record(
      z.string().meta({ pii: 'pk' }),
      ShowManyStatus,
    ),
    status: z.string().optional(),
  })
  .loose();

const FriendshipShowScrub = z
  .object({
    following: z.boolean().optional(),
    followed_by: z.boolean().optional(),
    outgoing_request: z.boolean().optional(),
    incoming_request: z.boolean().optional(),
    is_private: z.boolean().optional(),
    status: z.string().optional(),
  })
  .loose();

const ProfileInfoScrub = z
  .object({
    user: ProfileUser.nullable(),
    status: z.string().optional(),
  })
  .loose();

const ProfileGraphqlScrub = z
  .object({
    data: z.object({ user: ProfileUser.nullish() }).loose(),
    status: z.string().optional(),
  })
  .loose();

const ActivityStoriesScrub = z
  .object({
    new_stories: z.array(ActivityStory).optional(),
    old_stories: z.array(ActivityStory).optional(),
  })
  .loose();
/** The REST inbox, or the drawer's GraphQL feed wrapping it (since 2026-11). */
const ActivityFeedScrub = z.union([
  z.object({ data: z.object({ xdt_activity_inbox: ActivityStoriesScrub }).loose() }).loose(),
  ActivityStoriesScrub,
]);
/** `pending/`, or the GraphQL requests panel carrying the same rows as nodes (since 2026-11). */
const FriendRequestsScrub = z.union([
  z.object({ data: z.object({ xdt_friendships_pending_users: z.object({ users: z.object({
    edges: z.array(z.object({ node: ListUserRow }).loose()),
    page_info: z.object({ end_cursor: z.string().meta({ pii: 'cursor' }).nullish() }).loose().optional(),
  }).loose() }).loose() }).loose() }).loose(),
  ListPageScrub,
]);

/** The scrub shape for every endpoint kind. */
export const SCRUB_SHAPES: Record<EndpointKind, z.ZodType> = {
  'followers-list': ListPageScrub,
  'following-list': ListPageScrub,
  'friend-requests': FriendRequestsScrub,
  'show-many': ShowManyScrub,
  'friendship-show': FriendshipShowScrub,
  'profile-info': ProfileInfoScrub,
  'profile-graphql': ProfileGraphqlScrub,
  'activity-feed': ActivityFeedScrub,
};

/** The novelty shape for every endpoint kind (the ACTIVE response schemas' twins). */
export const NOVELTY_SHAPES: Record<EndpointKind, z.ZodType> = SCRUB_SHAPES;

/**
 * Per-endpoint RESPONSE SCHEMAS — the parse half of the surface document.
 *
 * Each read endpoint Instagram exposes gets one zod schema here. The schema IS
 * the extractor's contract: `safeParse` failure yields a structural
 * {@link SurfaceMismatch} carrying the issue path, which is strictly more
 * diagnosable than the bare `SHAPE_MISMATCH` sentinel and — per ADR 0303 —
 * *cannot* collapse into the typed empty result, because a mismatch is a
 * different type.
 *
 * Two properties of the shapes here are load-bearing and both were read off the
 * LOCAL 2026-08-12 capture rather than guessed:
 *
 *  - `pk` arrives as a STRING on the friendships-list endpoints and as a NUMBER
 *    on `friendships/pending/`. The union + transform is not defensiveness; it
 *    is the observed shape.
 *  - Row containers are `z.array(z.unknown())` at the envelope level and are
 *    parsed ROW BY ROW inside `project()`. A single malformed row must never
 *    reject a whole page: the legacy extractor skipped it, §1 says the other
 *    rows are facts already paid for, and a rejected row is reported as a
 *    counted `rowIssue` (drift evidence) instead of being silently dropped.
 *
 * PII is declared WHERE THE FIELD IS DECLARED (`.meta({ pii })`). That metadata
 * is what makes the fixture scrubber an allow-list rather than a deny-list:
 * `src/surface/lab/scrub.ts` walks the JSON-Schema projection of these schemas
 * and only a field the schema knows about survives with a real (pseudonymised)
 * value.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// PII vocabulary
// ---------------------------------------------------------------------------

/** The PII classes the scrubber knows how to replace with a stable pseudonym. */
export const PII_KINDS = ['handle', 'name', 'pk', 'url', 'text', 'cursor'] as const;
export type PiiKind = (typeof PII_KINDS)[number];

/** Attach a PII class to a schema (recorded in zod's global registry). */
const pii = <T extends z.ZodType>(schema: T, kind: PiiKind): T =>
  schema.meta({ pii: kind }) as unknown as T;

/** A pk as Instagram sends it: string on most endpoints, number on `pending/`. */
const PkField = pii(z.union([z.string(), z.number()]), 'pk');

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * One user row of a friendships list (`followers/`, `following/`, `pending/`).
 * `.loose()` keeps unknown keys so the NOVELTY pass can see a new field weeks
 * before it becomes a break — zod strips unknown keys by default, which would
 * hide the earliest drift signal there is.
 */
export const ListUserRow = z
  .object({
    pk: PkField,
    username: pii(z.string(), 'handle').optional(),
    full_name: pii(z.string(), 'name').optional(),
    is_private: z.boolean().optional(),
    is_verified: z.boolean().optional(),
    profile_pic_url: pii(z.string(), 'url').optional(),
  })
  .loose();
export type ListUserRow = z.infer<typeof ListUserRow>;

/** One entry of the batched relationship map (`friendships/show_many/`). */
export const ShowManyStatus = z
  .object({
    following: z.boolean().optional(),
    is_private: z.boolean().optional(),
    outgoing_request: z.boolean().optional(),
    incoming_request: z.boolean().optional(),
  })
  .loose();
export type ShowManyStatus = z.infer<typeof ShowManyStatus>;

/** One activity-feed story entry's arguments. */
export const ActivityStoryArgs = z
  .object({
    profile_id: PkField.optional(),
    profile_name: pii(z.string(), 'handle').optional(),
    /** Epoch SECONDS (float) — the feed's own unit. */
    timestamp: z.number().optional(),
    text: pii(z.string(), 'text').optional(),
  })
  .loose();

/** One activity-feed story. */
export const ActivityStory = z
  .object({
    story_type: z.number().optional(),
    args: ActivityStoryArgs.optional(),
  })
  .loose();

// ---------------------------------------------------------------------------
// Response bodies
// ---------------------------------------------------------------------------

/**
 * A paginated friendships list. Shared by `followers/`, `following/` and
 * `pending/` — verified identical in the 2026-08-12 corpus, where `pending/`
 * additionally carries `friend_requests: {}` and some `followers/` pages carry
 * `groups` / `more_groups_available`. Unknown keys are kept, not stripped.
 */
export const ListPageBody = z
  .object({
    users: z.array(z.unknown()),
    next_max_id: z.union([z.string(), z.number()]).nullish(),
    has_more: z.boolean().optional(),
    big_list: z.boolean().optional(),
  })
  .loose();
export type ListPageBody = z.infer<typeof ListPageBody>;

/** The batched relationship map. */
export const ShowManyBody = z
  .object({
    friendship_statuses: z.record(z.string(), z.unknown()),
  })
  .loose();
export type ShowManyBody = z.infer<typeof ShowManyBody>;

/**
 * The single-relationship shape. `following` / `followed_by` are the two keys
 * ADR 0303 requires to be PRESENT: an error body (`{"status":"fail"}`) that
 * parsed cleanly to all-false would be a FALSE "we do not follow them" fact
 * that terminates held records downstream. Requiring one of them is the
 * structural form of that guard, so the schema — not a hand-written check —
 * enforces it.
 */
export const FriendshipShowBody = z
  .object({
    following: z.boolean().optional(),
    followed_by: z.boolean().optional(),
    outgoing_request: z.boolean().optional(),
    incoming_request: z.boolean().optional(),
    is_private: z.boolean().optional(),
  })
  .loose()
  .refine(
    (b) => typeof b.following === 'boolean' || typeof b.followed_by === 'boolean',
    { error: 'neither `following` nor `followed_by` is present — not a relationship body' },
  );
export type FriendshipShowBody = z.infer<typeof FriendshipShowBody>;

/**
 * The profile user record, shared by BOTH profile sources.
 *
 * `/api/v1/users/<pk>/info/` (what Epo fetches) and the GraphQL profile query
 * (what Instagram's own client fires, which Epo observes) carry the SAME field
 * names — only the container differs — so one row schema serves both. These are
 * the app-API names: the retired `web_profile_info` edge shape
 * (`edge_followed_by.count`) is gone with the endpoint.
 *
 * `pk` and `id` are both optional here because the two sources spell the id
 * differently (the info body answers `pk` as a number alongside a string `id`,
 * the GraphQL body a string `pk`). "At least one must be present" is enforced
 * by the projector, which answers a record carrying neither with a mismatch —
 * the row schema stays plain so the fixture scrubber can walk it like every
 * other row.
 */
export const ProfileUser = z
  .object({
    pk: PkField.optional(),
    id: PkField.optional(),
    username: pii(z.string(), 'handle').nullish(),
    biography: pii(z.string(), 'text').nullish(),
    follower_count: z.number().nullish(),
    following_count: z.number().nullish(),
    // NULLISH, not optional: Instagram sends an explicit `null` for the fields
    // that do not apply — both of these arrive null on your OWN profile (no
    // mutuals with yourself, no relationship to yourself). Verified live
    // 2026-09-18; declaring them non-nullable made the shadow parser reject a
    // body the extractor read correctly.
    mutual_followers_count: z.number().nullish(),
    media_count: z.number().nullish(),
    is_private: z.boolean().nullish(),
    is_verified: z.boolean().nullish(),
    /** Viewer-side relationship — GraphQL profile bodies only. */
    friendship_status: z
      .object({
        following: z.boolean().nullish(),
        followed_by: z.boolean().nullish(),
        outgoing_request: z.boolean().nullish(),
      })
      .loose()
      .nullish(),
    full_name: pii(z.string(), 'name').nullish(),
    profile_pic_url: pii(z.string(), 'url').nullish(),
  })
  .loose();
export type ProfileUser = z.infer<typeof ProfileUser>;

/**
 * `/api/v1/users/<pk>/info/`. The `user` key must EXIST — that is what tells
 * "Instagram says the profile is gone" apart from a soft-block body, which is a
 * mismatch (ADR 0303). A genuinely missing profile answers 404 with
 * `{"status":"fail"}`, classified as `gone` before a body is ever parsed.
 */
export const ProfileInfoBody = z
  .object({
    user: ProfileUser.nullable(),
  })
  .loose();
export type ProfileInfoBody = z.infer<typeof ProfileInfoBody>;

/**
 * The GraphQL profile body (OBSERVED, never composed by Epo). Same `data`
 * container invariant the retired endpoint had: present-with-empty-user is
 * "gone", absent container is drift.
 */
export const ProfileGraphqlBody = z
  .object({
    data: z.object({ user: ProfileUser.nullish() }).loose(),
  })
  .loose();
export type ProfileGraphqlBody = z.infer<typeof ProfileGraphqlBody>;

/**
 * The news inbox. At least one of the story containers must be an array —
 * an empty feed is a VALID "no recent follows" result, a body carrying neither
 * container is drift.
 */
export const ActivityFeedBody = z
  .object({
    new_stories: z.array(ActivityStory).optional(),
    old_stories: z.array(ActivityStory).optional(),
  })
  .loose()
  .refine((b) => Array.isArray(b.new_stories) || Array.isArray(b.old_stories), {
    error: 'no story container (`new_stories` / `old_stories`) present',
  });
export type ActivityFeedBody = z.infer<typeof ActivityFeedBody>;

/** The mutation (follow / unfollow) verdict body, REST form. */
export const MutationBody = z
  .object({
    status: z.enum(['ok', 'fail']),
    result: z.string().optional(),
    message: z.string().optional(),
    spam: z.boolean().optional(),
    feedback_title: pii(z.string(), 'text').optional(),
    feedback_message: pii(z.string(), 'text').optional(),
  })
  .loose();
export type MutationBody = z.infer<typeof MutationBody>;

/**
 * Every response schema, keyed by the endpoint kind that routes to it. The
 * scrubber and the novelty pass both walk this map, so a new endpoint is
 * covered by both the moment its schema lands here.
 */
export const RESPONSE_SCHEMAS = {
  'followers-list': ListPageBody,
  'following-list': ListPageBody,
  'friend-requests': ListPageBody,
  'show-many': ShowManyBody,
  'friendship-show': FriendshipShowBody,
  'profile-info': ProfileInfoBody,
  'profile-graphql': ProfileGraphqlBody,
  'activity-feed': ActivityFeedBody,
} as const;

/** The endpoint kinds the surface document routes. */
export type EndpointKind = keyof typeof RESPONSE_SCHEMAS;

/** Every row-level schema, for the scrubber's per-row walk. */
export const ROW_SCHEMAS = {
  'list-user': ListUserRow,
  'show-many-status': ShowManyStatus,
  'profile-user': ProfileUser,
  'activity-story': ActivityStory,
  mutation: MutationBody,
} as const;

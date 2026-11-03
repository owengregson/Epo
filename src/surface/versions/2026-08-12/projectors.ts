/**
 * The Instagram surface's PROJECTORS — capture 2026-08-12.
 *
 * Pure, synchronous `project()` functions, one per endpoint shape, plus the row
 * helpers they share. Split out of `./surface.ts` (2026-11-02) when the
 * notifications drawer's GraphQL reads joined the document; the document still
 * owns which endpoint uses which projector. Each projector emits ONE fact per
 * row so a consumer writes through as it iterates (PRINCIPLES §1), and never a
 * completeness verdict — completeness is the walker's to mint.
 */

import type { z } from 'zod';
import { emptyProjection, type ProjectCtx, type Projection, type RowIssue } from '@/surface/schema/surface';
import { JSON_PATHS } from '@/surface/versions/2026-08-12/literals';
import {
  type ActivityFeedStories,
  type FriendshipShowBody,
  type ListPageBody,
  ListUserRow,
  type ProfileGraphqlBody,
  type ProfileInfoBody,
  type ProfileUser,
  type ShowManyBody,
  ShowManyStatus,
} from '@/surface/versions/2026-08-12/schemas';

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
export const projectListPage = (body: z.infer<typeof ListPageBody>, ctx: ProjectCtx): Projection => {
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
export const projectShowMany = (body: z.infer<typeof ShowManyBody>, _ctx: ProjectCtx): Projection => {
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
export const projectFriendshipShow = (
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
export const projectProfileInfo = (body: z.infer<typeof ProfileInfoBody>, ctx: ProjectCtx): Projection => {
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
export const projectProfileGraphql = (
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
export const projectActivityFeed = (
  body: z.infer<typeof ActivityFeedStories>,
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

/**
 * The Instagram surface's PROJECTORS — capture 2026-08-12.
 *
 * Pure, synchronous `project()` functions, one per container shape. Each reads its record field by
 * field through `read/fields.ts` (I1–I10): ids from allow-listed keys with agreement, counts as one
 * pair, booleans and text by presence, relationships tri-state. A row that does not read is a counted
 * row issue, a field that does not read a field issue; each projector emits ONE fact per row so a
 * consumer writes through as it iterates (PRINCIPLES §1), and never a completeness verdict.
 */

import type { Observation } from '@/store/types';
import { continuationOf } from '@/surface/read/continuation';
import {
  idOf, jsonTypeOf, readBool, readCountPair, readEpochSeconds, readId, readRelationshipPresence, readTextPresence, valueAt,
} from '@/surface/read/fields';
import { readRelationship } from '@/surface/read/relationship';
import type { FieldIssue, FollowEvent, NormalizeStep, Presence } from '@/surface/schema/projection';
import { emptyProjection, type ProjectCtx, type Projection } from '@/surface/schema/surface';
import { CONTINUATION } from '@/surface/versions/2026-08-12/continuation-decl';
import { JSON_PATHS } from '@/surface/versions/2026-08-12/literals';
import { RECOVERY_DECL } from '@/surface/versions/2026-08-12/recovery-decl';
import type {
  ActivityFeedStories, FriendshipShowBody, ListPageBody, ProfileRecord, ShowManyBody,
} from '@/surface/versions/2026-08-12/schemas';

const REL = JSON_PATHS.relationship;
const ROW = JSON_PATHS.followersList;
const PROFILE = JSON_PATHS.profileUser;
const FEED = JSON_PATHS.activityFeed;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Record a normalized step once per (kind, pattern). */
function noteStep(ctx: ProjectCtx, step: NormalizeStep): void {
  if (ctx.steps === undefined || ctx.steps.some((s) => s.kind === step.kind && s.at === step.at)) return;
  ctx.steps.push(step);
}

/** A boolean field: its value, or `undefined` with an issue when present but not a boolean. */
function flagOf(record: Record<string, unknown>, key: string, path: string, out: Projection): boolean | undefined {
  const b = readBool(record, key);
  if ('value' in b) return b.value;
  if (b.presence === 'invalid') out.fieldIssues.push({ path, kind: 'invalid', got: jsonTypeOf(record[key]) });
  return undefined;
}

/** A text field ('' included): its value, or `undefined` with an issue when present but not text. */
function textOf(record: Record<string, unknown>, key: string, path: string, out: Projection): string | undefined {
  const v = record[key];
  if (typeof v === 'string') return v;
  if (readTextPresence(record, key) === 'invalid') out.fieldIssues.push({ path, kind: 'invalid', got: jsonTypeOf(v) });
  return undefined;
}

/** One user row (I1, I2): an id from the allow-listed keys, its handle and flags; `null` when it does not read. */
export function userRowOf(raw: unknown, index: number, rows: string, ctx: ProjectCtx, out: Projection,
  source: Observation['source'] = ctx.source): Observation | null {
  if (!isRecord(raw)) {
    out.rowIssues.push({ index, path: '(row)', message: `the row is ${jsonTypeOf(raw)}` });
    return null;
  }
  const id = readId(raw, RECOVERY_DECL);
  if ('issue' in id) {
    out.rowIssues.push({ index, path: id.issue.path, message: id.issue.kind });
    return null;
  }
  if (id.step !== undefined) noteStep(ctx, { ...id.step, at: `${rows}[].${id.step.at}` });
  return { accountPk: id.pk, observedAt: ctx.at, source, fields: {
    username: textOf(raw, RECOVERY_DECL.handleKey, `${rows}[].${RECOVERY_DECL.handleKey}`, out),
    isPrivate: flagOf(raw, ROW.isPrivate, `${rows}[].${ROW.isPrivate}`, out),
    isVerified: flagOf(raw, ROW.isVerified, `${rows}[].${ROW.isVerified}`, out),
  } };
}

/** One friendships page (the list endpoints, the requests panel) → one observation per row + its continuation. */
export const projectListPage = (page: ListPageBody, ctx: ProjectCtx): Projection => {
  const out = emptyProjection();
  page.users.forEach((raw, index) => {
    const obs = userRowOf(raw, index, CONTINUATION.rowsKey, ctx, out);
    if (obs !== null) out.facts.push(obs);
  });
  const { continuation, steps } = continuationOf(page, CONTINUATION, { final: ctx.final ?? null });
  for (const step of steps) noteStep(ctx, step);
  out.continuation = continuation;
  out.cursor = continuation.kind === 'next' ? continuation.cursor : null;
  out.hasMore = continuation.kind !== 'end';
  // No cursor and no more-flag at all: an end without evidence, and the flag's absence is drift.
  if (continuation.kind === 'end' && continuation.evidence === 'no-flags') {
    out.fieldIssues.push({ path: CONTINUATION.moreFlags.join('|'), kind: 'expected-absent', got: 'absent' });
  }
  return out;
};

/** The batched relationship map → one tri-state relationship fact per pk (this shape has no followed-by). */
export const projectShowMany = (body: ShowManyBody, _ctx: ProjectCtx): Projection => {
  const out = emptyProjection();
  Object.entries(body.friendship_statuses).forEach(([key, raw], index) => {
    const pk = idOf(key);
    if (pk === null || !isRecord(raw)) {
      out.rowIssues.push({ index, path: pk === null ? '(key)' : '(row)', message: pk === null ? 'id-space' : 'not an object' });
      return;
    }
    const isPrivate = flagOf(raw, JSON_PATHS.showMany.isPrivate, `friendship_statuses.*.${JSON_PATHS.showMany.isPrivate}`, out);
    out.relationships.push({ ...readRelationship(raw, REL, pk), followedBy: null, isPrivate });
  });
  return out;
};

/** The single-relationship shape → one relationship fact, both directions, for the URL's subject pk. */
export const projectFriendshipShow = (body: FriendshipShowBody, ctx: ProjectCtx): Projection => {
  const out = emptyProjection();
  const pk = ctx.pk === undefined ? null : idOf(ctx.pk);
  if (pk === null) {
    out.rowIssues.push({ index: 0, path: 'pk', message: 'the request URL names no subject' });
    return out;
  }
  const isPrivate = flagOf(body, JSON_PATHS.friendshipShow.isPrivate, JSON_PATHS.friendshipShow.isPrivate, out);
  out.relationships.push({ ...readRelationship(body, REL, pk), isPrivate });
  return out;
};

/** Whose session read the profile: the body's own viewer record, else the caller's (I10). */
function viewerOf(ctx: ProjectCtx): string | null {
  const viewer = valueAt(ctx.root, JSON_PATHS.profileViewerAt);
  const id = isRecord(viewer) ? readId(viewer, RECOVERY_DECL) : null;
  return id !== null && !('issue' in id) ? id.pk : (ctx.viewerPk ?? null);
}

const pairPresence = (pair: ReturnType<typeof readCountPair>): Presence =>
  pair === null ? 'absent' : !('issue' in pair) ? 'read' : pair.issue.kind === 'counts-partial' ? 'partial' : 'invalid';

/**
 * One profile record → one observation, its presence, and the viewer relationship when the record
 * carries one. Shared by both profile containers (`user`, `data.user`); a record with no readable id
 * is a row issue and yields no fact, so a reshaped body never becomes an observation.
 */
export const projectProfileUser = (record: ProfileRecord, ctx: ProjectCtx): Projection => {
  const out = emptyProjection();
  const id = readId(record, RECOVERY_DECL);
  if ('issue' in id) {
    out.rowIssues.push({ index: 0, path: id.issue.path, message: id.issue.kind });
    return out;
  }
  if (id.step !== undefined) noteStep(ctx, id.step);
  const pair = readCountPair(record, RECOVERY_DECL.profileCountKeys);
  const counts = pair === null || 'issue' in pair ? null : pair;
  if (pair !== null && 'issue' in pair) out.fieldIssues.push(pair.issue);
  for (const step of counts?.steps ?? []) noteStep(ctx, step);
  const viewerPk = viewerOf(ctx);
  const relationship = readRelationshipPresence(record, PROFILE.friendshipStatus, id.pk, viewerPk);
  const fs = record[PROFILE.friendshipStatus];
  const isPrivate = flagOf(record, PROFILE.isPrivate, PROFILE.isPrivate, out);
  if (relationship === 'read' && isRecord(fs)) out.relationships.push({ ...readRelationship(fs, REL, id.pk), isPrivate });
  const issue: FieldIssue['kind'] | null = relationship === 'null' ? 'unexpected-null' : relationship === 'invalid' ? 'invalid' : null;
  if (issue !== null) out.fieldIssues.push({ path: PROFILE.friendshipStatus, kind: issue, got: jsonTypeOf(fs) });
  const flagPresence = (key: string): Presence => {
    const b = readBool(record, key);
    return 'value' in b ? 'read' : b.presence;
  };
  out.presence = { counts: pairPresence(pair), bio: readTextPresence(record, PROFILE.biography),
    isPrivate: flagPresence(PROFILE.isPrivate), isVerified: flagPresence(PROFILE.isVerified), relationship };
  out.absent = false;
  out.viewerPk = viewerPk;
  out.facts.push({ accountPk: id.pk, observedAt: ctx.at, source: ctx.source, fields: {
    username: textOf(record, RECOVERY_DECL.handleKey, RECOVERY_DECL.handleKey, out),
    followers: counts?.followers, following: counts?.following, mutuals: counts?.mutuals,
    isPrivate, isVerified: flagOf(record, PROFILE.isVerified, PROFILE.isVerified, out),
    bio: textOf(record, PROFILE.biography, PROFILE.biography, out),
  } });
  return out;
};

/** A story's type as decimal text; a digit string is a retype step, any other kind none. */
function storyTypeOf(raw: Record<string, unknown>, at: string, ctx: ProjectCtx): string | null {
  const v = raw[FEED.storyType];
  if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v);
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
  noteStep(ctx, { kind: 'retype', at, detail: 'string' });
  return v;
}

/** One story (I7, I9): a follow event when its type or text says so, its actor from the agreeing ids. */
function storyEventOf(raw: unknown, index: number, section: string, ctx: ProjectCtx, out: Projection): FollowEvent | null {
  if (!isRecord(raw)) {
    out.rowIssues.push({ index, path: '(row)', message: `the story is ${jsonTypeOf(raw)}` });
    return null;
  }
  const typeAt = `${section}[].${FEED.storyType}`;
  const type = storyTypeOf(raw, typeAt, ctx);
  if (type !== null && !RECOVERY_DECL.knownStoryTypes.includes(type)) {
    out.fieldIssues.push({ path: typeAt, kind: 'enum-novel', got: jsonTypeOf(raw[FEED.storyType]) });
  }
  const text = valueAt(raw, `${FEED.args}.${FEED.text}`);
  const follow = (type !== null && RECOVERY_DECL.followStoryTypes.includes(type)) || (typeof text === 'string' && RECOVERY_DECL.followText.test(text));
  if (!follow) return null;
  const actor = readId(raw, { idKeys: [RECOVERY_DECL.storyActorKey, ...RECOVERY_DECL.storyActorAliases], foreignIdKeys: [] });
  if ('issue' in actor) {
    out.rowIssues.push({ index, path: actor.issue.path, message: actor.issue.kind });
    return null;
  }
  if (actor.step !== undefined) noteStep(ctx, { ...actor.step, at: `${section}[].${actor.step.at}` });
  const name = valueAt(raw, `${FEED.args}.${FEED.profileName}`);
  const stamp = valueAt(raw, `${FEED.args}.${FEED.timestamp}`);
  const time = stamp === undefined || stamp === null ? null : readEpochSeconds(stamp, ctx.at, `${section}[].${FEED.args}.${FEED.timestamp}`);
  if (time !== null && 'issue' in time) out.fieldIssues.push(time.issue);
  return { pk: actor.pk, username: typeof name === 'string' && name !== '' ? name : null,
    atMs: time !== null && 'ms' in time ? time.ms : null };
}

/**
 * The news inbox → the "started following you" events it carries, story by story, plus (GraphQL
 * only) the side list of pending requesters, read row by row as presence — never a complete set.
 */
export const projectActivityFeed = (inbox: ActivityFeedStories, ctx: ProjectCtx): Projection => {
  const out = emptyProjection();
  let index = 0;
  for (const section of FEED.storySections) {
    const stories = (inbox as Record<string, unknown>)[section];
    if (!Array.isArray(stories)) continue;
    for (const raw of stories) {
      const event = storyEventOf(raw, index++, section, ctx, out);
      if (event !== null) out.events.push(event);
    }
  }
  const side = ctx.sideLists === undefined ? undefined : valueAt(ctx.root, ctx.sideLists.pendingPreview);
  if (Array.isArray(side)) {
    const preview = emptyProjection();
    side.forEach((raw, i) => {
      const obs = userRowOf(raw, i, CONTINUATION.rowsKey, ctx, preview, 'friend-requests');
      if (obs !== null) out.pendingPreview.push(obs);
    });
  }
  return out;
};

/**
 * This capture's eight hand-written response extractors, which the façade
 * (`2026-08-12.ts`) assembles into `SURFACE`.
 */

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
import type {
  FollowEvent,
  FollowersListResult,
  FriendshipShowResult,
  ProfileViewer,
  ShowManyEntry,
} from '@/adapter/surface-types';
import { activityFeedRoot, followRequestsPage } from '@/adapter/versions/2026-08-12.notifications';
import type { Observation } from '@/store/types';
import { continuationOf } from '@/surface/read/continuation';
import {
  type CountKeys,
  readBool,
  readCountPair,
  readRelationshipPresence,
  readTextPresence,
} from '@/surface/read/fields';
import { readRelationship } from '@/surface/read/relationship';
import type { ProfilePresence } from '@/surface/schema/projection';
import { CONTINUATION } from '@/surface/versions/2026-08-12/continuation-decl';
import { JSON_PATHS } from '@/surface/versions/2026-08-12/literals';

/** Every relationship flag is read by presence: a renamed key is unknown, never `false`. */
const REL = JSON_PATHS.relationship;
/** The profile's count keys, read as one atomic pair. */
const COUNT_KEYS: CountKeys = {
  followers: JSON_PATHS.profileUser.followersCount,
  following: JSON_PATHS.profileUser.followingCount,
  mutuals: JSON_PATHS.profileUser.mutualCount,
};

export function extractFollowersList(
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

  // A present cursor ALWAYS means another page; without one, the declared more-flags decide,
  // and a flag set with no cursor is drift — never an end (spec §10.4).
  const { continuation } = continuationOf(body, CONTINUATION, { final: null });
  const cursor = continuation.kind === 'next' ? continuation.cursor : null;
  const quarantined = users.length - observations.length;
  return { observations, cursor, hasMore: continuation.kind !== 'end', continuation, quarantined };
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

export function extractProfileInfo(body: unknown, at: number): Observation | null | ShapeMismatch {
  const user = profileUserOf(body);
  if (user === null || isShapeMismatch(user)) return user;

  const p = JSON_PATHS.profileUser;
  // `/users/<pk>/info/` sends `pk` as a NUMBER and `id` as its string twin;
  // the GraphQL body sends a string `pk`. Either spelling is the same id.
  const pk = asStringId(user[p.id]) ?? asStringId(user[p.altId]);
  if (pk === null) return SHAPE_MISMATCH;
  // I5: the counts are an atomic pair — a partial pair stores no stat, a digit string is retyped.
  const pair = readCountPair(user, COUNT_KEYS);
  const counts = pair === null || 'issue' in pair ? null : pair;

  return {
    accountPk: pk,
    observedAt: at,
    source: 'profile',
    fields: {
      username: typeof user[p.username] === 'string'
        ? (user[p.username] as string)
        : undefined,
      followers: counts?.followers,
      following: counts?.following,
      mutuals: counts?.mutuals,
      isPrivate: asBool(user[p.isPrivate]),
      isVerified: asBool(user[p.isVerified]),
      bio: typeof user[p.biography] === 'string' ? (user[p.biography] as string) : undefined,
    },
  };
}

/**
 * The profile read's presence per decision-bearing field (spec §10.3): whether the count pair,
 * the bio and the flags were read, and whether a null relationship is the viewer's own record.
 */
export function extractProfilePresence(body: unknown, viewerPk: string | null): ProfilePresence | null {
  const user = profileUserOf(body);
  if (user === null || isShapeMismatch(user)) return null;
  const p = JSON_PATHS.profileUser;
  const pair = readCountPair(user, COUNT_KEYS);
  const flag = (key: string) => {
    const b = readBool(user, key);
    return 'value' in b ? 'read' : b.presence;
  };
  return {
    counts: pair === null ? 'absent' : !('issue' in pair) ? 'read' : pair.issue.kind === 'counts-partial' ? 'partial' : 'invalid',
    bio: readTextPresence(user, p.biography),
    isPrivate: flag(p.isPrivate),
    isVerified: flag(p.isVerified),
    relationship: readRelationshipPresence(user, p.friendshipStatus,
      asStringId(user[p.id]) ?? asStringId(user[p.altId]), viewerPk),
  };
}

/**
 * The viewer-side flags, each read by presence. Carried by the GraphQL profile body only —
 * `/users/<pk>/info/` omits `friendship_status` entirely, so every flag answers `null` (UNKNOWN).
 */
export function extractProfileViewer(body: unknown): ProfileViewer {
  const user = profileUserOf(body);
  const fs = user === null || isShapeMismatch(user) ? null : user[JSON_PATHS.profileUser.friendshipStatus];
  const r = readRelationship(isRecord(fs) ? fs : {}, REL, '');
  return { following: r.following, requested: r.outgoingRequest, followsUs: r.followedBy, incomingRequest: r.incomingRequest };
}

export function extractShowMany(body: unknown): ShowManyEntry[] | ShapeMismatch {
  if (!isRecord(body)) return SHAPE_MISMATCH;

  const p = JSON_PATHS.showMany;
  const statuses = getPath(body, p.statuses);
  if (!isRecord(statuses)) return SHAPE_MISMATCH;

  const out: ShowManyEntry[] = [];
  for (const [pk, status] of Object.entries(statuses)) {
    if (!isRecord(status)) continue;
    // A pending request to a private account (`outgoing_request`) is OUR relationship
    // too; this shape carries no followed-by direction.
    const { following, outgoingRequest, incomingRequest } = readRelationship(status, REL, pk);
    out.push({ pk, following, outgoingRequest, incomingRequest, isPrivate: asBool(status[p.isPrivate]) });
  }
  return out;
}

export function extractFriendshipShow(body: unknown, pk: string): FriendshipShowResult | ShapeMismatch {
  if (!isRecord(body)) return SHAPE_MISMATCH;
  const p = JSON_PATHS.friendshipShow;
  // Guard on the expected keys, not merely "is it an object": an error body
  // (e.g. {"status":"fail"}) would otherwise parse cleanly to all-false — a
  // FALSE "we do not follow them" fact that flows into the reconciler and
  // terminates held records. The interface contract demands SHAPE_MISMATCH so
  // "no relationship" and "unparsed" stay distinguishable.
  if (typeof body[REL.following] !== 'boolean' && typeof body[REL.followedBy] !== 'boolean') {
    return SHAPE_MISMATCH;
  }
  return { ...readRelationship(body, REL, pk), isPrivate: asBool(body[p.isPrivate]) };
}

/**
 * Parse the news-inbox (activity feed) body into "started following you"
 * events. An entry qualifies through EITHER signal — the numeric follow
 * `story_type` or the text matcher — so a drift in one doesn't blind the
 * follow-back watcher. `SHAPE_MISMATCH` when the body carries NONE of the
 * expected story containers (drift / error body); empty sections are a valid
 * "no recent follows" result.
 */
export function extractActivityFeed(raw: unknown): FollowEvent[] | ShapeMismatch {
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

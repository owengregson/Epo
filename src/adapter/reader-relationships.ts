/**
 * The Reader's relationship parses: the batched and single relationship shapes,
 * and the routing that turns an observed body into viewer-side relationship facts.
 */

import {
  type EndpointKind,
  type FriendshipShowResult,
  isShapeMismatch,
  type ProfileViewer,
  type ShowManyEntry,
  SURFACE,
} from '@/adapter/ig-surface';
import {
  coerceBody,
  compareFriendshipShow,
  compareShowMany,
  shadowRead,
  warnUnexpected,
} from '@/adapter/reader-shadow';
import type { ObservedRelation } from '@/shared/observed-relation';
import { mintObserved } from '@/surface/read/relationship';

/** A read the legacy extractors parsed: the declared container and keys, never partial. */
const LEGACY_READ = { tier: 'canonical', partial: false } as const;

/** The Reader members the relationship routing reads through. */
export interface RelationshipReader {
  matchEndpoint(url: string, friendlyName?: string): EndpointKind | null;
  extractPkFromUrl(url: string): string | null;
  parseShowMany(body: unknown, at: number): ShowManyEntry[];
  parseFriendshipShow(body: unknown, at: number, pk: string): FriendshipShowResult | null;
  parseProfileInfo(body: unknown, at: number, kind: 'profile-graphql'): { accountPk: string } | null;
  profileViewer(body: unknown, kind: 'profile-graphql'): ProfileViewer;
}

/**
 * Parse the batched relationship map. This shape reports only whether WE
 * follow each pk — it carries NO followed-by direction. Returns `[]` on
 * no-match.
 */
export function parseShowMany(body: unknown, _at: number): ShowManyEntry[] {
  const result = SURFACE.extractShowMany(coerceBody(body, 'show-many'));
  const mismatch = isShapeMismatch(result);
  const legacy = mismatch ? null : (result as ShowManyEntry[]);
  shadowRead('show-many', body, _at, 'show-many', mismatch, compareShowMany(legacy));
  if (legacy === null) {
    warnUnexpected('show-many', body);
    return [];
  }
  return legacy;
}

/**
 * Parse the single relationship shape into a both-directions result. The pk
 * is supplied by the caller (from the URL, via `Reader.extractPkFromUrl`)
 * because the body has none. An unexpected shape (`SHAPE_MISMATCH` from the
 * surface) is warned and mapped to the typed all-false no-match result — use
 * `SURFACE.extractFriendshipShow` directly when the caller needs to
 * distinguish "no relationship" from "unparsed".
 */
export function parseFriendshipShow(
  body: unknown,
  _at: number,
  pk: string,
): FriendshipShowResult | null {
  const result = SURFACE.extractFriendshipShow(coerceBody(body, 'friendship-show'), pk);
  const legacyShow = isShapeMismatch(result) ? null : (result as FriendshipShowResult);
  shadowRead('friendship-show', body, _at, 'show-many', legacyShow === null,
    compareFriendshipShow(legacyShow, pk), pk);
  if (isShapeMismatch(result)) {
    // An unexpected shape (error body, drift) must NOT map to all-false: a
    // false "we do not follow them" fact terminates held records downstream.
    warnUnexpected('friendship-show', body);
    return null;
  }
  return result;
}

/**
 * The endpoint kinds that actually carry viewer-side relationship facts —
 * the ONLY bodies worth the async read + parse in the reconciler. List pages
 * and the activity feed parse to nothing here.
 */
export function relationshipBearing(
  reader: RelationshipReader,
  url: string,
  friendlyName?: string,
): boolean {
  const kind = reader.matchEndpoint(url, friendlyName);
  // `profile-info` carries NO viewer-side relationship (`/users/<pk>/info/`
  // has no `friendship_status`); the observed GraphQL profile body does.
  return kind === 'show-many' || kind === 'friendship-show' || kind === 'profile-graphql';
}

/**
 * Relationship facts (whether WE own a follow/pending-request toward each pk) from a response
 * body, routed by endpoint, for the RelationshipReconciler. Each flag is read by presence and
 * the fact is minted only when `weFollow` is known: `following || outgoingRequest` is TRUE when
 * either key says so, FALSE only when both keys are present and false (spec §10.4). A pending
 * request to a private account is OUR relationship. `[]` on endpoints without a viewer side.
 */
export function relationshipFacts(
  reader: RelationshipReader,
  url: string,
  body: unknown,
  at: number,
  friendlyName?: string,
): ObservedRelation[] {
  switch (reader.matchEndpoint(url, friendlyName)) {
    case 'show-many':
      return mintObserved(LEGACY_READ, reader.parseShowMany(body, at).map((e) => ({ ...e, followedBy: null })));
    case 'friendship-show': {
      const pk = reader.extractPkFromUrl(url);
      const r = pk === null ? null : reader.parseFriendshipShow(body, at, pk);
      return r === null ? [] : mintObserved(LEGACY_READ, [r]); // unparsed ≠ "no relationship"
    }
    case 'profile-graphql': {
      const obs = reader.parseProfileInfo(body, at, 'profile-graphql');
      if (obs === null) return [];
      const v = reader.profileViewer(body, 'profile-graphql');
      return mintObserved(LEGACY_READ, [{ pk: obs.accountPk, following: v.following, outgoingRequest: v.requested,
        followedBy: v.followsUs, incomingRequest: v.incomingRequest ?? null }]);
    }
    default:
      return [];
  }
}

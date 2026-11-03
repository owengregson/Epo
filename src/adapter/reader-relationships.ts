/**
 * The Reader's legacy relationship parses (the endpoints still in `observe`): the batched and the
 * single relationship shapes, and the routing that turns an observed body into minted facts. The
 * document reads each body beside them (`reader-shadow.ts`).
 */

import {
  type EndpointKind,
  type FriendshipShowResult,
  isShapeMismatch,
  type ShowManyEntry,
  SURFACE,
} from '@/adapter/ig-surface';
import { coerceBody, shadowDocument, warnUnexpected } from '@/adapter/reader-shadow';
import type { ObservedRelation } from '@/shared/observed-relation';
import { mintObserved } from '@/surface/read/relationship';
import type { ReadEnv } from '@/surface/read/types';

/** A read the legacy extractors parsed: the declared container and keys, never partial. */
const LEGACY_READ = { tier: 'canonical', partial: false } as const;

/** The Reader members the relationship routing reads through. */
export interface RelationshipReader {
  matchEndpoint(url: string, friendlyName?: string): EndpointKind | null;
  extractPkFromUrl(url: string): string | null;
  parseShowMany(body: unknown, at: number): ShowManyEntry[];
  parseFriendshipShow(body: unknown, at: number, pk: string): FriendshipShowResult | null;
}

/** The batched relationship map (whether WE follow each pk; no followed-by direction). `[]` on no-match. */
export function parseShowMany(env: ReadEnv, body: unknown, at: number): ShowManyEntry[] {
  const json = coerceBody(body, 'show-many');
  const result = SURFACE.extractShowMany(json);
  shadowDocument(env, 'show-many', body, { at, source: 'show-many' }, json);
  if (isShapeMismatch(result)) {
    warnUnexpected('show-many', body);
    return [];
  }
  return result;
}

/**
 * The single relationship shape, both directions, for the URL's subject pk (the body has none).
 * An unexpected shape is `null`, never all-false: a false "we do not follow them" fact would
 * terminate held records downstream.
 */
export function parseFriendshipShow(env: ReadEnv, body: unknown, at: number, pk: string): FriendshipShowResult | null {
  const json = coerceBody(body, 'friendship-show');
  const result = SURFACE.extractFriendshipShow(json, pk);
  shadowDocument(env, 'friendship-show', body, { at, source: 'show-many', pk }, json);
  if (isShapeMismatch(result)) {
    warnUnexpected('friendship-show', body);
    return null;
  }
  return result;
}

/**
 * The endpoint kinds that carry viewer-side relationship facts — the ONLY bodies worth the async
 * read in the reconciler (`profile-info` has no `friendship_status`; the GraphQL profile does).
 */
export function relationshipBearing(reader: RelationshipReader, url: string, friendlyName?: string): boolean {
  const kind = reader.matchEndpoint(url, friendlyName);
  return kind === 'show-many' || kind === 'friendship-show' || kind === 'profile-graphql';
}

/**
 * Relationship facts (whether WE own a follow or a pending request toward each pk) from the batched
 * and single relationship bodies. Each flag is read by presence and a fact is minted only when
 * `weFollow` is known (spec §10.4). The document drives the profile body (`Reader.relationshipFacts(read)`).
 */
export function relationshipFacts(reader: RelationshipReader, url: string, body: unknown, at: number,
  friendlyName?: string): ObservedRelation[] {
  switch (reader.matchEndpoint(url, friendlyName)) {
    case 'show-many':
      return mintObserved(LEGACY_READ, reader.parseShowMany(body, at).map((e) => ({ ...e, followedBy: null })));
    case 'friendship-show': {
      const pk = reader.extractPkFromUrl(url);
      const r = pk === null ? null : reader.parseFriendshipShow(body, at, pk);
      return r === null ? [] : mintObserved(LEGACY_READ, [r]); // unparsed ≠ "no relationship"
    }
    default:
      return [];
  }
}

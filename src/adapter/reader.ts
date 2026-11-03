/**
 * Instagram Adapter — Reader.
 *
 * The read half of the versioned Instagram Adapter: it turns intercepted
 * network responses (see `src/adapter/tab.ts`) into typed `Observation`s for
 * the KnowledgeStore. It NEVER touches the DOM and NEVER issues requests — it
 * only parses bodies the tab already captured.
 *
 * Everything Instagram-specific (URL matchers, JSON paths, per-shape
 * extraction logic) lives behind the `SURFACE` interface
 * (`src/adapter/ig-surface.ts`, implemented in `src/adapter/versions/*`). When
 * Instagram changes shape, the version module is the one place to update; this
 * Reader is version-agnostic and carries zero Instagram literals.
 *
 * Robustness contract (per Global Constraints): no silent `catch {}`. Every
 * parser returns a typed empty/`null` result on no-match and logs a `warn`
 * (via `@/utils/logger`) when the surface reports an unexpected-but-nonempty
 * body (`SHAPE_MISMATCH`), so shape drift is loud rather than swallowed.
 */

import { isShapeMismatch, SURFACE } from '@/adapter/ig-surface';
import * as relationships from '@/adapter/reader-relationships';
import {
  coerceBody,
  compareActivityFeed,
  compareList,
  compareProfile,
  shadowRead,
  warnUnexpected,
} from '@/adapter/reader-shadow';
import type { ObservedRelation } from '@/shared/observed-relation';
import type { Observation } from '@/store/types';

// Re-export the stable result types so existing consumers keep one import site.
export type {
  EndpointKind,
  FollowEvent,
  FollowersListResult,
  FriendshipShowResult,
  ShowManyEntry,
} from '@/adapter/ig-surface';

import type {
  EndpointKind,
  FollowEvent,
  FollowersListResult,
  FriendshipShowResult,
  ProfileViewer,
  ShowManyEntry,
} from '@/adapter/ig-surface';

/** Which profile body a parse is reading — the two containers differ. */
export type ProfileKind = Extract<EndpointKind, 'profile-info' | 'profile-graphql'>;

export class Reader {
  /**
   * Route a response URL to the parser that handles it, or `null`. Ordering
   * concerns (e.g. `friendship-show` before `show-many`/`followers-list`)
   * live inside the versioned endpoint table.
   */
  matchEndpoint(url: string, friendlyName?: string): EndpointKind | null {
    return SURFACE.matchEndpoint(url, friendlyName);
  }

  /**
   * Route an OBSERVED response — URL plus the request headers the tab
   * recorded. Use this over {@link Reader.matchEndpoint} for passive traffic:
   * the GraphQL profile body is identified by its operation name, which lives
   * in a request header, and a URL-only match cannot see it.
   */
  kindOf(resp: { url: string; requestHeaders?: Record<string, string> }): EndpointKind | null {
    return SURFACE.matchEndpoint(resp.url, SURFACE.friendlyName(resp.requestHeaders));
  }

  /** The GraphQL operation name a request carried, read off its headers. */
  friendlyName(requestHeaders?: Record<string, string>): string | undefined {
    return SURFACE.friendlyName(requestHeaders);
  }

  /**
   * Whether an observed response's media type carries a parseable body. The
   * GraphQL profile body is `text/javascript`, so a json-only gate would drop
   * it — consumers ask the surface instead of testing a media type themselves.
   */
  parseableBody(mimeType: string): boolean {
    return SURFACE.parseableMime(mimeType);
  }

  /** The profile kind this observed response carries, or `null`. */
  profileKindOf(resp: { url: string; requestHeaders?: Record<string, string> }): ProfileKind | null {
    const kind = this.kindOf(resp);
    return kind === 'profile-info' || kind === 'profile-graphql' ? kind : null;
  }

  /**
   * Pull the target pk out of a `friendships/show/<pk>/` URL. The single-show
   * body carries no pk of its own, so callers pass this through to
   * {@link parseFriendshipShow}.
   */
  extractPkFromUrl(url: string): string | null {
    return SURFACE.extractIds('friendship-show', url).pk ?? null;
  }

  /**
   * Pull the target pk out of a followers-list URL. The followers-list body
   * carries the follower rows but not the target's own pk, so acquisition
   * derives the follower→target edge from this URL the first time a page
   * matches (profile-info is enrichment only). Returns `null` on a
   * non-matching URL.
   */
  extractTargetPkFromFollowersUrl(url: string): string | null {
    return SURFACE.extractIds('followers-list', url).targetPk ?? null;
  }

  /**
   * Pull the target pk out of a following-list URL (the account whose FOLLOWING
   * list is paginating). Mirrors {@link extractTargetPkFromFollowersUrl};
   * returns `null` on a non-matching URL.
   */
  extractTargetPkFromFollowingUrl(url: string): string | null {
    return SURFACE.extractIds('following-list', url).targetPk ?? null;
  }

  /**
   * STRICT parse of one paginated followers page: the typed result on a
   * well-formed page, `null` on SHAPE_MISMATCH — so the list walks can tell IG
   * shape drift apart from a genuinely empty page. The typed empty result
   * (`{observations: [], cursor: null, hasMore: false}`) is the END-OF-LIST
   * shape: a drifted page collapsing to it would fabricate an end-of-list
   * claim, and downstream completeness verdicts (the prune census's
   * lost-follower marking, growth's exhaustion advance) would act on it.
   */
  parseFollowersListStrict(body: unknown, at: number): FollowersListResult | null {
    const result = SURFACE.extractFollowersList(coerceBody(body, 'followers-list'), at);
    const legacy = isShapeMismatch(result) ? null : result;
    shadowRead('followers-list', body, at, 'followers-list', legacy === null,
      compareList(legacy));
    if (legacy === null) {
      warnUnexpected('followers-list', body);
      return null;
    }
    return legacy;
  }

  /**
   * STRICT parse of one paginated FOLLOWING page (`null` on SHAPE_MISMATCH —
   * see {@link parseFollowersListStrict}). The following-list body carries the
   * exact followers-list shape (a `users` array + `next_max_id`), so this is a
   * thin alias over the same extractor — kept separate so shape-drift warnings
   * name the endpoint that actually broke.
   */
  parseFollowingListStrict(body: unknown, at: number): FollowersListResult | null {
    const result = SURFACE.extractFollowersList(
      coerceBody(body, 'following-list'),
      at,
      'following-list',
    );
    const legacy = isShapeMismatch(result) ? null : result;
    shadowRead('following-list', body, at, 'following-list', legacy === null,
      compareList(legacy));
    if (legacy === null) {
      warnUnexpected('following-list', body);
      return null;
    }
    return legacy;
  }

  /**
   * Parse a profile body into a single profile observation (with follower and
   * following counts). Returns `null` when the body has no user.
   *
   * `kind` names WHICH profile body this is: `profile-info` (what Epo fetches
   * from `/users/<pk>/info/`) or `profile-graphql` (the query Instagram's own
   * client fires, observed during ordinary navigation). The records inside are
   * the same shape; only the container and the shadow-parse schema differ.
   */
  parseProfileInfo(
    body: unknown,
    at: number,
    kind: ProfileKind = 'profile-info',
  ): Observation | null {
    const result = SURFACE.extractProfileInfo(coerceBody(body, kind), at);
    const mismatch = isShapeMismatch(result);
    shadowRead(kind, body, at, 'profile', mismatch,
      compareProfile(mismatch ? null : (result as Observation | null)));
    if (mismatch) {
      warnUnexpected(kind, body);
      return null;
    }
    return result as Observation | null;
  }

  /**
   * Viewer-side flags from the GraphQL body's `friendship_status` (`/users/<pk>/info/`
   * has none; `null` when absent). `following` makes a PRIVATE account's followers readable.
   */
  profileViewer(body: unknown, kind: ProfileKind = 'profile-graphql'): ProfileViewer {
    return SURFACE.extractProfileViewer(coerceBody(body, kind));
  }

  /** Parse the batched relationship map (`reader-relationships.ts`). */
  parseShowMany(body: unknown, at: number): ShowManyEntry[] {
    return relationships.parseShowMany(body, at);
  }

  /** Parse the single relationship shape; `null` when unparsed (`reader-relationships.ts`). */
  parseFriendshipShow(body: unknown, at: number, pk: string): FriendshipShowResult | null {
    return relationships.parseFriendshipShow(body, at, pk);
  }

  /**
   * Parse the incoming follow-requests page (`friendships/pending/` — the
   * followers-list shape) into observations labelled with their own
   * provenance. Typed empty result on no-match.
   */
  parsePendingRequests(body: unknown, at: number): FollowersListResult {
    const empty: FollowersListResult = { observations: [], cursor: null, hasMore: false,
      continuation: { kind: 'end', evidence: 'no-flags' }, quarantined: 0 };
    const result = SURFACE.extractFollowersList(
      coerceBody(body, 'friend-requests'),
      at,
      'friend-requests',
    );
    const legacy = isShapeMismatch(result) ? null : result;
    shadowRead('friend-requests', body, at, 'friend-requests', legacy === null,
      compareList(legacy));
    if (legacy === null) {
      warnUnexpected('friend-requests', body);
      return empty;
    }
    return legacy;
  }

  /**
   * STRICT parse of the activity-feed (news inbox) body into the "started
   * following you" events it carries: `[]` on a well-formed empty feed, `null`
   * on a shape mismatch — so callers can tell IG shape drift apart from
   * "nobody new followed". A drifted body must never invent follow events, and
   * (via the null) must never masquerade as a successful empty check either.
   */
  parseActivityFeedStrict(body: unknown): FollowEvent[] | null {
    const result = SURFACE.extractActivityFeed(coerceBody(body, 'activity-feed'));
    const legacy = isShapeMismatch(result) ? null : (result as FollowEvent[]);
    shadowRead('activity-feed', body, Date.now(), 'activity-feed', legacy === null,
      compareActivityFeed(legacy));
    if (legacy === null) {
      warnUnexpected('activity-feed', body);
      return null;
    }
    return legacy;
  }

  /** Lenient variant for callers that only merge facts: drift collapses to `[]`. */
  parseActivityFeed(body: unknown): FollowEvent[] {
    return this.parseActivityFeedStrict(body) ?? [];
  }

  /** Whether this response's endpoint carries viewer-side relationship facts. */
  relationshipBearing(url: string, friendlyName?: string): boolean {
    return relationships.relationshipBearing(this, url, friendlyName);
  }

  /** Viewer-side relationship facts, presence-gated and minted (`reader-relationships.ts`). */
  relationshipFacts(url: string, body: unknown, at: number, friendlyName?: string): ObservedRelation[] {
    return relationships.relationshipFacts(this, url, body, at, friendlyName);
  }
}

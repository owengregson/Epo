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
import type { Observation } from '@/store/types';
import * as logger from '@/utils/logger';

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
  ShowManyEntry,
} from '@/adapter/ig-surface';

export class Reader {
  /**
   * Route a response URL to the parser that handles it, or `null`. Ordering
   * concerns (e.g. `friendship-show` before `show-many`/`followers-list`)
   * live inside the versioned endpoint table.
   */
  matchEndpoint(url: string): EndpointKind | null {
    return SURFACE.matchEndpoint(url);
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
    const result = SURFACE.extractFollowersList(this.coerce(body, 'followers-list'), at);
    if (isShapeMismatch(result)) {
      this.warnUnexpected('followers-list', body);
      return null;
    }
    return result;
  }

  /**
   * Parse one paginated followers page into observations plus the resume
   * cursor. Lenient variant for callers that only merge facts: drift collapses
   * to the typed empty result. Anything deriving an end-of-list or
   * completeness claim MUST use {@link parseFollowersListStrict} instead.
   */
  parseFollowersList(body: unknown, at: number): FollowersListResult {
    return (
      this.parseFollowersListStrict(body, at) ?? { observations: [], cursor: null, hasMore: false }
    );
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
      this.coerce(body, 'following-list'),
      at,
      'following-list',
    );
    if (isShapeMismatch(result)) {
      this.warnUnexpected('following-list', body);
      return null;
    }
    return result;
  }

  /**
   * Lenient FOLLOWING-page variant: drift collapses to the typed empty result.
   * Completeness-deriving callers use {@link parseFollowingListStrict}.
   */
  parseFollowingList(body: unknown, at: number): FollowersListResult {
    return (
      this.parseFollowingListStrict(body, at) ?? { observations: [], cursor: null, hasMore: false }
    );
  }

  /**
   * Parse a profile-info body into a single profile observation (with
   * follower and following counts). Returns `null` when the body has no user.
   */
  parseProfileInfo(body: unknown, at: number): Observation | null {
    const result = SURFACE.extractProfileInfo(this.coerce(body, 'web-profile-info'), at);
    if (isShapeMismatch(result)) {
      this.warnUnexpected('web-profile-info', body);
      return null;
    }
    return result;
  }

  /**
   * Whether the logged-in viewer already follows this profile, read from the
   * profile-info body. This is what decides whether a PRIVATE account's
   * followers are visible to us — we can read the followers of anyone we
   * follow. Returns `null` when the flag is absent.
   */
  profileFollowedByViewer(body: unknown): boolean | null {
    return SURFACE.extractProfileFollowedByViewer(this.coerce(body, 'web-profile-info'));
  }

  /**
   * Parse the batched relationship map. This shape reports only whether WE
   * follow each pk — it carries NO followed-by direction. Returns `[]` on
   * no-match.
   */
  parseShowMany(body: unknown, _at: number): ShowManyEntry[] {
    const result = SURFACE.extractShowMany(this.coerce(body, 'show-many'));
    if (isShapeMismatch(result)) {
      this.warnUnexpected('show-many', body);
      return [];
    }
    return result;
  }

  /**
   * Parse the single relationship shape into a both-directions result. The pk
   * is supplied by the caller (from the URL, via {@link extractPkFromUrl})
   * because the body has none. An unexpected shape (`SHAPE_MISMATCH` from the
   * surface) is warned and mapped to the typed all-false no-match result — use
   * `SURFACE.extractFriendshipShow` directly when the caller needs to
   * distinguish "no relationship" from "unparsed".
   */
  parseFriendshipShow(body: unknown, _at: number, pk: string): FriendshipShowResult | null {
    const result = SURFACE.extractFriendshipShow(this.coerce(body, 'friendship-show'), pk);
    if (isShapeMismatch(result)) {
      // An unexpected shape (error body, drift) must NOT map to all-false: a
      // false "we do not follow them" fact terminates held records downstream.
      this.warnUnexpected('friendship-show', body);
      return null;
    }
    return result;
  }

  /**
   * Parse the incoming follow-requests page (`friendships/pending/` — the
   * followers-list shape) into observations labelled with their own
   * provenance. Typed empty result on no-match.
   */
  parsePendingRequests(body: unknown, at: number): FollowersListResult {
    const empty: FollowersListResult = { observations: [], cursor: null, hasMore: false };
    const result = SURFACE.extractFollowersList(
      this.coerce(body, 'friend-requests'),
      at,
      'friend-requests',
    );
    if (isShapeMismatch(result)) {
      this.warnUnexpected('friend-requests', body);
      return empty;
    }
    return result;
  }

  /**
   * STRICT parse of the activity-feed (news inbox) body into the "started
   * following you" events it carries: `[]` on a well-formed empty feed, `null`
   * on a shape mismatch — so callers can tell IG shape drift apart from
   * "nobody new followed". A drifted body must never invent follow events, and
   * (via the null) must never masquerade as a successful empty check either.
   */
  parseActivityFeedStrict(body: unknown): FollowEvent[] | null {
    const result = SURFACE.extractActivityFeed(this.coerce(body, 'activity-feed'));
    if (isShapeMismatch(result)) {
      this.warnUnexpected('activity-feed', body);
      return null;
    }
    return result;
  }

  /** Lenient variant for callers that only merge facts: drift collapses to `[]`. */
  parseActivityFeed(body: unknown): FollowEvent[] {
    return this.parseActivityFeedStrict(body) ?? [];
  }

  /**
   * The endpoint kinds that actually carry viewer-side relationship facts —
   * the ONLY bodies worth the async read + parse in the reconciler. List pages
   * and the activity feed parse to nothing here.
   */
  relationshipBearing(url: string): boolean {
    const kind = this.matchEndpoint(url);
    return kind === 'show-many' || kind === 'friendship-show' || kind === 'web-profile-info';
  }

  /**
   * Relationship facts (whether WE own a follow/pending-request toward each pk)
   * from a response body, routed by endpoint. Pure; used by the
   * RelationshipReconciler to heal divergence caused by external follow/
   * unfollow changes. `[]` on any endpoint that carries no viewer-side
   * relationship (or on no-match).
   *
   * `weFollow` is `following || outgoingRequest`: a pending request to a
   * private account is OUR relationship — reporting it as "not following"
   * would make the reconciler destroy the follow record while the request
   * awaits acceptance.
   */
  relationshipFacts(
    url: string,
    body: unknown,
    at: number,
  ): Array<{ pk: string; weFollow: boolean }> {
    switch (this.matchEndpoint(url)) {
      case 'show-many':
        return this.parseShowMany(body, at).map((e) => ({
          pk: e.pk,
          weFollow: e.following || e.outgoingRequest,
        }));
      case 'friendship-show': {
        const pk = this.extractPkFromUrl(url);
        if (pk === null) return [];
        const r = this.parseFriendshipShow(body, at, pk);
        if (r === null) return []; // unparsed ≠ "no relationship"
        return [{ pk, weFollow: r.following || r.outgoingRequest }];
      }
      case 'web-profile-info': {
        const obs = this.parseProfileInfo(body, at);
        const followed = this.profileFollowedByViewer(body);
        const requested = SURFACE.extractProfileRequestedByViewer(
          this.coerce(body, 'web-profile-info'),
        );
        // Emit only when BOTH the pk and the viewer-side flag are present.
        if (obs === null || followed === null) return [];
        return [{ pk: obs.accountPk, weFollow: followed || requested === true }];
      }
      default:
        return [];
    }
  }

  /**
   * Accept either an already-parsed object or a raw JSON string (what
   * `TabResponse.getBody()` yields). A malformed string is logged (never
   * silently swallowed) and treated as no-match.
   */
  private coerce(body: unknown, kind: EndpointKind): unknown {
    if (typeof body !== 'string') return body;
    try {
      return JSON.parse(body);
    } catch (e) {
      logger.warn('reader.parse: body was not valid JSON', {
        kind,
        error: String(e),
      });
      return undefined;
    }
  }

  private warnUnexpected(kind: EndpointKind, body: unknown): void {
    const keys =
      typeof body === 'object' && body !== null ? Object.keys(body as object) : [];
    logger.warn('reader.parse: unexpected body shape', { kind, keys });
  }
}

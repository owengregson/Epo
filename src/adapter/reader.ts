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
import type { Observation, Source } from '@/store/types';
import type { Projection } from '@/surface/schema/surface';
import { shadowParse } from '@/surface/shadow';
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
    const result = SURFACE.extractFollowersList(this.coerce(body, 'followers-list'), at);
    const legacy = isShapeMismatch(result) ? null : result;
    this.shadow('followers-list', body, at, 'followers-list', legacy === null,
      Reader.compareList(legacy));
    if (legacy === null) {
      this.warnUnexpected('followers-list', body);
      return null;
    }
    return legacy;
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
    const legacy = isShapeMismatch(result) ? null : result;
    this.shadow('following-list', body, at, 'following-list', legacy === null,
      Reader.compareList(legacy));
    if (legacy === null) {
      this.warnUnexpected('following-list', body);
      return null;
    }
    return legacy;
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
    const result = SURFACE.extractProfileInfo(this.coerce(body, kind), at);
    const mismatch = isShapeMismatch(result);
    this.shadow(kind, body, at, 'profile', mismatch, (p) => {
      const legacy = mismatch ? null : (result as Observation | null);
      if (legacy === null) {
        return p.absent === true ? null : 'extractor read no profile, schema projected one';
      }
      const fact = p.facts[0];
      if (fact === undefined) return 'schema projected no profile, extractor read one';
      if (fact.accountPk !== legacy.accountPk) {
        return `pk ${fact.accountPk} vs ${legacy.accountPk}`;
      }
      if (fact.fields.followers !== legacy.fields.followers) {
        return `followers ${fact.fields.followers} vs ${legacy.fields.followers}`;
      }
      if (fact.fields.username !== legacy.fields.username) {
        return `username differs for ${fact.accountPk}`;
      }
      return null;
    });
    if (mismatch) {
      this.warnUnexpected(kind, body);
      return null;
    }
    return result as Observation | null;
  }

  /**
   * Viewer-side flags from the GraphQL body's `friendship_status` (`/users/<pk>/info/`
   * has none; `null` when absent). `following` makes a PRIVATE account's followers readable.
   */
  profileViewer(body: unknown, kind: ProfileKind = 'profile-graphql'): ProfileViewer {
    const json = this.coerce(body, kind);
    return {
      following: SURFACE.extractProfileFollowedByViewer(json),
      requested: SURFACE.extractProfileRequestedByViewer(json),
      followsUs: SURFACE.extractProfileFollowsViewer(json),
    };
  }

  /**
   * Parse the batched relationship map. This shape reports only whether WE
   * follow each pk — it carries NO followed-by direction. Returns `[]` on
   * no-match.
   */
  parseShowMany(body: unknown, _at: number): ShowManyEntry[] {
    const result = SURFACE.extractShowMany(this.coerce(body, 'show-many'));
    const mismatch = isShapeMismatch(result);
    const legacy = mismatch ? null : (result as ShowManyEntry[]);
    this.shadow('show-many', body, _at, 'show-many', mismatch, (p) => {
      if (legacy === null) return 'extractor reported a mismatch, schema parsed';
      if (p.relationships.length !== legacy.length) {
        return `rows ${p.relationships.length} vs ${legacy.length}`;
      }
      for (const row of p.relationships) {
        const twin = legacy.find((e) => e.pk === row.pk);
        if (twin === undefined) return `pk ${row.pk} missing from the extractor's rows`;
        if (twin.following !== row.following || twin.outgoingRequest !== row.outgoingRequest) {
          return `relationship differs for ${row.pk}`;
        }
      }
      return null;
    });
    if (legacy === null) {
      this.warnUnexpected('show-many', body);
      return [];
    }
    return legacy;
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
    const legacyShow = isShapeMismatch(result) ? null : (result as FriendshipShowResult);
    this.shadow('friendship-show', body, _at, 'show-many', legacyShow === null, (p) => {
      if (legacyShow === null) return 'extractor reported a mismatch, schema parsed';
      const row = p.relationships[0];
      if (row === undefined) return 'schema projected no relationship';
      if (
        row.following !== legacyShow.following ||
        row.followedBy !== legacyShow.followedBy ||
        row.outgoingRequest !== legacyShow.outgoingRequest
      ) {
        return `relationship differs for ${pk}`;
      }
      return null;
    }, pk);
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
    const legacy = isShapeMismatch(result) ? null : result;
    this.shadow('friend-requests', body, at, 'friend-requests', legacy === null,
      Reader.compareList(legacy));
    if (legacy === null) {
      this.warnUnexpected('friend-requests', body);
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
    const result = SURFACE.extractActivityFeed(this.coerce(body, 'activity-feed'));
    const legacy = isShapeMismatch(result) ? null : (result as FollowEvent[]);
    this.shadow('activity-feed', body, Date.now(), 'activity-feed', legacy === null, (p) => {
      if (legacy === null) return 'extractor reported a mismatch, schema parsed';
      if (p.events.length !== legacy.length) {
        return `events ${p.events.length} vs ${legacy.length}`;
      }
      const diverged = p.events.find((e, i) => legacy[i]?.pk !== e.pk);
      return diverged === undefined ? null : `event pk order diverges at ${diverged.pk}`;
    });
    if (legacy === null) {
      this.warnUnexpected('activity-feed', body);
      return null;
    }
    return legacy;
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
  relationshipBearing(url: string, friendlyName?: string): boolean {
    const kind = this.matchEndpoint(url, friendlyName);
    // `profile-info` carries NO viewer-side relationship (`/users/<pk>/info/`
    // has no `friendship_status`); the observed GraphQL profile body does.
    return kind === 'show-many' || kind === 'friendship-show' || kind === 'profile-graphql';
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
    friendlyName?: string,
  ): Array<{ pk: string; weFollow: boolean }> {
    switch (this.matchEndpoint(url, friendlyName)) {
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
      case 'profile-graphql': {
        const obs = this.parseProfileInfo(body, at, 'profile-graphql');
        const viewer = this.profileViewer(body, 'profile-graphql');
        // Emit only when BOTH the pk and the viewer-side flag are present.
        if (obs === null || viewer.following === null) return [];
        return [{ pk: obs.accountPk, weFollow: viewer.following || viewer.requested === true }];
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

  // -------------------------------------------------------------------------
  // Shadow parse (PHASE 1 of the surface migration)
  //
  // Every parse above still DRIVES BEHAVIOUR through the legacy extractor. The
  // calls below run the endpoint's zod schema over the same body and report a
  // disagreement — nothing more. That is what earns the right to flip an
  // endpoint's `mode` to `enforce`: real disagreement counts over real
  // sessions, per endpoint, reversible without a release.
  //
  // Wrapped so it can NEVER break the live path: a shadow parse that can throw
  // into a census walk is worse than no shadow parse at all.
  // -------------------------------------------------------------------------

  private shadow(
    kind: EndpointKind,
    body: unknown,
    at: number,
    source: Source,
    legacyMismatch: boolean,
    compare?: (p: Projection) => string | null,
    pk?: string,
  ): void {
    try {
      shadowParse({
        kind,
        body: this.coerce(body, kind),
        ctx: { at, source, pk },
        legacyMismatch,
        compare,
      });
    } catch (e) {
      logger.debug('reader.shadow: shadow parse failed', { kind, error: String(e) });
    }
  }

  /** Compare a list projection against the legacy list result. */
  private static compareList(
    legacy: FollowersListResult | null,
  ): (p: Projection) => string | null {
    return (p) => {
      if (legacy === null) return 'extractor reported a mismatch, schema parsed';
      const diffs: string[] = [];
      if (p.facts.length !== legacy.observations.length) {
        diffs.push(`rows ${p.facts.length} vs ${legacy.observations.length}`);
      }
      if (p.cursor !== legacy.cursor) diffs.push(`cursor ${p.cursor} vs ${legacy.cursor}`);
      if (p.hasMore !== legacy.hasMore) diffs.push(`hasMore ${p.hasMore} vs ${legacy.hasMore}`);
      const mismatchedPk = p.facts.find(
        (f, i) => legacy.observations[i]?.accountPk !== f.accountPk,
      );
      if (mismatchedPk !== undefined) diffs.push(`pk order diverges at ${mismatchedPk.accountPk}`);
      return diffs.length === 0 ? null : diffs.join(', ');
    };
  }

  private warnUnexpected(kind: EndpointKind, body: unknown): void {
    const keys =
      typeof body === 'object' && body !== null ? Object.keys(body as object) : [];
    logger.warn('reader.parse: unexpected body shape', { kind, keys });
  }
}

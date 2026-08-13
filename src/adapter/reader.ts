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

import * as logger from '@/utils/logger';
import { SURFACE, isShapeMismatch } from '@/adapter/ig-surface';
import type { Observation } from '@/store/types';

// Re-export the stable result types so existing consumers keep one import site.
export type {
  EndpointKind,
  FollowersListResult,
  FriendshipShowResult,
  ShowManyEntry,
} from '@/adapter/ig-surface';
import type { EndpointKind, FollowersListResult, FriendshipShowResult, ShowManyEntry } from '@/adapter/ig-surface';

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
   * Parse one paginated followers page into observations plus the resume
   * cursor. Returns a typed empty result on no-match.
   */
  parseFollowersList(body: unknown, at: number): FollowersListResult {
    const empty: FollowersListResult = { observations: [], cursor: null, hasMore: false };
    const result = SURFACE.extractFollowersList(this.coerce(body, 'followers-list'), at);
    if (isShapeMismatch(result)) {
      this.warnUnexpected('followers-list', body);
      return empty;
    }
    return result;
  }

  /**
   * Parse one paginated FOLLOWING page. The following-list body carries the
   * exact followers-list shape (a `users` array + `next_max_id`), so this is a
   * thin alias over the same extractor — kept separate so shape-drift warnings
   * name the endpoint that actually broke.
   */
  parseFollowingList(body: unknown, at: number): FollowersListResult {
    const empty: FollowersListResult = { observations: [], cursor: null, hasMore: false };
    const result = SURFACE.extractFollowersList(this.coerce(body, 'following-list'), at);
    if (isShapeMismatch(result)) {
      this.warnUnexpected('following-list', body);
      return empty;
    }
    return result;
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
  parseFriendshipShow(body: unknown, _at: number, pk: string): FriendshipShowResult {
    const result = SURFACE.extractFriendshipShow(this.coerce(body, 'friendship-show'), pk);
    if (isShapeMismatch(result)) {
      this.warnUnexpected('friendship-show', body);
      return { pk, following: false, followedBy: false, isPrivate: undefined };
    }
    return result;
  }

  /**
   * Relationship facts (whether WE follow each pk) from a response body, routed
   * by endpoint. Pure; used by the RelationshipReconciler to heal divergence
   * caused by external follow/unfollow changes. `[]` on any endpoint that
   * carries no viewer-side relationship (or on no-match).
   */
  relationshipFacts(
    url: string,
    body: unknown,
    at: number,
  ): Array<{ pk: string; weFollow: boolean }> {
    switch (this.matchEndpoint(url)) {
      case 'show-many':
        return this.parseShowMany(body, at).map((e) => ({ pk: e.pk, weFollow: e.following }));
      case 'friendship-show': {
        const pk = this.extractPkFromUrl(url);
        if (pk === null) return [];
        const r = this.parseFriendshipShow(body, at, pk);
        return [{ pk, weFollow: r.following }];
      }
      case 'web-profile-info': {
        const obs = this.parseProfileInfo(body, at);
        const followed = this.profileFollowedByViewer(body);
        // Emit only when BOTH the pk and the viewer-side flag are present.
        if (obs === null || followed === null) return [];
        return [{ pk: obs.accountPk, weFollow: followed }];
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

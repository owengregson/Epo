/**
 * Instagram Adapter — Reader.
 *
 * The read half of the versioned Instagram Adapter: it turns intercepted
 * network responses (see `src/adapter/tab.ts`) into typed `Observation`s for
 * the KnowledgeStore. It NEVER touches the DOM and NEVER issues requests — it
 * only parses bodies the tab already captured.
 *
 * Everything Instagram-specific (URL matchers, JSON paths) is imported from
 * `field-notes.ts`, the single source of truth. When Instagram changes shape,
 * that file is the one place to update; this Reader consumes it.
 *
 * Robustness contract (per Global Constraints): no silent `catch {}`. Every
 * parser returns a typed empty/`null` result on no-match and logs a `warn`
 * (via `@/utils/logger`) when it sees an unexpected-but-nonempty body, so shape
 * drift is loud rather than swallowed.
 */

import * as logger from '@/utils/logger';
import { ENDPOINTS, JSON_PATHS } from '@/adapter/field-notes';
import type { Observation } from '@/store/types';

/** The endpoint kinds the Reader knows how to route. */
export type EndpointKind =
  | 'followers-list'
  | 'show-many'
  | 'friendship-show'
  | 'profile-info'
  | 'activity-feed';

/** Result of parsing one paginated followers page. */
export interface FollowersListResult {
  observations: Observation[];
  /** Resume cursor (`next_max_id`); `null` when there is no next page. */
  cursor: string | null;
  hasMore: boolean;
}

/** One relationship row from the batched `show_many` shape (no `followed_by`). */
export interface ShowManyEntry {
  pk: string;
  following: boolean;
  isPrivate?: boolean;
}

/** The single `friendships/show/<pk>` shape — both directions known. */
export interface FriendshipShowResult {
  pk: string;
  following: boolean;
  /** `followed_by` => THEY follow us (the follow-back signal). */
  followedBy: boolean;
  isPrivate?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolve a dotted path (e.g. `data.user`, `edge_followed_by.count`). */
function getPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const key of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function asStringId(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export class Reader {
  /**
   * Route a response URL to the parser that handles it, or `null`.
   *
   * Order matters: `friendship-show` and `show-many` both live under
   * `/friendships/`, and a `show/<pk>/` URL also contains a numeric segment, so
   * the single-show matcher is tested BEFORE `show_many`/`followers`.
   */
  matchEndpoint(url: string): EndpointKind | null {
    if (ENDPOINTS.friendshipShow.test(url)) return 'friendship-show';
    if (ENDPOINTS.showMany.test(url)) return 'show-many';
    if (ENDPOINTS.followersList.test(url)) return 'followers-list';
    if (ENDPOINTS.webProfileInfo.test(url)) return 'profile-info';
    if (ENDPOINTS.activityFeed.test(url)) return 'activity-feed';
    return null;
  }

  /**
   * Pull the target pk out of a `friendships/show/<pk>/` URL. The single-show
   * body carries no pk of its own, so callers pass this through to
   * {@link parseFriendshipShow}.
   */
  extractPkFromUrl(url: string): string | null {
    const match = /\/friendships\/show\/(\d+)\//.exec(url);
    return match ? match[1] : null;
  }

  /**
   * Pull the target pk out of a `friendships/<pk>/followers/` URL. The
   * followers-list body carries the follower rows but not the target's own pk,
   * so acquisition derives the follower→target edge from this URL the first
   * time a page matches (profile-info is enrichment only). Mirrors
   * {@link extractPkFromUrl}; returns `null` on a non-matching URL.
   */
  extractTargetPkFromFollowersUrl(url: string): string | null {
    const match = /\/friendships\/(\d+)\/followers\//.exec(url);
    return match ? match[1] : null;
  }

  /**
   * Parse one paginated followers page into observations plus the resume
   * cursor. Returns a typed empty result on no-match.
   */
  parseFollowersList(body: unknown, at: number): FollowersListResult {
    const empty: FollowersListResult = { observations: [], cursor: null, hasMore: false };
    const root = this.coerce(body, 'followers-list');
    if (!isRecord(root)) return empty;

    const p = JSON_PATHS.followersList;
    const users = getPath(root, p.users);
    if (!Array.isArray(users)) {
      this.warnUnexpected('followers-list', p.users, root);
      return empty;
    }

    const observations: Observation[] = [];
    for (const entry of users) {
      if (!isRecord(entry)) continue;
      const pk = asStringId(entry[p.userPk]);
      if (pk === null) continue;
      observations.push({
        accountPk: pk,
        observedAt: at,
        source: 'followers-list',
        fields: {
          username: typeof entry[p.userName] === 'string'
            ? (entry[p.userName] as string)
            : undefined,
          isPrivate: asBool(entry[p.isPrivate]),
          isVerified: asBool(entry[p.isVerified]),
        },
      });
    }

    const nextMaxId = getPath(root, p.nextMaxId);
    const cursor = typeof nextMaxId === 'string' && nextMaxId.length > 0
      ? nextMaxId
      : null;
    return { observations, cursor, hasMore: getPath(root, p.hasMore) === true };
  }

  /**
   * Parse `web_profile_info` into a single profile observation (with follower
   * and following counts). Returns `null` when the body has no user.
   */
  parseProfileInfo(body: unknown, at: number): Observation | null {
    const root = this.coerce(body, 'profile-info');
    if (!isRecord(root)) return null;

    const p = JSON_PATHS.webProfileInfo;
    const user = getPath(root, p.user);
    if (!isRecord(user)) return null;

    const pk = asStringId(user[p.id]);
    if (pk === null) {
      this.warnUnexpected('profile-info', `${p.user}.${p.id}`, root);
      return null;
    }

    return {
      accountPk: pk,
      observedAt: at,
      source: 'profile',
      fields: {
        username: typeof user[p.username] === 'string'
          ? (user[p.username] as string)
          : undefined,
        followers: asCount(getPath(user, p.followersCount)),
        following: asCount(getPath(user, p.followingCount)),
        isPrivate: asBool(user[p.isPrivate]),
        isVerified: asBool(user[p.isVerified]),
      },
    };
  }

  /**
   * Parse the batched `show_many` relationship map. This shape reports only
   * whether WE follow each pk — it carries NO `followed_by`. Returns `[]` on
   * no-match.
   */
  parseShowMany(body: unknown, _at: number): ShowManyEntry[] {
    const root = this.coerce(body, 'show-many');
    if (!isRecord(root)) return [];

    const p = JSON_PATHS.showMany;
    const statuses = getPath(root, p.statuses);
    if (!isRecord(statuses)) {
      this.warnUnexpected('show-many', p.statuses, root);
      return [];
    }

    const out: ShowManyEntry[] = [];
    for (const [pk, status] of Object.entries(statuses)) {
      if (!isRecord(status)) continue;
      out.push({
        pk,
        following: status[p.following] === true,
        isPrivate: asBool(status[p.isPrivate]),
      });
    }
    return out;
  }

  /**
   * Parse the single `friendships/show/<pk>` shape into a both-directions
   * relationship. The pk is supplied by the caller (from the URL, via
   * {@link extractPkFromUrl}) because the body has none.
   */
  parseFriendshipShow(body: unknown, _at: number, pk: string): FriendshipShowResult {
    const root = this.coerce(body, 'friendship-show');
    const p = JSON_PATHS.friendshipShow;
    if (!isRecord(root)) {
      return { pk, following: false, followedBy: false, isPrivate: undefined };
    }
    return {
      pk,
      following: root[p.following] === true,
      followedBy: root[p.followedBy] === true,
      isPrivate: asBool(root[p.isPrivate]),
    };
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

  private warnUnexpected(kind: EndpointKind, path: string, root: Record<string, unknown>): void {
    logger.warn('reader.parse: unexpected body shape', {
      kind,
      missingPath: path,
      keys: Object.keys(root),
    });
  }
}

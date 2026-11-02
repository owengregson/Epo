/**
 * Instagram surface — capture 2026-08-12: the notifications drawer's bodies.
 *
 * Since 2026-11 (live 2026-11-02) the drawer's client reads its feed through
 * GraphQL `PolarisActivityFeedStoriesViewQuery` and its follow-requests panel
 * through `PolarisActivityFeedFollowRequestsViewQuery`. Both wrap the shapes the
 * REST endpoints served — the same stories, the same user rows — so each is
 * unwrapped here to that REST shape and the façade's extractors read either.
 * Split out of the façade (`2026-08-12.ts`) like the mutation module; no
 * Instagram literal of its own — every path comes from the literals module.
 */

import { getPath, isRecord } from '@/adapter/parse-helpers';
import { JSON_PATHS } from '@/surface/versions/2026-08-12/literals';

/** The feed's story container: the GraphQL wrapper's inner body, else the body itself. */
export function activityFeedRoot(body: unknown): unknown {
  const inner = getPath(body, JSON_PATHS.activityFeedGraphql);
  return isRecord(inner) ? inner : body;
}

/**
 * The follow-requests page as the list shape: a GraphQL connection becomes
 * `{ users, next_max_id, has_more }`; anything else is returned untouched.
 */
export function followRequestsPage(body: unknown): unknown {
  const g = JSON_PATHS.followRequestsGraphql;
  const edges = getPath(body, g.edges);
  if (!Array.isArray(edges)) return body;
  const l = JSON_PATHS.followersList;
  const cursor = getPath(body, g.cursor);
  return {
    [l.users]: edges.map((edge) => getPath(edge, g.node)),
    [l.nextMaxId]: typeof cursor === 'string' ? cursor : null,
    [l.hasMore]: getPath(body, g.hasMore) === true,
  };
}

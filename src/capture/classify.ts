/**
 * Pure URL classification for the Task E capture harness.
 *
 * Endpoint routing comes from the active `SURFACE` version module (the single
 * home of Instagram URL knowledge); on top of it the harness keeps a few
 * BROADER capture-only heuristics (also owned by the version module as
 * `CAPTURE_PATTERNS`) because it runs against LIVE Instagram and must decide
 * what a response *probably* is from its URL alone, promptly, in the network
 * handler — before the body is fetched.
 */

import { SURFACE } from '@/adapter/ig-surface';
import { CAPTURE_PATTERNS } from '@/adapter/versions/2026-08-12';

export type Classification =
  | 'friendship-show'
  | 'followers-list'
  | 'following-list'
  | 'friend-requests'
  | 'show-many'
  | 'profile-info'
  | 'activity-feed'
  | 'graphql-other'
  | 'mutation-follow'
  | 'mutation-unfollow'
  | 'mutation-suspect'
  | 'other';

/**
 * Best-effort classification of an Instagram response URL. The verified
 * endpoint table handles ordering concerns (single-relationship before the
 * batched map before followers); the fallbacks below only broaden coverage
 * for traffic the verified matchers do not claim.
 */
export function classify(url: string): Classification {
  const kind = SURFACE.matchEndpoint(url);
  // Both profile bodies (the fetched `/users/<pk>/info/` and the observed
  // GraphQL query) capture under one classification.
  if (kind === 'profile-info' || kind === 'profile-graphql') return 'profile-info';
  if (kind !== null) return kind;

  const u = url.toLowerCase();
  const p = CAPTURE_PATTERNS;

  // Broad followers heuristics: any friendships URL naming followers, or a
  // GraphQL query that mentions followers.
  const isRestFollowers = u.includes(p.friendshipsFragment) && u.includes(p.followersFragment);
  const isGraphqlFollowers = u.includes(p.graphql) && u.includes(p.followerWord);
  if (isRestFollowers || isGraphqlFollowers) return 'followers-list';

  // Any per-user REST endpoint (follower/following counts for one account).
  if (u.includes(p.usersApi)) return 'profile-info';

  // Any other GraphQL traffic — kept for inventory / later distillation.
  if (u.includes(p.graphql)) return 'graphql-other';

  return 'other';
}

/** The request side of a response — what tells one GraphQL operation from another. */
export interface CapturedRequest {
  url: string;
  method?: string;
  requestHeaders?: Record<string, string>;
}

/**
 * Classify by the REQUEST, not just its URL: one GraphQL path serves every
 * operation, so the follow mutation is only identifiable by its friendly name.
 * A POSTed operation the mutation table does not recognise but whose name looks
 * like one is kept as `mutation-suspect` — the capture that extends the table.
 */
export function classifyRequest(req: CapturedRequest): Classification {
  const mutation = SURFACE.matchMutation(req);
  if (mutation !== null) return mutation.kind === 'follow' ? 'mutation-follow' : 'mutation-unfollow';
  const friendly = SURFACE.friendlyName(req.requestHeaders);
  const kind = SURFACE.matchEndpoint(req.url, friendly);
  if (kind === 'profile-info' || kind === 'profile-graphql') return 'profile-info';
  if (kind !== null) return kind;
  const posted = req.method?.toUpperCase() === 'POST';
  if (posted && friendly !== undefined && CAPTURE_PATTERNS.mutationSuspectName.test(friendly)) {
    return 'mutation-suspect';
  }
  return classify(req.url);
}

/**
 * True when a response is a PARSEABLE body from an Instagram API-ish endpoint —
 * the gate the harness uses before promptly fetching a body to save. The media
 * type is the surface's own rule: `/api/graphql` answers `text/javascript`, and
 * a json-only gate dropped every GraphQL body a capture run ever saw.
 */
export function isInterestingJson(url: string, mimeType: string): boolean {
  if (!SURFACE.parseableMime(mimeType)) return false;
  const u = url.toLowerCase();
  return CAPTURE_PATTERNS.apiMarkers.some((marker) => u.includes(marker));
}

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
  | 'other';

/**
 * Best-effort classification of an Instagram response URL. The verified
 * endpoint table handles ordering concerns (single-relationship before the
 * batched map before followers); the fallbacks below only broaden coverage
 * for traffic the verified matchers do not claim.
 */
export function classify(url: string): Classification {
  const kind = SURFACE.matchEndpoint(url);
  if (kind === 'web-profile-info') return 'profile-info';
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

/**
 * True when a response is a JSON body from an Instagram API-ish endpoint —
 * the gate the harness uses before promptly fetching a body to save.
 */
export function isInterestingJson(url: string, mimeType: string): boolean {
  if (!mimeType.toLowerCase().includes('json')) return false;
  const u = url.toLowerCase();
  return CAPTURE_PATTERNS.apiMarkers.some((marker) => u.includes(marker));
}

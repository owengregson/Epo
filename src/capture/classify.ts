/**
 * Pure URL classification for the Task E capture harness.
 *
 * These rules are intentionally URL-substring based (not shape based): the
 * harness runs against LIVE Instagram before any Reader/Adapter exists, so it
 * must decide what a response *probably* is from its URL alone, promptly, in the
 * network handler — before the body is fetched. The distilled `field-notes.ts`
 * (Task 7) will replace these heuristics with verified endpoint matchers.
 */

export type Classification =
  | 'friendship-show'
  | 'followers-list'
  | 'show-many'
  | 'profile-info'
  | 'activity-feed'
  | 'graphql-other'
  | 'other';

/**
 * Best-effort classification of an Instagram response URL.
 *
 * Order matters: `friendships/show_many` also contains `friendships/`, so the
 * show-many rule is evaluated before the followers-list rule to avoid a
 * misclassification.
 */
export function classify(url: string): Classification {
  const u = url.toLowerCase();

  // 1. Single-relationship status (`friendships/show/<pk>/`). This returns BOTH
  //    directions (following + followed_by), unlike show_many. Must precede the
  //    show-many and followers-list rules because it also contains
  //    "friendships/"; guard against show_many explicitly for safety.
  if (u.includes('friendships/show/') && !u.includes('show_many')) {
    return 'friendship-show';
  }

  // 2. Batched relationship status. Must precede the followers-list rule
  //    because the show_many URL also contains "friendships/".
  if (u.includes('show_many')) return 'show-many';

  // 3. Followers list: the REST endpoint (friendships/<pk>/followers/) or a
  //    GraphQL query that mentions followers.
  const isRestFollowers =
    u.includes('friendships/') && u.includes('followers');
  const isGraphqlFollowers = u.includes('/graphql') && u.includes('follower');
  if (isRestFollowers || isGraphqlFollowers) return 'followers-list';

  // 4. Profile info (follower/following counts for one account).
  if (u.includes('web_profile_info') || u.includes('/api/v1/users/')) {
    return 'profile-info';
  }

  // 5. Activity / notifications feed ("started following you").
  if (u.includes('news/inbox')) return 'activity-feed';

  // 6. Any other GraphQL traffic — kept for inventory / later distillation.
  if (u.includes('/graphql')) return 'graphql-other';

  return 'other';
}

/** URL fragments that mark an Instagram JSON API response worth capturing. */
const API_MARKERS = [
  '/api/v1/',
  '/graphql',
  'web_profile_info',
  'friendships',
  'news/inbox',
];

/**
 * True when a response is a JSON body from an Instagram API-ish endpoint —
 * the gate the harness uses before promptly fetching a body to save.
 */
export function isInterestingJson(url: string, mimeType: string): boolean {
  if (!mimeType.toLowerCase().includes('json')) return false;
  const u = url.toLowerCase();
  return API_MARKERS.some((marker) => u.includes(marker));
}

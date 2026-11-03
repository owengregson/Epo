/**
 * Instagram literals — capture 2026-08-12: the JSON paths every read body is
 * parsed by and the mutation verdict keys. Re-exported by `literals.ts`.
 */

/** Verdict keys of a mutation body (REST form; a GraphQL `data` child nests the same). */
export const MUTATION_JSON = {
  status: 'status',
  ok: 'ok',
  fail: 'fail',
  message: 'message',
  spam: 'spam',
  feedbackTitle: 'feedback_title',
  feedbackMessage: 'feedback_message',
  result: 'result',
  errors: 'errors',
  data: 'data',
  friendshipStatus: 'friendship_status',
  following: 'following',
  outgoingRequest: 'outgoing_request',
} as const;

// ---------------------------------------------------------------------------
// JSON paths (verified live 2026-08-12)
// ---------------------------------------------------------------------------

export const JSON_PATHS = {
  followersList: {
    users: 'users',
    userPk: 'pk',
    userName: 'username',
    isPrivate: 'is_private',
    isVerified: 'is_verified',
    nextMaxId: 'next_max_id',
    hasMore: 'has_more',
    /** Alternate more-pages flag carried by some friendships-list responses. */
    bigList: 'big_list',
  },
  /**
   * The profile USER record. Both profile sources carry the same field names —
   * `/users/<pk>/info/` nests it under `user`, the GraphQL profile query under
   * `data.user` — so one field map serves both (`PROFILE_USER_AT` names the
   * container per source).
   *
   * These are the app-API names (`follower_count`), not the retired
   * `web_profile_info` edge shape (`edge_followed_by.count`).
   */
  profileUser: {
    id: 'pk',
    /** `/users/<pk>/info/` answers `pk` as a NUMBER; `id` is its string twin. */
    altId: 'id',
    username: 'username',
    followersCount: 'follower_count',
    followingCount: 'following_count',
    /** MUTUALS: the number behind "Followed by x and N others". */
    mutualCount: 'mutual_followers_count',
    isPrivate: 'is_private',
    isVerified: 'is_verified',
    biography: 'biography',
    /**
     * Viewer-side relationship. Carried by the GraphQL profile body only —
     * `/users/<pk>/info/` omits it, so a caller that needs it reads
     * `friendships/show/<pk>/` (which is unaffected by the retirement).
     */
    followedByViewer: 'friendship_status.following',
    requestedByViewer: 'friendship_status.outgoing_request',
    followsViewer: 'friendship_status.followed_by',
  },
  /** The GraphQL feed nests the REST inbox body (stories unchanged) here. */
  activityFeedGraphql: 'data.xdt_activity_inbox',
  /** The GraphQL follow-requests panel: a connection of the list endpoints' user rows. */
  followRequestsGraphql: {
    edges: 'data.xdt_friendships_pending_users.users.edges',
    node: 'node',
    cursor: 'data.xdt_friendships_pending_users.users.page_info.end_cursor',
    hasMore: 'data.xdt_friendships_pending_users.users.page_info.has_next_page',
  },
  /** Where each profile source puts that user record. */
  profileUserAt: {
    info: 'user',
    graphql: 'data.user',
  },
  friendshipShow: {
    following: 'following',
    followedBy: 'followed_by',
    isPrivate: 'is_private',
    outgoingRequest: 'outgoing_request',
  },
  showMany: {
    statuses: 'friendship_statuses',
    following: 'following',
    isPrivate: 'is_private',
    outgoingRequest: 'outgoing_request',
  },
  activityFeed: {
    storySections: ['new_stories', 'old_stories'] as readonly string[],
    storyType: 'story_type',
    followStoryType: 101,
    args: 'args',
    profileId: 'profile_id',
    profileName: 'profile_name',
    /** Feed timestamps are epoch SECONDS (float). */
    timestamp: 'timestamp',
    text: 'text',
    followText: /started following you/i,
  },
} as const;

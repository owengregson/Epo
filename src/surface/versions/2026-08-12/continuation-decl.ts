/**
 * The friendships lists' continuation keys — capture 2026-08-12. The explained page keys are
 * corpus-derived: every captured page carries only declared or explained root keys (spec §10.4).
 */

import type { ContinuationDecl } from '@/surface/read/continuation';

export const CONTINUATION: ContinuationDecl = {
  rowsKey: 'users',
  /** The REST resume cursor (a GraphQL connection's `end_cursor` is normalized onto it). */
  cursorKeys: ['next_max_id'],
  /** `big_list` is the alternate more-flag some friendships pages carry; `has_next_page` the connection's. */
  moreFlags: ['has_more', 'big_list', 'has_next_page'],
  /** The followers list pages by row offset ("50", "100", …); a non-digit cursor is opaque. */
  offsetCursor: /^\d{1,9}$/,
  /** The rows container and the page keys every captured page carries that say nothing about paging. */
  explainedPageKeys: ['users', 'page_size', 'status', 'should_limit_list_of_followers', 'use_clickable_see_more',
    'show_spam_follow_request_tab', 'follow_ranking_token', 'groups', 'more_groups_available', 'friend_requests'],
  cursorName: /cursor|max_id|next_page|after|page_token/i,
  moreFlagName: /more|next/i,
  /** FOLLOWING is read in its fixed order, which answers the whole list and ignores `max_id`. */
  composedForm: { followers: 'paged', following: 'whole-list' },
};

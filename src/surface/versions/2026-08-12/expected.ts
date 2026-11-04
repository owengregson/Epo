/**
 * Decision-bearing paths and the novelty baseline — capture 2026-08-12, pinned to the corpora's
 * manifests (spec §10.3, §10.7). A missing expected path is `expected-absent`; a baseline key is known.
 */

import type { EndpointKind } from '@/surface/schema/endpoints';

type PathsByKind = Readonly<Partial<Record<EndpointKind, readonly string[]>>>;

const RELATIONSHIP = ['following', 'outgoing_request', 'followed_by', 'incoming_request'];

/** Present in every real corpus body, record-relative (`x[]` is every row, `*` every value). */
export const EXPECTED_KEYS: PathsByKind = {
  'profile-graphql': ['username', 'follower_count', 'following_count', 'is_private', 'is_verified', 'biography',
    'friendship_status', ...RELATIONSHIP.map((k) => `friendship_status.${k}`)],
  'show-many': ['friendship_statuses', ...RELATIONSHIP.filter((k) => k !== 'followed_by').map((k) => `friendship_statuses.*.${k}`)],
  'friendship-show': RELATIONSHIP,
  'activity-feed': ['new_stories', 'old_stories', 'new_stories[].story_type', 'new_stories[].args', 'old_stories[].story_type',
    'old_stories[].args'],
  'friend-requests': ['users', 'users[].username'],
  'followers-list': ['users', 'users[].username'],
  'following-list': ['users', 'users[].username'],
};

/**
 * Observed empty-bio form (spec §7.3): the scrubber preserves the empty string from a canonical
 * private profile. This establishes no null/absent form; those remain unread, never a known empty bio.
 */
export const EMPTY_BIO = {
  form: 'empty-string',
  evidence: '2026-11-04 corpus: one canonical private profile carries biography "" with bio read and partial false; null/absent remain unverified',
} as const;

/** The union of the manifests' `novelKeys`, per endpoint (a freshness test re-derives it). */
export const CORPUS_NOVEL_KEYS: PathsByKind = {
  'followers-list': [
    'follow_ranking_token', 'groups', 'more_groups_available', 'should_limit_list_of_followers',
    'show_spam_follow_request_tab', 'use_clickable_see_more', 'users[].account_badges', 'users[].fbid_v2',
    'users[].has_anonymous_profile_picture', 'users[].id', 'users[].is_favorite', 'users[].latest_reel_media',
    'users[].pk_id', 'users[].profile_pic_id', 'users[].strong_id__', 'users[].third_party_downloads_enabled',
  ],
  'friend-requests': [
    'data.xdt_friendships_pending_users.users.edges[].cursor',
    'data.xdt_friendships_pending_users.users.edges[].node.__typename',
    'data.xdt_friendships_pending_users.users.edges[].node.friendship_status',
    'data.xdt_friendships_pending_users.users.edges[].node.hd_profile_pic_url_info',
    'data.xdt_friendships_pending_users.users.edges[].node.id',
    'data.xdt_friendships_pending_users.users.edges[].node.is_unpublished',
    'data.xdt_friendships_pending_users.users.edges[].node.live_broadcast_id',
    'data.xdt_friendships_pending_users.users.edges[].node.live_broadcast_visibility',
    'data.xdt_friendships_pending_users.users.edges[].node.supervision_info', 'extensions', 'friend_requests',
    'users[].account_badges', 'users[].fbid_v2', 'users[].has_anonymous_profile_picture', 'users[].id',
    'users[].latest_reel_media', 'users[].pk_id', 'users[].profile_pic_id', 'users[].strong_id__',
    'users[].third_party_downloads_enabled',
  ],
  'show-many': [
    'friendship_statuses.*.is_bestie', 'friendship_statuses.*.is_feed_favorite',
    'friendship_statuses.*.is_restricted', 'friendship_statuses.*.text_post_app_pre_following', 'status_code',
  ],
  'friendship-show': [
    'blocking', 'is_bestie', 'is_blocking_reel', 'is_eligible_to_subscribe', 'is_feed_favorite',
    'is_guardian_of_viewer', 'is_muting_media_notes', 'is_muting_media_reposts', 'is_muting_notes', 'is_muting_reel',
    'is_restricted', 'is_supervised_by_viewer', 'is_viewer_unconnected', 'muting', 'subscribed',
  ],
  'profile-graphql': [
    'data.user.account_badges', 'data.user.account_type', 'data.user.address_street', 'data.user.ai_agent_type',
    'data.user.aigm_account_label_info', 'data.user.bio_links', 'data.user.biography_with_entities',
    'data.user.category', 'data.user.city_name', 'data.user.external_lynx_url', 'data.user.external_url',
    'data.user.fbid_v2', 'data.user.friendship_status.blocking', 'data.user.friendship_status.incoming_request',
    'data.user.friendship_status.is_bestie', 'data.user.friendship_status.is_feed_favorite',
    'data.user.friendship_status.is_muting_reel', 'data.user.friendship_status.is_restricted',
    'data.user.friendship_status.muting', 'data.user.gating', 'data.user.has_chaining',
    'data.user.has_longform_media', 'data.user.has_profile_pic', 'data.user.has_restyle_presets',
    'data.user.has_story_archive', 'data.user.has_visible_media_notes', 'data.user.hd_profile_pic_url_info',
    'data.user.hide_creator_marketplace_badge', 'data.user.is_business', 'data.user.is_cannes',
    'data.user.is_coppa_enforced', 'data.user.is_embeds_disabled', 'data.user.is_memorialized',
    'data.user.is_professional_account', 'data.user.is_regulated_c18', 'data.user.is_ring_creator',
    'data.user.is_unpublished', 'data.user.latest_besties_reel_media', 'data.user.latest_reel_media',
    'data.user.linked_fb_info', 'data.user.live_broadcast_id', 'data.user.live_broadcast_visibility',
    'data.user.meta_verified_benefits_info', 'data.user.profile_context_facepile_users',
    'data.user.profile_context_links_with_user_ids', 'data.user.profile_pic_genai_tool_info', 'data.user.pronouns',
    'data.user.reel_media_seen_timestamp', 'data.user.regulated_news_in_locations',
    'data.user.remove_message_entrypoint', 'data.user.ring_creator_metadata', 'data.user.short_drama_creator',
    'data.user.should_show_category', 'data.user.show_account_transparency_details', 'data.user.show_ring_award',
    'data.user.show_text_post_app_badge', 'data.user.supervision_info', 'data.user.text_post_app_badge_label',
    'data.user.total_clips_count', 'data.user.transparency_label', 'data.user.transparency_product', 'data.user.zip',
    'data.viewer', 'extensions',
  ],
  'activity-feed': [
    'data.xdt_activity_inbox.old_stories[].__typename', 'data.xdt_activity_inbox.old_stories[].args.aytm_channel_id',
    'data.xdt_activity_inbox.old_stories[].args.aytm_notif_id',
    'data.xdt_activity_inbox.old_stories[].args.destination', 'data.xdt_activity_inbox.old_stories[].args.icon_url',
    'data.xdt_activity_inbox.old_stories[].args.inline_follow',
    'data.xdt_activity_inbox.old_stories[].args.latest_reel_media',
    'data.xdt_activity_inbox.old_stories[].args.latest_reel_seen_time',
    'data.xdt_activity_inbox.old_stories[].args.links', 'data.xdt_activity_inbox.old_stories[].args.media',
    'data.xdt_activity_inbox.old_stories[].args.profile_image',
    'data.xdt_activity_inbox.old_stories[].args.profile_image_destination',
    'data.xdt_activity_inbox.old_stories[].args.second_icon_url',
    'data.xdt_activity_inbox.old_stories[].args.second_profile_image',
    'data.xdt_activity_inbox.old_stories[].args.users', 'data.xdt_activity_inbox.old_stories[].ndid',
    'data.xdt_activity_inbox.old_stories[].pk', 'data.xdt_activity_inbox.old_stories[].render_path',
    'data.xdt_activity_inbox.old_stories[].serving_stack', 'data.xdt_activity_inbox.old_stories[].type',
    'data.xdt_activity_inbox.partition', 'data.xdt_api__v1__friendships__pending', 'extensions',
  ],
};

/** The feed's two sections share one story shape: a key seen in one is known in the other. */
const bothSections = (keys: readonly string[]): string[] =>
  keys.flatMap((k) => (k.includes('.old_stories[]') ? [k, k.replace('.old_stories[]', '.new_stories[]')] : [k]));

const known = (kind: EndpointKind, from: EndpointKind = kind): string[] =>
  [...new Set([...bothSections(CORPUS_NOVEL_KEYS[from] ?? []), ...(EXPECTED_KEYS[kind] ?? [])])].sort();

/** Never reported as new: the corpora's unknown keys plus the expected paths (the following list shares the followers page). */
export const NOVELTY_BASELINE: PathsByKind = {
  'followers-list': known('followers-list'),
  'following-list': known('following-list', 'followers-list'),
  'friend-requests': known('friend-requests'),
  'show-many': known('show-many'),
  'friendship-show': known('friendship-show'),
  'profile-graphql': known('profile-graphql'),
  'activity-feed': known('activity-feed'),
};

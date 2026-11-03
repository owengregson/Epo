/**
 * The keys every record is read by, and the bounded recovery's vocabulary (spec §10.3, §10.6) —
 * capture 2026-08-12, re-read on the 2026-11-02 corpus. Story types are identifiers, kept as text.
 */

import type { RecoveryDecl } from '@/surface/schema/decls';
import { JSON_PATHS, MUTATION_CANDIDATE_FAMILY } from '@/surface/versions/2026-08-12/literals';

const FEED = JSON_PATHS.activityFeed;
const PROFILE = JSON_PATHS.profileUser;

export const RECOVERY_DECL: RecoveryDecl = {
  /** The row id and its aliases (every captured row carries all four, agreeing). */
  idKeys: [PROFILE.id, 'pk_id', PROFILE.altId, 'strong_id__'],
  foreignIdKeys: ['fbid_v2', 'fbid', 'interop_messaging_user_fbid'],
  handleKey: PROFILE.username,
  handleRe: /^[A-Za-z0-9._]{1,30}$/,
  profileCountKeys: { followers: PROFILE.followersCount, following: PROFILE.followingCount, mutuals: PROFILE.mutualCount },
  relationshipKeys: JSON_PATHS.relationship,
  /** Other accounts inside a body: the viewer, the "followed by" facepile, a list's suggestion groups. */
  foreignContainers: {
    'profile-graphql': ['data.viewer', 'data.user.profile_context_facepile_users', 'data.user.supervision_info'],
    'followers-list': ['groups', 'suggested_users', 'suggestions'],
  },
  followStoryTypes: [String(FEED.followStoryType)],
  /** Every story type the 2026-11-02 feed bodies carry (24 stories: 23 follows, 1 other). */
  knownStoryTypes: [String(FEED.followStoryType), '651'],
  storyTypeKey: FEED.storyType,
  storyArgsKey: FEED.args,
  storySections: FEED.storySections,
  edgeNodeKey: JSON_PATHS.followRequestsConnection.node,
  storyActorKey: `${FEED.args}.${FEED.profileId}`,
  storyActorAliases: [`${FEED.args}.${FEED.inlineFollowPk}`, `${FEED.args}.${FEED.storyUsers}.0.${PROFILE.id}`],
  followText: FEED.followText,
  requesterMarker: 'friendship_status.incoming_request',
  opFamilies: [
    { kind: 'friend-requests', pattern: /FollowRequests/i },
    { kind: 'activity-feed', pattern: /ActivityFeed|ActivityInbox/i },
    { kind: 'profile-graphql', pattern: /ProfilePage|UserProfile/i },
  ],
  mutationFamily: MUTATION_CANDIDATE_FAMILY,
};

/**
 * The compatibility copy (spec Appendix D.2, owner Q28 "Prune"): friendly field names by the longest path
 * match, the explanations, the recent-change lines, and a vocabulary with no automation framing.
 */

import {
  AREA_LABEL, COMPATIBILITY_LEAD, changeLine, explanation, FIELD_LABEL, fieldLabel, fieldOf, PAUSED_LABEL, STATE_LABEL,
  type SurfaceChange,
} from '@/shared/surface-health';

const change = (over: Partial<SurfaceChange>): SurfaceChange => ({ area: 'profiles', endpoint: 'profile-graphql', cls: 'recovered',
  field: null, path: 'data.user', firstSeenAt: 0, lastSeenAt: 0, seen: 3, state: 'open', witnesses: 0, hint: null,
  hasSample: false, ...over });
const date = (): string => 'Nov 2';

test('a path names its field by the longest matching key; anything else is a renamed detail', () => {
  expect(fieldOf('data.user.friendship_status.following')).toBe('friendship_status.following');
  expect(fieldOf('data.user.follower_count')).toBe('follower_count');
  expect(fieldOf('data.xdt_activity_inbox.old_stories[].args.profile_id')).toBe('args.profile_id');
  expect(fieldOf('data.user.brand_new')).toBeNull();
  expect(fieldLabel(null)).toBe('a detail Instagram renamed');
});

test('explanations say what waits, in the Prune vocabulary', () => {
  expect(explanation('lists', 'paused', ['cleanup', 'exploration'], null))
    .toBe("Epo can't confirm your full follower list right now, so pruning waits. Nothing is removed until it can. "
      + 'Instagram changed how follower lists look. Epo keeps following the people it already found and pauses finding new ones until an update confirms the change.');
  expect(explanation('notifications', 'unreadable', [], 'Nov 2')).toContain("hasn't been able to read notifications since Nov 2");
  expect(explanation('profiles', 'ok', [], null)).toBe('');
});

test('recent-change lines per class', () => {
  expect(changeLine(change({ state: 'consistent', witnesses: 2 }), date))
    .toBe('Profiles: information arrives in a new place · since Nov 2 · seen 3 times · confirmed on 2 accounts · ready for an update');
  expect(changeLine(change({ cls: 'expected-absent', field: 'biography' }), date)).toBe('Profiles: bio is missing · since Nov 2');
  expect(changeLine(change({ area: 'lists', cls: 'cursor-veto' }), date))
    .toBe('Follower and following lists: the next-page marker changed · scans stop early instead of guessing');
  expect(changeLine(change({ area: 'follow-actions', cls: 'confirm-unrecognized' }), date))
    .toBe('Follow and unfollow results: a confirmation step looked different · Epo cancelled instead of guessing');
});

test('the copy never frames Epo as automation and never says "clean up"', () => {
  const lines = [COMPATIBILITY_LEAD, ...Object.values(AREA_LABEL), ...Object.values(STATE_LABEL), ...Object.values(PAUSED_LABEL),
    ...Object.values(FIELD_LABEL), explanation('lists', 'paused', ['cleanup', 'unfollows', 'follow-back-decisions', 'exploration'], null)];
  for (const line of lines) {
    expect(line).not.toMatch(/\b(bot|human|emulat|stealth|mimic|spoof|detect|natural)/i);
    expect(line).not.toMatch(/clean ?up/i);
  }
});

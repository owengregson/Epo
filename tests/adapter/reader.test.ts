import { Reader } from '@/adapter/reader';
import { SURFACE, SHAPE_MISMATCH, isShapeMismatch } from '@/adapter/ig-surface';

import followersPage1 from '../fixtures/adapter/followers-list-page1.json';
import followersLast from '../fixtures/adapter/followers-list-last.json';
import showMany from '../fixtures/adapter/show-many.json';
import friendshipShowPrivate from '../fixtures/adapter/friendship-show-private.json';
import friendshipShowPublic from '../fixtures/adapter/friendship-show-public.json';
import profileInfo1 from '../fixtures/adapter/profile-info-1.json';
import profileInfo2 from '../fixtures/adapter/profile-info-2.json';

const r = new Reader();
const AT = 1_700_000_000_000;

describe('Reader.matchEndpoint', () => {
  test('friendship-show is matched BEFORE show-many / followers-list', () => {
    expect(
      r.matchEndpoint('https://www.instagram.com/api/v1/friendships/show/12345/'),
    ).toBe('friendship-show');
  });

  test('show-many is not misread as followers-list', () => {
    expect(
      r.matchEndpoint('https://i.instagram.com/api/v1/friendships/show_many/'),
    ).toBe('show-many');
  });

  test('followers-list endpoint', () => {
    expect(
      r.matchEndpoint(
        'https://www.instagram.com/api/v1/friendships/17841400000/followers/?count=12',
      ),
    ).toBe('followers-list');
  });

  test('following-list endpoint (Phase 5) — not misread as followers-list', () => {
    expect(
      r.matchEndpoint(
        'https://www.instagram.com/api/v1/friendships/17841400000/following/?count=12&max_id=24',
      ),
    ).toBe('following-list');
  });

  test('web_profile_info -> web-profile-info', () => {
    expect(
      r.matchEndpoint(
        'https://www.instagram.com/api/v1/users/web_profile_info/?username=x',
      ),
    ).toBe('web-profile-info');
  });

  test('news/inbox -> activity-feed', () => {
    expect(
      r.matchEndpoint('https://www.instagram.com/api/v1/news/inbox/'),
    ).toBe('activity-feed');
  });

  test('unrelated URL -> null', () => {
    expect(r.matchEndpoint('https://www.instagram.com/static/bundle.js')).toBeNull();
    expect(r.matchEndpoint('https://example.com/')).toBeNull();
  });
});

describe('Reader.extractPkFromUrl', () => {
  test('extracts the pk from a friendships/show/<pk>/ URL', () => {
    expect(
      r.extractPkFromUrl(
        'https://i.instagram.com/api/v1/friendships/show/17841400000/',
      ),
    ).toBe('17841400000');
  });

  test('returns null when there is no pk', () => {
    expect(
      r.extractPkFromUrl('https://www.instagram.com/api/v1/friendships/show_many/'),
    ).toBeNull();
    expect(r.extractPkFromUrl('https://example.com/')).toBeNull();
  });
});

describe('Reader.extractTargetPkFromFollowersUrl', () => {
  test('extracts the numeric id from a real followers URL', () => {
    expect(
      r.extractTargetPkFromFollowersUrl(
        'https://www.instagram.com/api/v1/friendships/17841400000/followers/?count=12',
      ),
    ).toBe('17841400000');
  });

  test('returns null on a non-matching URL', () => {
    expect(
      r.extractTargetPkFromFollowersUrl(
        'https://www.instagram.com/api/v1/friendships/show_many/',
      ),
    ).toBeNull();
    expect(r.extractTargetPkFromFollowersUrl('https://example.com/')).toBeNull();
  });
});

describe('Reader.extractTargetPkFromFollowingUrl', () => {
  test('extracts the numeric id from a following URL', () => {
    expect(
      r.extractTargetPkFromFollowingUrl(
        'https://www.instagram.com/api/v1/friendships/17841400000/following/?count=12',
      ),
    ).toBe('17841400000');
  });

  test('returns null on a non-matching URL (a followers URL is NOT following)', () => {
    expect(
      r.extractTargetPkFromFollowingUrl(
        'https://www.instagram.com/api/v1/friendships/17841400000/followers/?count=12',
      ),
    ).toBeNull();
    expect(r.extractTargetPkFromFollowingUrl('https://example.com/')).toBeNull();
  });
});

describe('Reader.parseFollowingList', () => {
  test('the following-list body parses with the followers-list shape', () => {
    const out = r.parseFollowingList(followersPage1, AT);
    expect(out.observations).toHaveLength(12);
    expect(out.cursor).toBe('12');
    expect(out.hasMore).toBe(true);
    expect(out.observations[0].accountPk).toBe('1000000002');
  });

  test('no-match body yields a typed empty result (no throw)', () => {
    const out = r.parseFollowingList({ nope: true }, AT);
    expect(out).toEqual({ observations: [], cursor: null, hasMore: false });
  });
});

describe('Reader.parseFollowersList', () => {
  test('extracts users + cursor + hasMore from a real followers page', () => {
    const out = r.parseFollowersList(followersPage1, AT);
    expect(out.observations).toHaveLength(12);
    expect(out.cursor).toBe('12');
    expect(out.hasMore).toBe(true);

    const first = out.observations[0];
    expect(first.accountPk).toBe('1000000002');
    expect(first.observedAt).toBe(AT);
    expect(first.source).toBe('followers-list');
    expect(first.fields).toEqual({
      username: 'user_002',
      isPrivate: true,
      isVerified: false,
    });

    // Every pk is a numeric string; usernames survive scrubbing.
    for (const obs of out.observations) {
      expect(obs.accountPk).toMatch(/^\d+$/);
      expect(obs.source).toBe('followers-list');
    }
    expect(out.observations[1].accountPk).toBe('1000000006');
    expect(out.observations[1].fields.username).toBe('user_004');
  });

  test('last page has no cursor and hasMore=false', () => {
    const out = r.parseFollowersList(followersLast, AT);
    expect(out.observations).toHaveLength(3);
    expect(out.cursor).toBeNull();
    expect(out.hasMore).toBe(false);
  });

  test('hasMore is resilient to which flag the response carries', () => {
    const users = [{ pk: '7', username: 'u7', is_private: false, is_verified: false }];
    // `big_list` alone (no has_more) still means more pages.
    expect(r.parseFollowersList({ users, big_list: true }, AT).hasMore).toBe(true);
    // A present pagination cursor alone still means more pages.
    const withCursor = r.parseFollowersList({ users, next_max_id: '25' }, AT);
    expect(withCursor.hasMore).toBe(true);
    expect(withCursor.cursor).toBe('25');
    // No flag and no cursor is genuinely the end.
    expect(r.parseFollowersList({ users }, AT).hasMore).toBe(false);
  });

  test('accepts a raw JSON string body', () => {
    const out = r.parseFollowersList(JSON.stringify(followersPage1), AT);
    expect(out.observations).toHaveLength(12);
    expect(out.cursor).toBe('12');
  });

  test('no-match body yields a typed empty result (no throw)', () => {
    const out = r.parseFollowersList({ nope: true }, AT);
    expect(out).toEqual({ observations: [], cursor: null, hasMore: false });
  });
});

describe('Reader.parseProfileInfo', () => {
  test('extracts pk, username, follower/following counts', () => {
    const obs = r.parseProfileInfo(profileInfo1, AT);
    expect(obs).not.toBeNull();
    expect(obs!.accountPk).toBe('1000000003');
    expect(obs!.observedAt).toBe(AT);
    expect(obs!.source).toBe('profile');
    expect(obs!.fields).toEqual({
      username: 'user_005',
      followers: 561,
      following: 305,
      mutuals: 18,
      isPrivate: true,
      isVerified: false,
      bio: '',
    });
  });

  test('extracts the biography so the prune bio filter has a fact to match on', () => {
    const body = { data: { user: { id: '9', username: 'x', biography: 'Dog mom 🐶 | photographer' } } };
    expect(r.parseProfileInfo(body, AT)!.fields.bio).toBe('Dog mom 🐶 | photographer');
  });

  test('second profile fixture: counts preserved for ratio math', () => {
    const obs = r.parseProfileInfo(profileInfo2, AT);
    expect(obs!.fields.followers).toBe(1194);
    expect(obs!.fields.following).toBe(1131);
  });

  test('missing user -> null', () => {
    expect(r.parseProfileInfo({ data: {} }, AT)).toBeNull();
    expect(r.parseProfileInfo({}, AT)).toBeNull();
  });
});

describe('Reader.profileFollowedByViewer', () => {
  test('true when the viewer already follows the account (private followers visible)', () => {
    expect(
      r.profileFollowedByViewer({ data: { user: { id: '1', followed_by_viewer: true } } }),
    ).toBe(true);
  });

  test('false when the viewer does not follow', () => {
    expect(
      r.profileFollowedByViewer({ data: { user: { id: '1', followed_by_viewer: false } } }),
    ).toBe(false);
  });

  test('null when the flag or user is absent', () => {
    expect(r.profileFollowedByViewer({ data: { user: { id: '1' } } })).toBeNull();
    expect(r.profileFollowedByViewer({ data: {} })).toBeNull();
    expect(r.profileFollowedByViewer({})).toBeNull();
  });
});

describe('Reader.parseShowMany', () => {
  test('maps friendship_statuses to per-pk following flags', () => {
    const out = r.parseShowMany(showMany, AT);
    expect(out).toHaveLength(12);

    const byPk = new Map(out.map((e) => [e.pk, e]));
    expect(byPk.get('1000000001')).toEqual({
      pk: '1000000001',
      following: true,
      outgoingRequest: false,
      isPrivate: true,
    });
    expect(byPk.get('1000000002')!.following).toBe(false);

    const followingCount = out.filter((e) => e.following).length;
    expect(followingCount).toBe(5);
    // This shape carries NO followed_by information.
    for (const e of out) {
      expect(e).not.toHaveProperty('followedBy');
    }
  });

  test('no-match body -> empty array', () => {
    expect(r.parseShowMany({ nope: true }, AT)).toEqual([]);
  });
});

describe('Reader.parseFriendshipShow', () => {
  test('reads both directions; followedBy comes from followed_by', () => {
    const out = r.parseFriendshipShow(friendshipShowPrivate, AT, '999');
    expect(out).toEqual({
      pk: '999',
      following: true,
      followedBy: true,
      outgoingRequest: false,
      isPrivate: true,
    });
  });

  test('public account variant', () => {
    const out = r.parseFriendshipShow(friendshipShowPublic, AT, '1000000042');
    expect(out?.followedBy).toBe(true);
    expect(out?.isPrivate).toBe(false);
    expect(out?.pk).toBe('1000000042');
  });

  test('no-match body -> null (unparsed is NOT "no relationship")', () => {
    // An error body ({"status":"fail"}-style) must never parse to all-false:
    // a false "we do not follow them" fact terminates held records downstream.
    expect(r.parseFriendshipShow({ nope: true }, AT, '42')).toBeNull();
  });

  test('a pending private-account request reads as outgoingRequest', () => {
    const out = r.parseFriendshipShow(
      { following: false, followed_by: false, outgoing_request: true, is_private: true },
      AT,
      '77',
    );
    expect(out?.following).toBe(false);
    expect(out?.outgoingRequest).toBe(true);
  });
});

describe('Reader.relationshipFacts', () => {
  const SHOW_MANY_URL = 'https://i.instagram.com/api/v1/friendships/show_many/';
  const SHOW_URL = 'https://www.instagram.com/api/v1/friendships/show/999/';
  const PROFILE_URL = 'https://www.instagram.com/api/v1/users/web_profile_info/?username=x';

  test('show-many → one fact per entry, weFollow from following', () => {
    const facts = r.relationshipFacts(SHOW_MANY_URL, showMany, AT);
    expect(facts).toHaveLength(12);
    const byPk = new Map(facts.map((f) => [f.pk, f.weFollow]));
    expect(byPk.get('1000000001')).toBe(true);
    expect(byPk.get('1000000002')).toBe(false);
    expect(facts.filter((f) => f.weFollow)).toHaveLength(5);
  });

  test('friendship-show → single fact keyed by the URL pk', () => {
    expect(r.relationshipFacts(SHOW_URL, friendshipShowPrivate, AT)).toEqual([
      { pk: '999', weFollow: true },
    ]);
  });

  test('friendship-show with following:false → weFollow false', () => {
    const body = { following: false, followed_by: true, status: 'ok' };
    expect(r.relationshipFacts(SHOW_URL, body, AT)).toEqual([{ pk: '999', weFollow: false }]);
  });

  test('web-profile-info → fact from pk + followed_by_viewer', () => {
    expect(r.relationshipFacts(PROFILE_URL, profileInfo1, AT)).toEqual([
      { pk: '1000000003', weFollow: true },
    ]);
  });

  test('web-profile-info without a user or without the flag → []', () => {
    expect(r.relationshipFacts(PROFILE_URL, { data: {} }, AT)).toEqual([]);
    expect(
      r.relationshipFacts(PROFILE_URL, { data: { user: { id: '1', username: 'x' } } }, AT),
    ).toEqual([]);
  });

  test('accepts a raw JSON string body', () => {
    expect(r.relationshipFacts(SHOW_MANY_URL, JSON.stringify(showMany), AT)).toHaveLength(12);
  });

  test('non-relationship endpoints and unrelated URLs → []', () => {
    expect(
      r.relationshipFacts('https://www.instagram.com/api/v1/news/inbox/', {}, AT),
    ).toEqual([]);
    expect(r.relationshipFacts('https://example.com/', showMany, AT)).toEqual([]);
  });
});

describe('SURFACE.extractFriendshipShow shape-mismatch sentinel', () => {
  test('an unexpected (non-record) body returns SHAPE_MISMATCH, not a default', () => {
    expect(SURFACE.extractFriendshipShow(null, '42')).toBe(SHAPE_MISMATCH);
    expect(SURFACE.extractFriendshipShow('<!DOCTYPE html>', '42')).toBe(SHAPE_MISMATCH);
    expect(SURFACE.extractFriendshipShow(undefined, '42')).toBe(SHAPE_MISMATCH);
    expect(isShapeMismatch(SURFACE.extractFriendshipShow([], '42'))).toBe(true);
  });

  test('a genuine no-relationship record parses (distinguishable from unparsed)', () => {
    const out = SURFACE.extractFriendshipShow({ following: false, followed_by: false }, '42');
    expect(isShapeMismatch(out)).toBe(false);
    expect(out).toEqual({
      pk: '42',
      following: false,
      followedBy: false,
      outgoingRequest: false,
      isPrivate: undefined,
    });
  });
});

describe('SURFACE.listPageScript (direct list pagination)', () => {
  test('first page: full-size count, no max_id; the walker parses via followers-list', () => {
    const script = SURFACE.listPageScript('49542389667', 'followers', null);
    expect(script).toContain('/api/v1/friendships/');
    expect(script).toContain('"49542389667"');
    expect(script).toContain("/followers/?count=50'");
    expect(script).not.toContain('max_id');
    // The fetched URL must be one the endpoint table routes to followers-list,
    // so request metering / reconciliation see the walked pages too.
    expect(
      SURFACE.matchEndpoint(
        'https://www.instagram.com/api/v1/friendships/49542389667/followers/?count=50',
      ),
    ).toBe('followers-list');
  });

  test('later pages resume from the cursor; the following variant hits following/', () => {
    const script = SURFACE.listPageScript('42', 'following', 'QVFEabc==');
    expect(script).toContain("/following/?count=50'");
    expect(script).toContain('max_id');
    expect(script).toContain('"QVFEabc=="');
  });
});

// --- activity feed (news inbox → follow-back events) --------------------------------

describe('parseActivityFeed', () => {
  const inbox = (newStories: unknown[], oldStories: unknown[]): unknown => ({
    counts: {},
    new_stories: newStories,
    old_stories: oldStories,
  });

  test('routes the news-inbox URL to activity-feed', () => {
    expect(
      r.matchEndpoint('https://www.instagram.com/api/v1/news/inbox/'),
    ).toBe('activity-feed');
  });

  test('extracts follow events via story_type OR the text matcher (either signal admits)', () => {
    const body = inbox(
      [
        // Canonical: story_type 101 + text.
        {
          story_type: 101,
          args: { profile_id: 11, profile_name: 'alpha', timestamp: 2.5, text: 'alpha started following you.' },
        },
        // Drifted story_type but recognizable text → still admitted.
        {
          story_type: 999,
          args: { profile_id: '22', text: 'beta started following you.' },
        },
      ],
      [
        // Non-follow story → ignored.
        { story_type: 60, args: { profile_id: 33, text: 'gamma liked your photo.', timestamp: 9 } },
        // Follow type with no text → still admitted (type signal alone).
        { story_type: 101, args: { profile_id: 44, timestamp: 7 } },
      ],
    );

    expect(r.parseActivityFeed(body)).toEqual([
      { pk: '11', username: 'alpha', atMs: 2500 },
      { pk: '22', username: null, atMs: null },
      { pk: '44', username: null, atMs: 7000 },
    ]);
  });

  test('an empty feed parses to an empty list (valid: nobody followed recently)', () => {
    expect(r.parseActivityFeed(inbox([], []))).toEqual([]);
  });

  test('a body with NO story containers is shape drift → [] (warned), never invented events', () => {
    expect(r.parseActivityFeed({ status: 'fail' })).toEqual([]);
    expect(r.parseActivityFeed('not json at all {')).toEqual([]);
  });

  test('entries without a usable profile_id are skipped', () => {
    const body = inbox(
      [{ story_type: 101, args: { text: 'x started following you.' } }],
      [],
    );
    expect(r.parseActivityFeed(body)).toEqual([]);
  });
});

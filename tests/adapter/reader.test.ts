import { Reader } from '@/adapter/reader';

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

  test('web_profile_info -> profile-info', () => {
    expect(
      r.matchEndpoint(
        'https://www.instagram.com/api/v1/users/web_profile_info/?username=x',
      ),
    ).toBe('profile-info');
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
      isPrivate: true,
      isVerified: false,
    });
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

describe('Reader.parseShowMany', () => {
  test('maps friendship_statuses to per-pk following flags', () => {
    const out = r.parseShowMany(showMany, AT);
    expect(out).toHaveLength(12);

    const byPk = new Map(out.map((e) => [e.pk, e]));
    expect(byPk.get('1000000001')).toEqual({
      pk: '1000000001',
      following: true,
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
      isPrivate: true,
    });
  });

  test('public account variant', () => {
    const out = r.parseFriendshipShow(friendshipShowPublic, AT, '1000000042');
    expect(out.followedBy).toBe(true);
    expect(out.isPrivate).toBe(false);
    expect(out.pk).toBe('1000000042');
  });

  test('no-match body -> false flags, pk preserved', () => {
    const out = r.parseFriendshipShow({ nope: true }, AT, '42');
    expect(out).toEqual({
      pk: '42',
      following: false,
      followedBy: false,
      isPrivate: undefined,
    });
  });
});

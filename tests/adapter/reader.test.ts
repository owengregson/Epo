import { isShapeMismatch, SHAPE_MISMATCH, SURFACE } from '@/adapter/ig-surface';
import { Reader } from '@/adapter/reader';
import followersLast from '../fixtures/adapter/followers-list-last.json';
import followersPage1 from '../fixtures/adapter/followers-list-page1.json';
import friendshipShowPrivate from '../fixtures/adapter/friendship-show-private.json';
import friendshipShowPublic from '../fixtures/adapter/friendship-show-public.json';
import profileGraphql1 from '../fixtures/adapter/profile-graphql-1.json';
import profileInfo1 from '../fixtures/adapter/profile-info-1.json';
import profileInfo2 from '../fixtures/adapter/profile-info-2.json';
import showMany from '../fixtures/adapter/show-many.json';

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

  test('users/<pk>/info -> profile-info', () => {
    expect(
      r.matchEndpoint('https://www.instagram.com/api/v1/users/1000000003/info/'),
    ).toBe('profile-info');
  });

  test('the GraphQL profile query is routed by its operation name, not its URL', () => {
    const url = 'https://www.instagram.com/api/graphql';
    // `/api/graphql` serves dozens of operations; without the name it is no
    // endpoint of ours, and a DIFFERENT operation never routes to the profile.
    expect(r.matchEndpoint(url)).toBeNull();
    expect(r.matchEndpoint(url, 'PolarisFeedTimelineRootV2Query')).toBeNull();
    expect(r.matchEndpoint(url, 'PolarisProfilePageContentQuery')).toBe('profile-graphql');
    expect(
      r.kindOf({ url, requestHeaders: { 'x-fb-friendly-name': 'PolarisProfilePageContentQuery' } }),
    ).toBe('profile-graphql');
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

describe('Reader.parseFollowersListStrict / parseFollowingListStrict', () => {
  test('the following-list body parses with the followers-list shape', () => {
    const out = r.parseFollowingListStrict(followersPage1, AT);
    expect(out?.observations).toHaveLength(12);
    expect(out?.cursor).toBe('12');
    expect(out?.hasMore).toBe(true);
    expect(out?.observations[0].accountPk).toBe('1000000002');
    expect(out?.observations[0].source).toBe('following-list');
  });

  test('extracts users, cursor and continuation from a real followers page', () => {
    const out = r.parseFollowersListStrict(followersPage1, AT);
    expect(out).not.toBeNull();
    if (out === null) return;
    expect(out.observations).toHaveLength(12);
    expect(out.cursor).toBe('12');
    expect(out.hasMore).toBe(true);
    expect(out.continuation).toEqual({ kind: 'next', cursor: '12', form: 'offset' });
    expect(out.quarantined).toBe(0);

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

  test('the last page has no cursor and ends on the server flags', () => {
    const out = r.parseFollowersListStrict(followersLast, AT);
    expect(out?.observations).toHaveLength(3);
    expect(out?.cursor).toBeNull();
    expect(out?.hasMore).toBe(false);
    expect(out?.continuation).toEqual({ kind: 'end', evidence: 'flags-false' });
  });

  test('more-pages detection: a cursor continues, a flag without one is drift, nothing is an end without evidence', () => {
    const users = [{ pk: '7', username: 'u7', is_private: false, is_verified: false }];
    expect(r.parseFollowersListStrict({ users, big_list: true }, AT)).toMatchObject({
      hasMore: true, cursor: null, continuation: { kind: 'drift', reason: 'more-without-cursor', key: 'big_list' },
    });
    expect(r.parseFollowersListStrict({ users, next_max_id: '25' }, AT)).toMatchObject({ hasMore: true, cursor: '25' });
    expect(r.parseFollowersListStrict({ users, next_max_id: 50 }, AT)).toMatchObject({ hasMore: true, cursor: '50' });
    expect(r.parseFollowersListStrict({ users }, AT)).toMatchObject({
      hasMore: false, continuation: { kind: 'end', evidence: 'no-flags' },
    });
  });

  test('rows that do not read are quarantined and counted, never silently dropped', () => {
    const users = [{ pk: '7', username: 'u7' }, { username: 'no-id' }, 'not-a-row', { pk_id: '9' }];
    expect(r.parseFollowersListStrict({ users, has_more: false }, AT)).toMatchObject({ quarantined: 3 });
  });

  test('accepts a raw JSON string body', () => {
    const out = r.parseFollowersListStrict(JSON.stringify(followersPage1), AT);
    expect(out?.observations).toHaveLength(12);
    expect(out?.cursor).toBe('12');
  });

  test('a drifted body is null — never the typed EMPTY (end-of-list) shape', () => {
    // A SHAPE_MISMATCH collapsing to the empty page would let shape drift
    // originate an end-of-list claim (the fabricated-census bug).
    expect(r.parseFollowersListStrict({ nope: true }, AT)).toBeNull();
    expect(r.parseFollowingListStrict({ nope: true }, AT)).toBeNull();
  });

  test('a genuinely EMPTY page is a typed result, not null (drift stays distinguishable)', () => {
    const out = r.parseFollowersListStrict({ users: [] }, AT);
    expect(out).toEqual({ observations: [], cursor: null, hasMore: false,
      continuation: { kind: 'end', evidence: 'no-flags' }, quarantined: 0 });
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
      bio: 'seoul | ucla',
    });
  });

  test('extracts the biography so the prune bio filter has a fact to match on', () => {
    const body = { user: { pk: 9, username: 'x', biography: 'Dog mom 🐶 | photographer' } };
    expect(r.parseProfileInfo(body, AT)!.fields.bio).toBe('Dog mom 🐶 | photographer');
  });

  test('second profile fixture: counts preserved for ratio math', () => {
    const obs = r.parseProfileInfo(profileInfo2, AT);
    expect(obs!.fields.followers).toBe(1194);
    expect(obs!.fields.following).toBe(1131);
  });

  test('missing user -> null', () => {
    expect(r.parseProfileInfo({ user: null }, AT)).toBeNull();
    expect(r.parseProfileInfo({ data: {} }, AT, 'profile-graphql')).toBeNull();
  });

  test('a body carrying NO user container at all is drift, not a deletion', () => {
    // A soft-block body parses cleanly as JSON; reading it as "profile gone"
    // would retire a live account (ADR 0303). `null` here means gone, so drift
    // must not produce it silently — the Reader warns and yields null only
    // after SHAPE_MISMATCH, never confusing the two upstream.
    expect(SURFACE.extractProfileInfo({ status: 'fail' }, AT)).toBe(SHAPE_MISMATCH);
    expect(SURFACE.extractProfileInfo({}, AT)).toBe(SHAPE_MISMATCH);
  });

  test('both containers read: `user` (fetched) and `data.user` (observed)', () => {
    const info = r.parseProfileInfo(profileInfo1, AT);
    const gql = r.parseProfileInfo(profileGraphql1, AT, 'profile-graphql');
    expect(info!.accountPk).toBe('1000000003');
    expect(gql!.accountPk).toBe('1000000003');
    expect(info!.fields.followers).toBe(561);
    expect(gql!.fields.followers).toBe(561);
  });
});

describe('Reader.profileViewer', () => {
  const gql = (friendship: unknown): unknown => ({
    data: { user: { pk: '1', friendship_status: friendship } },
  });

  test('every direction from the GraphQL body (private followers visible when following)', () => {
    const fs = { following: true, outgoing_request: false, followed_by: true, incoming_request: true };
    expect(r.profileViewer(gql(fs))).toEqual({ following: true, requested: false, followsUs: true, incomingRequest: true });
  });

  test('each flag is read by presence: an absent key is null, never false', () => {
    expect(r.profileViewer(gql({ following: false, followed_by: false }))).toEqual({
      following: false, requested: null, followsUs: false, incomingRequest: null,
    });
  });

  test('a pending request to a private account reads as requested, not following', () => {
    expect(r.profileViewer(gql({ following: false, outgoing_request: true }))).toMatchObject({
      following: false,
      requested: true,
    });
  });

  test('the `/users/<pk>/info/` body carries no viewer flag — unknown, never false', () => {
    expect(r.profileViewer(profileInfo1, 'profile-info')).toEqual({
      following: null,
      requested: null,
      followsUs: null,
      incomingRequest: null,
    });
  });

  test('null when the flag or user is absent', () => {
    expect(r.profileViewer(gql({})).following).toBeNull();
    expect(r.profileViewer({ data: {} }).following).toBeNull();
    expect(r.profileViewer({}).following).toBeNull();
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
      incomingRequest: false,
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

  test('a renamed key reads as unknown (null), never as false', () => {
    const out = r.parseShowMany({ friendship_statuses: { '5': { is_following: true, outgoing_request: false } } }, AT);
    expect(out).toEqual([{ pk: '5', following: null, outgoingRequest: false, incomingRequest: null, isPrivate: undefined }]);
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
      incomingRequest: false,
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
  const GRAPHQL_URL = 'https://www.instagram.com/api/graphql';
  const GQL_NAME = 'PolarisProfilePageContentQuery';
  const PROFILE_URL = 'https://www.instagram.com/api/v1/users/1000000003/info/';

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

  test('friendship-show with following and outgoing_request both false → weFollow false', () => {
    const body = { following: false, followed_by: true, outgoing_request: false, status: 'ok' };
    expect(r.relationshipFacts(SHOW_URL, body, AT)).toEqual([{ pk: '999', weFollow: false }]);
  });

  test('friendship-show with following:false but no outgoing_request → no fact (unknown)', () => {
    const body = { following: false, followed_by: true, status: 'ok' };
    expect(r.relationshipFacts(SHOW_URL, body, AT)).toEqual([]);
  });

  test('the observed GraphQL profile → fact from pk + friendship_status', () => {
    expect(r.relationshipFacts(GRAPHQL_URL, profileGraphql1, AT, GQL_NAME)).toEqual([
      { pk: '1000000003', weFollow: true },
    ]);
  });

  test('the FETCHED profile body carries no relationship → []', () => {
    // `/users/<pk>/info/` has no viewer side, so it is not relationship-bearing
    // at all — reading it as "we do not follow them" would retire live records.
    expect(r.relationshipBearing(PROFILE_URL)).toBe(false);
    expect(r.relationshipFacts(PROFILE_URL, profileInfo1, AT)).toEqual([]);
  });

  test('the GraphQL profile without a user or without the flag → []', () => {
    expect(r.relationshipFacts(GRAPHQL_URL, { data: {} }, AT, GQL_NAME)).toEqual([]);
    expect(
      r.relationshipFacts(GRAPHQL_URL, { data: { user: { pk: '1', username: 'x' } } }, AT, GQL_NAME),
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
      outgoingRequest: null,
      incomingRequest: null,
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
    // Following is read in the fixed order (the default is re-ranked per request).
    expect(script).toContain("/following/?count=50&order=date_followed_earliest'");
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

    expect(r.parseActivityFeedStrict(body)).toEqual([
      { pk: '11', username: 'alpha', atMs: 2500 },
      { pk: '22', username: null, atMs: null },
      { pk: '44', username: null, atMs: 7000 },
    ]);
  });

  test('an empty feed parses to an empty list (valid: nobody followed recently)', () => {
    expect(r.parseActivityFeedStrict(inbox([], []))).toEqual([]);
  });

  test('a body with NO story containers is shape drift → null (warned), never invented events', () => {
    expect(r.parseActivityFeedStrict({ status: 'fail' })).toBeNull();
    expect(r.parseActivityFeedStrict('not json at all {')).toBeNull();
  });

  test('entries without a usable profile_id are skipped', () => {
    const body = inbox(
      [{ story_type: 101, args: { text: 'x started following you.' } }],
      [],
    );
    expect(r.parseActivityFeedStrict(body)).toEqual([]);
  });
});

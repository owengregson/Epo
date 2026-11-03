import { isShapeMismatch, SHAPE_MISMATCH, SURFACE } from '@/adapter/ig-surface';
import { Reader } from '@/adapter/reader';
import type { SurfaceRead } from '@/surface/read/types';
import followersLast from '../fixtures/adapter/followers-list-last.json';
import followersPage1 from '../fixtures/adapter/followers-list-page1.json';
import friendshipShowPrivate from '../fixtures/adapter/friendship-show-private.json';
import friendshipShowPublic from '../fixtures/adapter/friendship-show-public.json';
import profileGraphql1 from '../fixtures/adapter/profile-graphql-1.json';
import profileInfo1 from '../fixtures/adapter/profile-info-1.json';
import profileInfo2 from '../fixtures/adapter/profile-info-2.json';
import showMany from '../fixtures/adapter/show-many.json';
import { mkResp } from '../kit/fakes';
import { PROFILE_QUERY, readAs } from '../kit/surface';

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

describe('Reader.readListPage: one friendships page (the document drives both lists)', () => {
  const page = (body: unknown, which: 'followers-list' | 'following-list' = 'followers-list') =>
    r.readListPage(which, typeof body === 'string' ? { ok: true, json: JSON.parse(body), format: 'json', payloads: 1, final: null }
      : { ok: true, json: body, format: 'json', payloads: 1, final: null }, AT);
  const projection = (read: ReturnType<typeof page>) => (read.ok ? read.projection : null);

  test('the following-list body reads with the followers-list shape', () => {
    const out = projection(page(followersPage1, 'following-list'));
    expect(out?.facts).toHaveLength(12);
    expect(out?.cursor).toBe('12');
    expect(out?.hasMore).toBe(true);
    expect(out?.facts[0]).toMatchObject({ accountPk: '1000000002', source: 'following-list' });
  });

  test('extracts users, cursor and continuation from a real followers page', () => {
    const read = page(followersPage1);
    expect(read).toMatchObject({ ok: true, tier: 'canonical', partial: false });
    const out = projection(read);
    if (out === null) return;
    expect(out.facts).toHaveLength(12);
    expect(out.cursor).toBe('12');
    expect(out.hasMore).toBe(true);
    expect(out.continuation).toEqual({ kind: 'next', cursor: '12', form: 'offset' });
    expect(out.rowIssues).toEqual([]);

    const first = out.facts[0];
    expect(first).toMatchObject({ accountPk: '1000000002', observedAt: AT, source: 'followers-list' });
    expect(first.fields).toEqual({ username: 'user_002', isPrivate: true, isVerified: false });

    // Every pk is a numeric string; usernames survive scrubbing.
    for (const obs of out.facts) {
      expect(obs.accountPk).toMatch(/^\d+$/);
      expect(obs.source).toBe('followers-list');
    }
    expect(out.facts[1]).toMatchObject({ accountPk: '1000000006', fields: { username: 'user_004' } });
  });

  test('the last page has no cursor and ends on the server flags', () => {
    const out = projection(page(followersLast));
    expect(out?.facts).toHaveLength(3);
    expect(out?.cursor).toBeNull();
    expect(out?.hasMore).toBe(false);
    expect(out?.continuation).toEqual({ kind: 'end', evidence: 'flags-false' });
  });

  test('more-pages detection: a cursor continues, a flag without one is drift, nothing is an end without evidence', () => {
    const users = [{ pk: '7', username: 'u7', is_private: false, is_verified: false }];
    expect(projection(page({ users, big_list: true }))).toMatchObject({
      hasMore: true, cursor: null, continuation: { kind: 'drift', reason: 'more-without-cursor', key: 'big_list' },
    });
    expect(projection(page({ users, next_max_id: '25' }))).toMatchObject({ hasMore: true, cursor: '25' });
    expect(projection(page({ users, next_max_id: 50 }))).toMatchObject({ hasMore: true, cursor: '50' });
    expect(projection(page({ users }))).toMatchObject({ hasMore: false, continuation: { kind: 'end', evidence: 'no-flags' } });
  });

  test('a row that does not read is quarantined and counted; a page that mostly fails is unreadable', () => {
    const good = Array.from({ length: 10 }, (_, i) => ({ pk: String(i + 1), username: `u${i + 1}` }));
    expect(projection(page({ users: [...good, { username: 'no-id' }], has_more: false }))?.rowIssues).toHaveLength(1);
    // An agreeing alias still reads the row (a normalized step), never a quarantine.
    expect(page({ users: [...good, { pk_id: '99', username: 'u99' }], has_more: false })).toMatchObject({ ok: true, tier: 'normalized' });
    const users = [{ pk: '7', username: 'u7' }, { username: 'no-id' }, 'not-a-row'];
    expect(page({ users, has_more: false })).toMatchObject({ ok: false, kind: 'rows-unreadable', rows: 3, quarantined: 2 });
  });

  test('accepts a raw JSON string body', () => {
    const out = projection(page(JSON.stringify(followersPage1)));
    expect(out?.facts).toHaveLength(12);
    expect(out?.cursor).toBe('12');
  });

  test('a drifted body is a typed failure — never the typed EMPTY (end-of-list) page', () => {
    // A SHAPE_MISMATCH collapsing to the empty page would let shape drift
    // originate an end-of-list claim (the fabricated-census bug).
    expect(page({ nope: true })).toMatchObject({ ok: false, kind: 'mismatch' });
    expect(page({ nope: true }, 'following-list')).toMatchObject({ ok: false, kind: 'mismatch' });
  });

  test('a genuinely EMPTY page is a read, not a failure (drift stays distinguishable)', () => {
    expect(projection(page({ users: [] }))).toMatchObject({ facts: [], cursor: null, hasMore: false,
      continuation: { kind: 'end', evidence: 'no-flags' }, rowIssues: [] });
  });
});

describe('Reader.read: the profile record (the document drives both containers)', () => {
  const info = (body: unknown): SurfaceRead => readAs(r, 'profile-info', body, { at: AT });
  const gql = (body: unknown): SurfaceRead => readAs(r, 'profile-graphql', body, { at: AT }, PROFILE_QUERY);
  const fact = (read: SurfaceRead) => (read.ok ? read.projection.facts[0] : undefined);

  test('extracts pk, username, follower/following counts', () => {
    const obs = fact(info(profileInfo1));
    expect(obs).toMatchObject({ accountPk: '1000000003', observedAt: AT, source: 'profile' });
    expect(obs?.fields).toEqual({
      username: 'user_005',
      followers: 561,
      following: 305,
      mutuals: 18,
      isPrivate: true,
      isVerified: false,
      bio: 'seoul | ucla',
    });
  });

  test('extracts the biography so the protection rule has a fact to match on', () => {
    const body = { user: { pk: 9, username: 'x', biography: 'Dog mom 🐶 | photographer' } };
    expect(fact(info(body))?.fields.bio).toBe('Dog mom 🐶 | photographer');
  });

  test('second profile fixture: counts preserved for ratio math', () => {
    expect(fact(info(profileInfo2))?.fields).toMatchObject({ followers: 1194, following: 1131 });
  });

  test("an explicit null user is Instagram's own \"gone\"; a missing one is drift", () => {
    expect(info({ user: null })).toMatchObject({ ok: true, projection: { absent: true, facts: [] } });
    expect(gql({ data: {} })).toMatchObject({ ok: false, kind: 'mismatch' });
  });

  test('a body carrying NO user container at all is drift, not a deletion', () => {
    // A soft-block body parses cleanly as JSON; reading it as "profile gone" would retire a live account (ADR 0303).
    expect(info({ status: 'fail' })).toMatchObject({ ok: false, kind: 'mismatch', keys: ['status'] });
    expect(info({})).toMatchObject({ ok: false, kind: 'mismatch' });
  });

  test('both containers read: `user` (fetched) and `data.user` (observed)', () => {
    expect(fact(info(profileInfo1))).toMatchObject({ accountPk: '1000000003', fields: { followers: 561 } });
    expect(fact(gql(profileGraphql1))).toMatchObject({ accountPk: '1000000003', fields: { followers: 561 } });
  });
});

describe('Reader.profileSeen: the viewer flags', () => {
  const gql = (friendship: unknown): SurfaceRead =>
    readAs(r, 'profile-graphql', { data: { user: { pk: '1', friendship_status: friendship } } }, { at: AT }, PROFILE_QUERY);
  const viewerOf = (read: SurfaceRead) => r.profileSeen(read, null)?.viewer;

  test('every direction from the GraphQL body (private followers visible when following)', () => {
    const fs = { following: true, outgoing_request: false, followed_by: true, incoming_request: true };
    expect(viewerOf(gql(fs))).toEqual({ following: true, requested: false, followsUs: true, incomingRequest: true });
  });

  test('each flag is read by presence: an absent key is null, never false', () => {
    expect(viewerOf(gql({ following: false, followed_by: false }))).toEqual({
      following: false, requested: null, followsUs: false, incomingRequest: null,
    });
  });

  test('a pending request to a private account reads as requested, not following', () => {
    expect(viewerOf(gql({ following: false, outgoing_request: true }))).toMatchObject({ following: false, requested: true });
  });

  test('the `/users/<pk>/info/` body carries no viewer flag — unknown, never false', () => {
    expect(viewerOf(readAs(r, 'profile-info', profileInfo1, { at: AT }))).toEqual({
      following: null, requested: null, followsUs: null, incomingRequest: null,
    });
  });

  test('every flag unknown when the relationship is empty; no profile at all when the user is', () => {
    expect(viewerOf(gql({}))?.following).toBeNull();
    expect(r.profileSeen(readAs(r, 'profile-graphql', { data: {} }, { at: AT }, PROFILE_QUERY), null)).toBeNull();
  });
});

describe('Reader.read: the batched relationship map (the document drives it)', () => {
  const rows = (body: unknown) => {
    const read = readAs(r, 'show-many', body, { at: AT });
    return read.ok ? read.projection.relationships : null;
  };

  test('maps friendship_statuses to per-pk following flags', () => {
    const out = rows(showMany) ?? [];
    expect(out).toHaveLength(12);
    const byPk = new Map(out.map((e) => [e.pk, e]));
    // This shape carries NO followed_by direction: unknown (null), never false.
    expect(byPk.get('1000000001')).toEqual({
      pk: '1000000001', following: true, outgoingRequest: false, followedBy: null, incomingRequest: false, isPrivate: true,
    });
    expect(byPk.get('1000000002')?.following).toBe(false);
    expect(out.filter((e) => e.following).length).toBe(5);
    expect(out.every((e) => e.followedBy === null)).toBe(true);
  });

  test('a body that is not the map is drift, never an empty map', () => {
    expect(readAs(r, 'show-many', { nope: true }, { at: AT })).toMatchObject({ ok: false, kind: 'mismatch' });
  });

  test('a renamed key reads as unknown (null), never as false', () => {
    expect(rows({ friendship_statuses: { '5': { is_following: true, outgoing_request: false } } })).toEqual([
      { pk: '5', following: null, outgoingRequest: false, followedBy: null, incomingRequest: null, isPrivate: undefined },
    ]);
  });
});

describe('Reader.read: the single relationship (the document drives it)', () => {
  const row = (body: unknown, pk: string) => {
    const read = readAs(r, 'friendship-show', body, { at: AT, pk });
    return read.ok ? read.projection.relationships[0] : null;
  };

  test('reads both directions; followedBy comes from followed_by', () => {
    expect(row(friendshipShowPrivate, '999')).toEqual({
      pk: '999', following: true, followedBy: true, outgoingRequest: false, incomingRequest: false, isPrivate: true,
    });
  });

  test('public account variant', () => {
    expect(row(friendshipShowPublic, '1000000042')).toMatchObject({ pk: '1000000042', followedBy: true, isPrivate: false });
  });

  test('a body that is not a relationship is drift (unparsed is NOT "no relationship")', () => {
    // An error body ({"status":"fail"}-style) must never parse to all-false:
    // a false "we do not follow them" fact terminates held records downstream.
    expect(readAs(r, 'friendship-show', { nope: true }, { at: AT, pk: '42' })).toMatchObject({ ok: false, kind: 'mismatch' });
  });

  test('a pending private-account request reads as outgoingRequest', () => {
    expect(row({ following: false, followed_by: false, outgoing_request: true, is_private: true }, '77'))
      .toMatchObject({ following: false, outgoingRequest: true });
  });
});

describe('Reader.relationshipFacts(read)', () => {
  const SHOW_MANY_URL = 'https://i.instagram.com/api/v1/friendships/show_many/';
  const SHOW_URL = 'https://www.instagram.com/api/v1/friendships/show/999/';
  const PROFILE_URL = 'https://www.instagram.com/api/v1/users/1000000003/info/';
  /** One observed response's facts, read the way the reconciler reads it. */
  const factsOf = async (url: string, body: unknown) => {
    const seen = await r.observed.read(mkResp(url, body), AT);
    return seen === null ? null : r.relationshipFacts(seen.read);
  };

  test('show-many → one fact per entry, weFollow from following', async () => {
    const facts = (await factsOf(SHOW_MANY_URL, showMany)) ?? [];
    expect(facts).toHaveLength(12);
    const byPk = new Map(facts.map((f) => [f.pk, f.weFollow]));
    expect(byPk.get('1000000001')).toBe(true);
    expect(byPk.get('1000000002')).toBe(false);
    expect(facts.filter((f) => f.weFollow)).toHaveLength(5);
  });

  test('friendship-show → single fact keyed by the URL pk', async () => {
    expect(await factsOf(SHOW_URL, friendshipShowPrivate)).toEqual([{ pk: '999', weFollow: true }]);
  });

  test('friendship-show with following and outgoing_request both false → weFollow false', async () => {
    const body = { following: false, followed_by: true, outgoing_request: false, status: 'ok' };
    expect(await factsOf(SHOW_URL, body)).toEqual([{ pk: '999', weFollow: false }]);
  });

  test('friendship-show with following:false but no outgoing_request → no fact (unknown)', async () => {
    expect(await factsOf(SHOW_URL, { following: false, followed_by: true, status: 'ok' })).toEqual([]);
  });

  test('the observed GraphQL profile → fact from pk + friendship_status', () => {
    expect(r.relationshipFacts(readAs(r, 'profile-graphql', profileGraphql1, { at: AT }, PROFILE_QUERY))).toEqual([
      { pk: '1000000003', weFollow: true },
    ]);
  });

  test('the FETCHED profile body carries no relationship → []', () => {
    // `/users/<pk>/info/` has no viewer side, so it is not relationship-bearing
    // at all — reading it as "we do not follow them" would retire live records.
    expect(r.relationshipBearing(PROFILE_URL)).toBe(false);
    expect(r.relationshipFacts(readAs(r, 'profile-info', profileInfo1, { at: AT }))).toEqual([]);
  });

  test('the GraphQL profile without a user or without the flag → []', () => {
    expect(r.relationshipFacts(readAs(r, 'profile-graphql', { data: {} }, { at: AT }, PROFILE_QUERY))).toEqual([]);
    const flagless = { data: { user: { pk: '1', username: 'x' } } };
    expect(r.relationshipFacts(readAs(r, 'profile-graphql', flagless, { at: AT }, PROFILE_QUERY))).toEqual([]);
  });

  test('accepts a raw JSON string body', async () => {
    expect(await factsOf(SHOW_MANY_URL, JSON.stringify(showMany))).toHaveLength(12);
  });

  test('non-relationship endpoints carry no facts; an unrelated URL is no read at all', async () => {
    expect(await factsOf('https://www.instagram.com/api/v1/news/inbox/', { new_stories: [], old_stories: [] })).toEqual([]);
    expect(await factsOf('https://example.com/', showMany)).toBeNull();
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

describe('Reader.read: the activity feed (the document drives it)', () => {
  const inbox = (newStories: unknown[], oldStories: unknown[]): unknown => ({
    counts: {},
    new_stories: newStories,
    old_stories: oldStories,
  });
  const eventsOf = (body: unknown) => {
    const read = typeof body === 'string' ? r.read('activity-feed', { text: body }, { at: AT }) : readAs(r, 'activity-feed', body, { at: AT });
    return read.ok ? read.projection.events : null;
  };
  const T = AT / 1_000;

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
          args: { profile_id: 11, profile_name: 'alpha', timestamp: T + 2.5, text: 'alpha started following you.' },
        },
        // Drifted story_type but recognizable text → still admitted.
        {
          story_type: 999,
          args: { profile_id: '22', text: 'beta started following you.' },
        },
      ],
      [
        // Non-follow story → ignored.
        { story_type: 60, args: { profile_id: 33, text: 'gamma liked your photo.', timestamp: T + 9 } },
        // Follow type with no text → still admitted (type signal alone).
        { story_type: 101, args: { profile_id: 44, timestamp: T + 7 } },
      ],
    );

    expect(eventsOf(body)).toEqual([
      { pk: '11', username: 'alpha', atMs: AT + 2_500 },
      { pk: '22', username: null, atMs: null },
      { pk: '44', username: null, atMs: AT + 7_000 },
    ]);
  });

  test('an epoch outside the plausible range is an unknown time, never a wrong date (I9)', () => {
    expect(eventsOf(inbox([{ story_type: 101, args: { profile_id: 11, timestamp: 2.5 } }], []))).toEqual([
      { pk: '11', username: null, atMs: null },
    ]);
  });

  test('an empty feed parses to an empty list (valid: nobody followed recently)', () => {
    expect(eventsOf(inbox([], []))).toEqual([]);
  });

  test('a body with NO story containers is shape drift, never invented events', () => {
    expect(eventsOf({ status: 'fail' })).toBeNull();
    expect(eventsOf('not json at all {')).toBeNull();
  });

  test('entries without a usable profile_id are skipped (and counted)', () => {
    const body = inbox(
      [{ story_type: 101, args: { text: 'x started following you.' } }],
      [],
    );
    expect(eventsOf(body)).toEqual([]);
    expect(readAs(r, 'activity-feed', body, { at: AT })).toMatchObject({ ok: true, projection: { rowIssues: [{ index: 0 }] } });
  });
});

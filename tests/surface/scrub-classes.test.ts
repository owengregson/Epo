/**
 * The scrubber's extensions (spec §10.8): counts keep their leading digits, times shift into the synthetic
 * window with order and intervals kept, every id alias agrees, nulls stay null; the structural leak rules
 * fire on identity and stay quiet on scrubbed text; the fingerprint and the router see shape, never values.
 */

import { SCRUB_POLICY } from '@/kernel/scrub-policy';
import { SURFACE_BOUNDS } from '@/kernel/surface-policy';
import { Scrubber, SYNTHETIC_TIME_BASE, scrubCount } from '@/surface/lab/scrub';
import { SCRUB_SHAPES } from '@/surface/lab/shape';
import { isSyntheticRun, structuralLeaks } from '@/surface/lab/structural-leak';
import { facets, keyPaths } from '@/surface-lab/fingerprint';
import { emptyOriginals, harvestValue, residual } from '@/surface-lab/originals';
import { routeExchange } from '@/surface-lab/select';

const feed = (stories: unknown[]): unknown => ({ data: { xdt_activity_inbox: { new_stories: [], old_stories: stories } } });
const story = (timestamp: number, pk: string): unknown => ({
  story_type: 101, pk: `9${pk}`, args: { timestamp, profile_id: pk, profile_name: `real.${pk}`, text: `real.${pk} started following you.` },
});

describe('counts', () => {
  test('a count at or above the floor keeps its leading digits; a smaller one is kept', () => {
    expect(scrubCount(SURFACE_BOUNDS.scrubCountFloor - 1)).toBe(SURFACE_BOUNDS.scrubCountFloor - 1);
    expect(scrubCount(1234)).toBe(1200);
    expect(scrubCount(56_789)).toBe(57_000);
    expect(String(scrubCount(987_654)).replace(/0+$/, '').length).toBeLessThanOrEqual(SURFACE_BOUNDS.scrubCountDigits);
  });

  test('profile counts are rounded and a null count stays null', () => {
    const out = new Scrubber().body(SCRUB_SHAPES['profile-graphql'], {
      data: { user: { pk: '123456789', follower_count: 4321, following_count: 87, mutual_followers_count: null } },
    }) as { data: { user: Record<string, unknown> } };
    expect(out.data.user).toMatchObject({ follower_count: 4300, following_count: 87, mutual_followers_count: null });
  });
});

describe('times', () => {
  test('the earliest seeded time lands on the base; order, intervals and fractions survive', () => {
    const scrubber = new Scrubber();
    const body = feed([story(1_762_000_100.25, '111111111'), story(1_762_000_000.5, '222222222')]);
    scrubber.seedTimes(SCRUB_SHAPES['activity-feed'], [body]);
    const out = scrubber.body(SCRUB_SHAPES['activity-feed'], body) as { data: { xdt_activity_inbox: {
      old_stories: Array<{ args: { timestamp: number } }> } } };
    const [later, earlier] = out.data.xdt_activity_inbox.old_stories.map((s) => s.args.timestamp);
    expect(earlier).toBe(SYNTHETIC_TIME_BASE + 0.5);
    expect(later).toBe(SYNTHETIC_TIME_BASE + 100.25);
    expect(isSyntheticRun(String(Math.trunc(later as number)))).toBe(true);
  });
});

describe('ids and nulls', () => {
  test('pk, pk_id, id and strong_id__ of one row agree; fbid_v2 gets its own synthetic id', () => {
    const out = new Scrubber().body(SCRUB_SHAPES['followers-list'], {
      users: [{ pk: '123456789', pk_id: '123456789', id: '123456789', strong_id__: '123456789', fbid_v2: '987654321',
        username: 'real.handle' }],
    }) as { users: Array<Record<string, unknown>> };
    const row = out.users[0] as Record<string, unknown>;
    expect(new Set([row.pk, row.pk_id, row.id, row.strong_id__]).size).toBe(1);
    expect(row.fbid_v2).not.toBe(row.pk);
    expect(row.username).toMatch(/^user_[a-z]\d+$/);
  });

  test('a null under any class stays null; an unknown string becomes its type name', () => {
    const out = new Scrubber().body(SCRUB_SHAPES['profile-graphql'], {
      data: { user: { pk: '123456789', biography: null, full_name: null, external_url: 'https://x.example/me' } },
    }) as { data: { user: Record<string, unknown> } };
    expect(out.data.user).toMatchObject({ biography: null, full_name: null, external_url: 'string' });
  });

  test('the residual check names the class that survived, never the value', () => {
    const originals = emptyOriginals();
    harvestValue({ username: 'real.handle', full_name: 'Real Person', pk: '123456789' }, originals);
    expect(residual('{"note":"123456789"}', originals)).toBe('pk');
    expect(residual('{"u":"real.handle"}', originals)).toBe('handle');
    expect(residual('{"n":"Real Person"}', originals)).toBe('name');
    expect(residual('{"u":"user_a1"}', originals)).toBeNull();
  });
});

describe('the structural leak rules', () => {
  test.each([
    ['media-url', 'https://scontent-x.cdninstagram.com/v/p.jpg'],
    ['foreign-url', '"https://www.instagram.com/someone/"'],
    ['cookie-name', 'sessionid=abc'],
    ['opaque-token', `"${'a1'.repeat(25)}"`],
    ['handle-mention', 'hi @real.handle'],
    ['handle-href', '<a href="/real.handle/">'],
    ['id-run', '"pk":"123456789012"'],
  ])('%s fires', (rule, text) => {
    expect(structuralLeaks(text)).toContain(rule);
  });

  test('scrubber output breaks no rule', () => {
    const synthetic = String(SCRUB_POLICY.syntheticPkBase + 7);
    const text = `{"pk":"${synthetic}","u":"user_b2","t":${SYNTHETIC_TIME_BASE + 9}.5,"op":"PolarisProfilePageContentQuery",` +
      `"pic":"https://example.invalid/pic/${synthetic}.jpg"}`;
    expect(structuralLeaks(text)).toEqual([]);
    expect(structuralLeaks('"at":1786534400000', ['1786534400000'])).toEqual([]);
  });
});

describe('fingerprint and routing', () => {
  test('key paths collapse arrays, mark nulls and never carry a value or a digit-only key', () => {
    const paths = keyPaths({ users: [{ pk: '1', name: null }], friendship_statuses: { 123456789: { following: true } } });
    expect(paths).toEqual(['friendship_statuses', 'friendship_statuses.*', 'friendship_statuses.*.following', 'users',
      'users[].name=null', 'users[].pk']);
  });

  test('facets: a profile tells self from another account; a requests body buckets its rows', () => {
    expect(facets('profile-graphql', { data: { user: { friendship_status: null, is_private: false,
      mutual_followers_count: null } } }, undefined)).toEqual(['relationship:self', 'private:false', 'mutuals:null']);
    expect(facets('friend-requests', { data: { xdt_friendships_pending_users: { users: { edges: [],
      page_info: { has_next_page: false } } } } }, undefined)).toEqual(['rows:none', 'next:false']);
  });

  test.each([
    ['/api/graphql', 'PolarisProfilePageContentQuery', 'profile-graphql'],
    ['/api/graphql', 'PolarisActivityFeedStoriesViewQuery', 'activity-feed'],
    ['/graphql/query', 'PolarisActivityFeedFollowRequestsViewQuery', 'friend-requests'],
  ])('%s with %s routes to %s', (path, op, kind) => {
    expect(routeExchange({ method: 'POST', path, headers: { 'x-fb-friendly-name': op } })?.kind).toBe(kind);
  });

  test('an unrelated GraphQL operation routes nowhere', () => {
    expect(routeExchange({ method: 'POST', path: '/api/graphql', headers: { 'x-fb-friendly-name': 'PolarisProfilePostsQuery' } }))
      .toBeNull();
  });
});

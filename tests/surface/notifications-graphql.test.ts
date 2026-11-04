/**
 * The notifications drawer's GraphQL reads (live 2026-11-02, `EPO_PROBE=verify`).
 *
 * Instagram's own client stopped calling `news/inbox` and `friendships/pending`;
 * it reads the same stories and rows through `PolarisActivityFeedStoriesViewQuery`
 * (`/api/graphql`, `data.xdt_activity_inbox`) and
 * `PolarisActivityFeedFollowRequestsViewQuery` (`/graphql/query`,
 * `data.xdt_friendships_pending_users.users.edges[].node`). Pinned here: both are
 * routed by operation name to the existing kinds, the document projects the
 * expected facts, and the scrub shape knows the new containers. Bodies are synthetic, shaped like the live ones.
 */
import { SURFACE } from '@/adapter/ig-surface';
import { endpointKinds, matchEndpoint } from '@/surface/index';
import { novelKeys, SCRUB_SHAPES, shapeOf } from '@/surface/lab/shape';
import { readResponse } from '@/surface/parse';

const FEED_OP = 'PolarisActivityFeedStoriesViewQuery';
const REQUESTS_OP = 'PolarisActivityFeedFollowRequestsViewQuery';

const feed = {
  data: {
    xdt_activity_inbox: {
      new_stories: [],
      old_stories: [
        { story_type: 101, args: { profile_id: '11', profile_name: 'user_011', timestamp: 1_700_000_000.5, text: 'user_011 started following you.' } },
        { story_type: 651, args: { profile_id: '12', profile_name: 'user_012', timestamp: 1_700_000_001, text: 'user_012 liked your story.' } },
      ],
    },
    xdt_api__v1__friendships__pending: { users: [] },
  },
  extensions: { is_final: true },
};

const requests = {
  data: {
    xdt_friendships_pending_users: {
      users: {
        edges: [
          { node: { pk: '21', id: '21', username: 'user_021', full_name: 'User 21' }, cursor: null },
          { node: { pk: '22', id: '22', username: 'user_022', full_name: 'User 22' }, cursor: null },
        ],
        page_info: { end_cursor: null, has_next_page: false },
      },
    },
  },
};

describe('routing: the drawer queries reach the existing kinds by operation name', () => {
  test.each([
    ['/api/graphql', FEED_OP, 'activity-feed'],
    ['/graphql/query', REQUESTS_OP, 'friend-requests'],
  ])('%s + %s → %s (document and façade agree)', (url, op, kind) => {
    expect(matchEndpoint(`https://www.instagram.com${url}`, op)?.kind).toBe(kind);
    expect(SURFACE.matchEndpoint(`https://www.instagram.com${url}`, op)).toBe(kind);
  });

  test('an unrelated GraphQL query on the same path routes nowhere', () => {
    expect(SURFACE.matchEndpoint('https://www.instagram.com/api/graphql', 'PolarisSuggestedUserListQuery')).toBeNull();
    expect(SURFACE.matchEndpoint('https://www.instagram.com/api/graphql')).toBeNull();
  });

  test('the REST forms still route (one kind, either container)', () => {
    expect(SURFACE.matchEndpoint('https://www.instagram.com/api/v1/news/inbox/')).toBe('activity-feed');
    expect(SURFACE.matchEndpoint('https://www.instagram.com/api/v1/friendships/pending/')).toBe('friend-requests');
    expect(new Set(endpointKinds()).has('activity-feed')).toBe(true);
  });
});

describe('the document projects the GraphQL feed and requests bodies', () => {
  const endpoint = (kind: string, op: string) => {
    const url = `https://www.instagram.com/${kind === 'activity-feed' ? 'api/graphql' : 'graphql/query'}`;
    const def = matchEndpoint(url, op);
    if (def === null) throw new Error(`no endpoint for ${op}`);
    return def;
  };

  test('feed: one follow event, the like story ignored', () => {
    const read = readResponse(endpoint('activity-feed', FEED_OP), feed, { at: 1_700_000_100_000, source: 'activity-feed' });
    expect(read.ok && read.projection.events).toEqual([{ pk: '11', username: 'user_011', atMs: 1_700_000_000_500 }]);
  });

  test('requests: the connection nodes become the list rows, end of list known', () => {
    const read = readResponse(endpoint('friend-requests', REQUESTS_OP), requests, { at: 1, source: 'friend-requests' });
    expect(read.ok && read.projection.facts.map((f) => [f.accountPk, f.fields.username])).toEqual([
      ['21', 'user_021'], ['22', 'user_022'],
    ]);
    expect(read.ok && read.projection.cursor).toBeNull();
    expect(read.ok && read.projection.hasMore).toBe(false);
  });

  test('a GraphQL body with neither container is drift, never an empty feed', () => {
    const read = readResponse(endpoint('activity-feed', FEED_OP), { data: { something_else: {} } }, { at: 1, source: 'activity-feed' });
    expect(read.ok).toBe(false);
  });
});

test('the scrub/novelty shapes know the GraphQL containers', () => {
  expect(novelKeys(feed, shapeOf(SCRUB_SHAPES['activity-feed']))).not.toContain('data');
  expect(novelKeys(requests, shapeOf(SCRUB_SHAPES['friend-requests']))).not.toContain('data');
});

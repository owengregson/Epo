/**
 * Routing (spec §10.5): REST by URL; GraphQL by the operation-name header, the profile on ANY
 * GraphQL path; then the root-field header against a definition's declared root fields (C1).
 */
import { SURFACE } from '@/adapter/ig-surface';
import { routeOf, surface } from '@/surface/index';
import { routeObserved } from '@/surface/read/route';
import { TRANSPORT } from '@/surface/versions/2026-08-12/transport-decl';

const IG = 'https://www.instagram.com';
const env = { doc: surface(), transport: TRANSPORT };
const route = (path: string, headers?: Record<string, string>) =>
  routeObserved({ url: `${IG}${path}`, requestHeaders: headers }, env);
const op = (name: string) => ({ 'x-fb-friendly-name': name });

describe('routeObserved', () => {
  test('REST endpoints route by URL, friendship-show before the other friendships URLs', () => {
    expect(route('/api/v1/friendships/show/12345/')).toMatchObject({ kind: 'friendship-show', via: 'url', op: null });
    expect(route('/api/v1/friendships/show_many/')).toMatchObject({ kind: 'show-many', via: 'url' });
    expect(route('/api/v1/friendships/17841400000/followers/?count=12')).toMatchObject({ kind: 'followers-list' });
  });

  test('the profile query routes by its operation name on ANY GraphQL path', () => {
    for (const path of ['/api/graphql', '/graphql/query', '/api/graphql/']) {
      expect(route(path, op('PolarisProfilePageContentQuery'))).toMatchObject({
        kind: 'profile-graphql', via: 'header', op: 'PolarisProfilePageContentQuery',
      });
    }
  });

  test('a GraphQL body without a known operation routes nowhere', () => {
    expect(route('/api/graphql')).toBeNull();
    expect(route('/api/graphql', op('PolarisSuggestedUserListQuery'))).toBeNull();
  });

  test('a renamed operation still routes by its declared root field (a normalized step)', () => {
    expect(route('/graphql/query', { ...op('PolarisFollowRequestsV2Query'), 'x-root-field-name': 'xdt_friendships_pending_users' }))
      .toMatchObject({ kind: 'friend-requests', via: 'root-field', op: 'PolarisFollowRequestsV2Query' });
    expect(route('/graphql/query', { 'x-root-field-name': 'xdt_something_else' })).toBeNull();
  });

  test('the document wrapper and the adapter façade route through the same table', () => {
    const req = { url: `${IG}/graphql/query`, requestHeaders: op('PolarisProfilePageContentQuery') };
    expect(routeOf(req)?.kind).toBe('profile-graphql');
    expect(SURFACE.matchEndpoint(req.url, 'PolarisProfilePageContentQuery')).toBe('profile-graphql');
  });
});

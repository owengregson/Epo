/**
 * `ObservedReads` (spec Appendix D.1): one observed response is routed, gated, decoded and read
 * ONCE however many consumers ask, so the sink counts it once; an unrouted response is no read; a
 * wall answers before any body read; the session's own pk names a null relationship's owner (I10).
 */
import { Reader } from '@/adapter/reader';
import type { TabResponse } from '@/shared/tab-response';
import { MemorySink } from '@/surface/sink';
import { setLevel } from '@/utils/logger';
import { mkProfileGraphqlResp, mkResp } from '../kit/fakes';

beforeAll(() => setLevel('error'));

const AT = 1_786_534_400_000;
const user = (fs: unknown) => ({
  pk: '42', id: '42', username: 'own', biography: '', follower_count: 10, following_count: 20, is_private: false,
  is_verified: false, friendship_status: fs,
});

function counted(resp: TabResponse): { resp: TabResponse; bodies: () => number } {
  let n = 0;
  const getBody = resp.getBody;
  return { resp: { ...resp, getBody: () => { n += 1; return getBody(); } }, bodies: () => n };
}

describe('one read per observed response', () => {
  test('every consumer shares one body read, one decode and one tally', async () => {
    const sink = new MemorySink();
    const reader = new Reader({ sink }, { viewerPk: '7', now: () => AT });
    const { resp, bodies } = counted(mkProfileGraphqlResp({ data: { user: user({ following: true, outgoing_request: false,
      followed_by: false, incoming_request: false }) } }));
    const [a, b] = await Promise.all([reader.observed.read(resp), reader.observed.read(resp)]);
    expect(a).toBe(b);
    expect(bodies()).toBe(1);
    expect(a?.read).toMatchObject({ ok: true, tier: 'canonical', endpoint: 'profile-graphql' });
    expect(a?.route).toMatchObject({ kind: 'profile-graphql', via: 'header' });
    expect(sink.snapshot().tallies['profile-graphql']).toEqual({ canonical: 1 });
  });

  test('an unrouted response is no read at all', () => {
    const reader = new Reader({ sink: new MemorySink() });
    expect(reader.observed.read(mkResp('https://www.instagram.com/api/graphql', {}, { 'x-fb-friendly-name': 'Other' }))).toBeNull();
  });

  test('a wall answers before any body read', async () => {
    const reader = new Reader({ sink: new MemorySink() });
    const { resp, bodies } = counted({ ...mkProfileGraphqlResp({}), status: 429 });
    const seen = await reader.observed.read(resp);
    expect(seen).toMatchObject({ decoded: null, read: { ok: false, kind: 'wall', family: 'rate-limited', via: 'http' } });
    expect(bodies()).toBe(0);
  });

  test('the subject pk of a relationship URL reaches the read', async () => {
    const reader = new Reader({ sink: new MemorySink() });
    const resp = mkResp('https://www.instagram.com/api/v1/friendships/show/314/',
      { following: false, followed_by: true, outgoing_request: false, incoming_request: false });
    const seen = await reader.observed.read({ ...resp, method: 'GET' });
    expect(seen?.read.ok && seen.read.projection.relationships).toEqual([
      { pk: '314', following: false, outgoingRequest: false, followedBy: true, incomingRequest: false, isPrivate: undefined },
    ]);
  });

  test('I10: the session names its own record when the body omits its viewer', async () => {
    const own = new Reader({ sink: new MemorySink() }, { viewerPk: '42' });
    const read = (await own.observed.read(mkProfileGraphqlResp({ data: { user: user(null) } })))?.read;
    expect(read?.ok && read.projection.presence?.relationship).toBe('self');
    const other = new Reader({ sink: new MemorySink() }, { viewerPk: '7' });
    const drifted = (await other.observed.read(mkProfileGraphqlResp({ data: { user: user(null) } })))?.read;
    expect(drifted?.ok && drifted.projection.fieldIssues).toEqual([{ path: 'friendship_status', kind: 'unexpected-null', got: 'null' }]);
  });
});

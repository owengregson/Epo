/**
 * The drawer read (spec §10.4): one pure read per notifications-drawer body. The follow-requests
 * panel is read strictly — a pending set is complete only when it read whole and the server said
 * there is no next page; the feed's side list of requesters is presence, never a complete set.
 */
import { readDrawerBody } from '@/adapter/drawer-read';
import { Reader } from '@/adapter/reader';
import { setLevel } from '@/utils/logger';

beforeAll(() => setLevel('error'));

const reader = new Reader();
const ctx = { reader, now: 1_234 };
const node = (pk: string) => ({ node: { pk, id: pk, username: `user_${pk}`, full_name: `User ${pk}` }, cursor: null });
const connection = (edges: unknown[], pageInfo?: Record<string, unknown>) => ({
  data: { xdt_friendships_pending_users: { users: { edges, ...(pageInfo === undefined ? {} : { page_info: pageInfo }) } } },
});
const requests = (body: unknown) => readDrawerBody({ kind: 'friend-requests', body }, ctx);

describe('the follow-requests panel is read strictly', () => {
  test('a whole page with no next page is the complete pending set, rows read at `now`', () => {
    const read = requests(connection([node('21'), node('22')], { end_cursor: null, has_next_page: false }));
    expect(read.requests.pendingComplete).toBe(true);
    expect(read.requests.rows.map((o) => [o.accountPk, o.observedAt, o.source])).toEqual([
      ['21', 1_234, 'friend-requests'], ['22', 1_234, 'friend-requests'],
    ]);
    expect(read.failure).toBeUndefined();
  });

  test('the REST pending page reads the same way', () => {
    const read = requests({ users: [{ pk: 31, username: 'user_031' }], big_list: false, next_max_id: null, page_size: 1, status: 'ok' });
    expect(read.requests).toEqual({ rows: [expect.objectContaining({ accountPk: '31' })], pendingComplete: true });
  });

  test('a next page means the set is incomplete, even at the canonical container', () => {
    const read = requests(connection([node('21')], { end_cursor: 'QVFE', has_next_page: true }));
    expect(read.requests.rows).toHaveLength(1);
    expect(read.requests.pendingComplete).toBe(false);
  });

  test('a page whose more-flag is missing is never claimed complete', () => {
    expect(requests(connection([node('21')])).requests.pendingComplete).toBe(false);
    expect(requests(connection([node('21')], { end_cursor: null })).requests.pendingComplete).toBe(false);
  });

  test('a renamed container is unreadable — never an empty pending set (U07 R1)', () => {
    const read = requests({ data: { xdt_friendships_pending_users_v2: { users: { edges: [node('21')] } } } });
    expect(read).toMatchObject({ requests: { rows: [], pendingComplete: false }, failure: 'requests-unreadable' });
  });

  test('rows that no longer read are unreadable — never a valid empty page (U07 R2)', () => {
    const renamed = [{ user: { pk: '21' } }, { user: { pk: '22' } }];
    const read = requests(connection(renamed, { end_cursor: null, has_next_page: false }));
    expect(read).toMatchObject({ requests: { rows: [], pendingComplete: false }, failure: 'requests-unreadable' });
  });

  test('a single unreadable row keeps the others but makes the set incomplete', () => {
    const edges = [...['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].map(node), { node: { username: 'no_id' } }];
    const read = requests(connection(edges, { end_cursor: null, has_next_page: false }));
    expect(read.requests.rows).toHaveLength(10);
    expect(read.requests.pendingComplete).toBe(false);
    expect(read.failure).toBeUndefined();
  });
});

describe('the feed', () => {
  const feed = (pending?: unknown) => ({
    data: {
      xdt_activity_inbox: { new_stories: [{ story_type: 101, args: { profile_id: '42', profile_name: 'u42',
        timestamp: 1_000, text: 'u42 started following you.' } }], old_stories: [] },
      ...(pending === undefined ? {} : { xdt_api__v1__friendships__pending: pending }),
    },
  });

  test('a well-formed inbox body reads its follow events', () => {
    const read = readDrawerBody({ kind: 'activity-feed', body: feed() }, ctx);
    expect(read.events?.map((e) => e.pk)).toEqual(['42']);
    expect(read.requests).toEqual({ rows: [], pendingComplete: false });
  });

  test('a drifted feed body reads as a shape mismatch, never as an empty feed', () => {
    const read = readDrawerBody({ kind: 'activity-feed', body: { data: { other: {} } } }, ctx);
    expect(read.events).toBeNull();
    expect(read.failure).toBe('shape-mismatch');
  });

  test('the side list of requesters is read row by row as presence, never as a complete set', () => {
    const read = readDrawerBody({ kind: 'activity-feed', body: feed({ users: [{ pk: '51', username: 'u51' }, { username: 'no_id' },
      { pk: '52', username: 'u52' }] }) }, ctx);
    expect(read.pendingPreview.map((o) => [o.accountPk, o.source, o.observedAt])).toEqual([
      ['51', 'friend-requests', 1_234], ['52', 'friend-requests', 1_234],
    ]);
    expect(read.requests.pendingComplete).toBe(false);
  });

  test('a side list away from its declared place is not searched for', () => {
    const body = feed();
    const read = readDrawerBody({ kind: 'activity-feed', body: { ...body, pending_users: { users: [{ pk: '51' }] } } }, ctx);
    expect(read.pendingPreview).toEqual([]);
  });
});

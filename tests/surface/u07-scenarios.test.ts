/**
 * The U07 regression table (spec §10.8): each row is one small delivery change Instagram could
 * make, and what Epo must do with it. A renamed relationship key never becomes "we do not follow".
 */
import { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import { FakeClock } from '@/governors/clock';
import { AdapterBackedProfileEnricher } from '@/rim/profile-enricher';
import type { ProfileVisitor } from '@/rim/profile-visit-port';
import { RelationshipReconciler } from '@/rim/relationship-reconciler';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { RECOVERY } from '@/timing/config';
import { setLevel } from '@/utils/logger';
import { FakeSentinel, mkProfileGraphqlResp, mkResp } from '../kit/fakes';
import { openTestStore } from '../kit/store';

beforeAll(() => setLevel('error'));

const OWN = '777';
const PK = '4242';
const T0 = 1_700_000_000_000;
const SHOW_MANY = 'https://i.instagram.com/api/v1/friendships/show_many/';
const SHOW = `https://www.instagram.com/api/v1/friendships/show/${PK}/`;
const GQL = 'https://www.instagram.com/api/graphql';
const GQL_NAME = 'PolarisProfilePageContentQuery';

const showMany = (status: Record<string, unknown>) => ({ friendship_statuses: { [PK]: status }, status: 'ok' });
const profile = (friendship: Record<string, unknown>) => ({
  data: { user: { pk: PK, username: 'subject', follower_count: 10, following_count: 10, friendship_status: friendship } },
});

interface Row {
  id: string;
  url: string;
  friendlyName?: string;
  body: unknown;
}

/** U07 S1, S2, F1, P1: the relationship keys renamed (CRIT: held records became `external`). */
const RENAMED: Row[] = [
  { id: 'S1 show_many following → is_following', url: SHOW_MANY,
    body: showMany({ is_following: true, outgoing_request: false, incoming_request: false }) },
  { id: 'S2 show_many outgoing_request renamed', url: SHOW_MANY,
    body: showMany({ following: false, outgoing_request_v2: true, incoming_request: false }) },
  { id: 'F1 friendships/show following renamed', url: SHOW,
    body: { is_following: true, followed_by: false, outgoing_request: false, status: 'ok' } },
  { id: 'P1 profile friendship_status.outgoing_request renamed', url: GQL, friendlyName: GQL_NAME,
    body: profile({ following: false, followed_by: false, outgoing_request_v2: true }) },
];

/** The same bodies with every key present and false: the one shape that may drop a record. */
const CONTROL: Row[] = [
  { id: 'show_many', url: SHOW_MANY, body: showMany({ following: false, outgoing_request: false }) },
  { id: 'friendships/show', url: SHOW, body: { following: false, followed_by: false, outgoing_request: false } },
  { id: 'profile', url: GQL, friendlyName: GQL_NAME, body: profile({ following: false, outgoing_request: false }) },
];

const reader = new Reader();
let store: KnowledgeStore;
let reconciler: RelationshipReconciler;

beforeEach(() => {
  store = openTestStore(':memory:');
  store.setOwnPk(OWN);
  reconciler = new RelationshipReconciler({ store, ownPk: OWN, reader, clock: new FakeClock(T0) });
  store.upsertFollowRecord({ accountPk: PK, targetPk: null, state: 'pending_followback', retryCount: 0, followedAt: T0 });
});
afterEach(() => store.close());

const respOf = (row: Row) =>
  row.friendlyName === undefined ? mkResp(row.url, row.body) : mkProfileGraphqlResp(row.body);

describe('U07 relationship rows: an absent key is unknown, never "not following"', () => {
  test.each(RENAMED.map((r) => [r.id, r] as const))('%s: no weFollow:false fact', (_id, row) => {
    const facts = reader.relationshipFacts(row.url, row.body, T0, row.friendlyName);
    expect(facts.filter((f) => !f.weFollow)).toEqual([]);
  });

  test.each(RENAMED.map((r) => [r.id, r] as const))('%s: the held record stays held', async (_id, row) => {
    await reconciler.ingest(respOf(row));
    expect(store.getFollowRecord(PK)?.state).toBe('pending_followback');
  });

  test.each(CONTROL.map((r) => [r.id, r] as const))('control %s: both keys present and false drop it', async (_id, row) => {
    await reconciler.ingest(respOf(row));
    expect(store.getFollowRecord(PK)?.state).toBe('external');
  });
});

describe('U07 count rows: the counts are one pair, and a count-less read ends the pass', () => {
  const user = (counts: Record<string, unknown>) => ({ data: { user: { pk: PK, username: 'subject', ...counts } } });

  test('P2 a digit-string count is retyped and stored with its sibling', () => {
    const obs = reader.parseProfileInfo(user({ follower_count: '1200', following_count: 4 }), T0, 'profile-graphql');
    expect(obs?.fields).toMatchObject({ followers: 1200, following: 4 });
  });

  test('P3 a moved count stores no stat at all, so a stale sibling never looks fresh', () => {
    const obs = reader.parseProfileInfo(user({ edge_followed_by: { count: 1200 }, following_count: 4 }), T0, 'profile-graphql');
    expect(obs?.fields.followers).toBeUndefined();
    expect(obs?.fields.following).toBeUndefined();
  });

  test('P3 profile reads without counts count in the enricher streak: the pass ends early', async () => {
    const visited: string[] = [];
    const visitor: ProfileVisitor = {
      visit: async (username) => {
        visited.push(username);
        return { ok: true, obs: { accountPk: username, observedAt: T0, source: 'profile', fields: { username } },
          viewer: { following: null, requested: null, followsUs: null },
          presence: { counts: 'partial', bio: 'read', isPrivate: 'read', isVerified: 'read', relationship: 'read' } };
      },
    };
    const enricher = new AdapterBackedProfileEnricher({ visitor, store, sentinel: new FakeSentinel() as unknown as Sentinel,
      clock: new FakeClock(T0), sleep: async () => {} });
    const usernames = Array.from({ length: RECOVERY.BLOCKED_STREAK_ENTRY + 3 }, (_, i) => `u${i}`);
    expect(await enricher.enrich(usernames)).toBe(0);
    expect(visited).toHaveLength(RECOVERY.BLOCKED_STREAK_ENTRY);
  });
});

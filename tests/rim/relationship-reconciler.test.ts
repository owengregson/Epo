import {
  RelationshipReconciler,
  installRelationshipReconciler,
} from '@/rim/relationship-reconciler';
import { Reader } from '@/adapter/reader';
import { KnowledgeStore } from '@/store/knowledge-store';
import { FakeClock } from '@/governors/clock';
import { setLevel } from '@/utils/logger';
import type { FollowRecord } from '@/store/types';
import { FakeTab, mkResp } from './fakes';

import showMany from '../fixtures/adapter/show-many.json';
import profileInfo1 from '../fixtures/adapter/profile-info-1.json';

// Keep test output quiet; the store logs info on every reconciliation drop.
beforeAll(() => setLevel('error'));

// Numeric like a real ds_user_id, so friendship-show URLs carrying it still match.
const OWN = '777';
const T0 = 1_700_000_000_000;

const SHOW_MANY_URL = 'https://i.instagram.com/api/v1/friendships/show_many/';
const showUrl = (pk: string): string =>
  `https://www.instagram.com/api/v1/friendships/show/${pk}/`;
const PROFILE_URL = 'https://www.instagram.com/api/v1/users/web_profile_info/?username=x';

const rec = (over: Partial<FollowRecord> & { accountPk: string }): FollowRecord => ({
  targetPk: null,
  state: 'queued',
  retryCount: 0,
  ...over,
});

let store: KnowledgeStore;
let clock: FakeClock;
let reconciler: RelationshipReconciler;

beforeEach(() => {
  store = new KnowledgeStore(':memory:');
  store.setOwnPk(OWN);
  clock = new FakeClock(T0);
  reconciler = new RelationshipReconciler({ store, ownPk: OWN, reader: new Reader(), clock });
});
afterEach(() => store.close());

test('a show_many body flips a held record to external (external unfollowed us-side)', async () => {
  // Fixture pk 1000000002 reports following: false — an external actor reverted
  // the follow while our record still holds it.
  store.upsertFollowRecord(
    rec({ accountPk: '1000000002', state: 'pending_followback', followedAt: T0 }),
  );

  await reconciler.ingest(mkResp(SHOW_MANY_URL, showMany));

  expect(store.getFollowRecord('1000000002')!.state).toBe('external');
  expect(store.getEdge(OWN, '1000000002', 'follows')!.status).toBe('removed');
  // Facts we DO follow are recorded as active edges (fixture pk 1000000001).
  expect(store.getEdge(OWN, '1000000001', 'follows')!.status).toBe('active');
  // Reconciliation never writes a ledger row.
  expect(store.actionCountSince(0)).toBe(0);
});

test('a friendship-show following:false drops a held record', async () => {
  store.upsertFollowRecord(
    rec({ accountPk: '999', state: 'followed_back', followedBackAt: T0, holdUntil: T0 + 1 }),
  );

  const body = { following: false, followed_by: true, status: 'ok' };
  await reconciler.ingest(mkResp(showUrl('999'), body));

  expect(store.getFollowRecord('999')!.state).toBe('external');
  expect(store.getEdge(OWN, '999', 'follows')!.status).toBe('removed');
  expect(store.actionCountSince(0)).toBe(0);
});

test('a web_profile_info followed_by_viewer:true drops a queued candidate', async () => {
  // Fixture profile-info-1: pk 1000000003, followed_by_viewer: true — someone
  // (the user, another tool) already follows this queued candidate.
  store.upsertFollowRecord(rec({ accountPk: '1000000003', state: 'queued' }));

  await reconciler.ingest(mkResp(PROFILE_URL, profileInfo1));

  expect(store.getFollowRecord('1000000003')!.state).toBe('external');
  expect(store.getEdge(OWN, '1000000003', 'follows')!.status).toBe('active');
  expect(store.actionCountSince(0)).toBe(0);
});

test('facts about our OWN pk are skipped (never a self-edge)', async () => {
  const body = { following: true, followed_by: true, status: 'ok' };
  await reconciler.ingest(mkResp(showUrl(OWN), body));
  expect(store.getEdge(OWN, OWN, 'follows')).toBeNull();
});

test('a failing getBody warns and never throws', async () => {
  const resp = {
    requestId: 'r1',
    url: SHOW_MANY_URL,
    status: 200,
    mimeType: 'application/json',
    getBody: async (): Promise<string> => {
      throw new Error('resource evicted from CDP cache');
    },
  };
  await expect(reconciler.ingest(resp)).resolves.toBeUndefined();
});

test('installRelationshipReconciler ingests matching responses only, until unsubscribed', async () => {
  const tab = new FakeTab();
  const unsubscribe = installRelationshipReconciler(tab, reconciler);

  store.upsertFollowRecord(rec({ accountPk: '1000000003', state: 'queued' }));
  // Non-matching URL: never ingested (no edge, record untouched).
  tab.emit(mkResp('https://www.instagram.com/static/bundle.js', profileInfo1));
  // Matching URL: ingested asynchronously.
  tab.emit(mkResp(PROFILE_URL, profileInfo1));
  await new Promise((resolve) => setImmediate(resolve));

  expect(store.getFollowRecord('1000000003')!.state).toBe('external');

  // After unsubscribe, further responses are ignored.
  store.upsertFollowRecord(rec({ accountPk: '1000000003', state: 'queued' }));
  unsubscribe();
  tab.emit(mkResp(PROFILE_URL, profileInfo1));
  await new Promise((resolve) => setImmediate(resolve));
  expect(store.getFollowRecord('1000000003')!.state).toBe('queued');
});

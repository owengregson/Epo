import { type CandidateQualityConfig, evaluateQuality, scoreQueue, validQuality } from '@/engine/candidate-quality';
import { type CandidateProfile, SCORER_DEFAULTS, type ScorerConfig } from '@/engine/scorer';
import { SourceFrontier } from '@/engine/source-frontier';
import { FakeClock } from '@/governors/clock';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { FollowRecord } from '@/store/types';
import { openTestStore } from '../kit/store';

const STRONG: CandidateProfile = { followers: 1000, following: 1100, mutuals: 20 };
const ORDINARY: CandidateProfile = { followers: 1000, following: 1100, mutuals: 0 };
const WEAK: CandidateProfile = { followers: 1000, following: 700, mutuals: 0 };
let store: KnowledgeStore;
let clock: FakeClock;
let frontier: SourceFrontier;
let scorer: ScorerConfig;
let readyCount: number;
let capacity: number;
let quality: CandidateQualityConfig;

beforeEach(() => {
  clock = new FakeClock(1_000_000);
  store = openTestStore(':memory:', { now: () => clock.now() });
  store.setOwnPk('self');
  scorer = { ...SCORER_DEFAULTS };
  readyCount = 5;
  capacity = 10;
  quality = { scorer: () => scorer, readyCount: () => readyCount, capacity: () => capacity };
  frontier = new SourceFrontier({ store, clock, quality });
});
afterEach(() => store.close());

function source(pk: string): void {
  store.observe({ accountPk: pk, observedAt: clock.now(), source: 'profile', fields: { username: pk } });
  store.addTarget({ accountPk: pk, source: 'seed', status: 'active', chainIndex: 0 });
  frontier.offer(pk, 'seed');
}

function candidate(pk: string, targetPk: string, profile: CandidateProfile = STRONG): FollowRecord {
  store.observe({ accountPk: pk, observedAt: clock.now(), source: 'profile', fields: { username: pk, ...profile } });
  const record: FollowRecord = { accountPk: pk, targetPk, state: 'queued', retryCount: 0, score: 999 };
  store.upsertFollowRecord(record);
  return record;
}

function batch(pk: string, count: number, profile: CandidateProfile = STRONG): FollowRecord[] {
  source(pk);
  return Array.from({ length: count }, (_, i) => candidate(`${pk}-${i}`, pk, profile));
}

const queued = (): FollowRecord[] => store.followRecordsByState('queued');
const pick = (): FollowRecord | null => frontier.pickQueued(queued());
const consume = (r: FollowRecord): void => store.upsertFollowRecord({ ...r, state: 'pending_followback', followedAt: clock.now() });

test('a weak low-use source cannot replace a strong incumbent on the exploration opportunity', () => {
  batch('incumbent', 5); batch('weak', 10, ORDINARY);
  for (let i = 0; i < 4; i++) frontier.noteFollow('incumbent');
  frontier.refreshQuality();
  expect(frontier.qualityView().floor).toBe(2.5);
  expect(frontier.qualityView().qualifiedSources).toEqual(['incumbent']);
  expect(pick()?.targetPk).toBe('incumbent');
});

test('a handoff requires exactly K matching candidates and explicit preparation of the fifth', () => {
  batch('incumbent', 5); batch('challenger', 4);
  frontier.refreshQuality();
  expect(frontier.goodQueuedCount('challenger')).toBe(4);
  expect(frontier.qualityView().qualifiedSources).toEqual(['incumbent']);
  candidate('challenger-fifth', 'challenger');
  expect(frontier.qualityView().qualifiedSources).toEqual(['incumbent']);
  expect(pick()?.targetPk).toBe('incumbent');
  frontier.refreshQuality();
  expect(frontier.qualityView().qualifiedSources).toEqual(['challenger', 'incumbent']);
  expect(pick()?.targetPk).toBe('challenger');
});

test('the cohort latch survives drain and restart, and depletion never lowers the floor', () => {
  const strong = batch('incumbent', 5); batch('weak', 10, ORDINARY);
  frontier.refreshQuality();
  const anchors = frontier.snapshot().quality?.anchors;
  for (let i = 0; i < strong.length; i++) {
    expect(pick()?.targetPk).toBe('incumbent');
    consume(strong[i]);
    frontier.refreshQuality();
    frontier = new SourceFrontier({ store, clock, quality });
    expect(frontier.qualityView().floor).toBe(2.5);
    expect(frontier.qualityView().qualifiedSources).toEqual(['incumbent']);
    expect(frontier.snapshot().quality?.anchors).toEqual(anchors);
  }
  expect(pick()).toBeNull();
  expect(store.followRecordsByState('pending_followback')).toHaveLength(5);
  expect(queued()).toHaveLength(10);
});

test('an isolated outlier cannot prove readiness or raise a complete ordinary cohort to its score', () => {
  batch('outlier', 1);
  for (let i = 0; i < 10; i++) candidate(`tail-${i}`, 'outlier', WEAK);
  frontier.refreshQuality();
  expect(frontier.snapshot().quality ?? null).toBeNull();
  expect(pick()).toBeNull();
  batch('ordinary', 5, ORDINARY);
  frontier.refreshQuality();
  expect(frontier.qualityView().floor).toBe(1);
  expect(frontier.qualityView().qualifiedSources).toEqual(['ordinary']);
  expect(pick()?.targetPk).toBe('ordinary');
});

test('cohort quality comes from its Kth candidate, not one unusually strong member or the average', () => {
  batch('outlier', 4); candidate('weakest', 'outlier', ORDINARY);
  batch('consistent', 5, { ...ORDINARY, mutuals: 5 });
  frontier.refreshQuality();
  expect(frontier.qualityView().floor).toBe(1.75);
  expect(frontier.qualityView().qualifiedSources).toEqual(['consistent']);
  expect(frontier.goodQueuedCount('outlier')).toBe(4);
  expect(pick()?.targetPk).toBe('consistent');
});

test('the strongest complete cohort sets the benchmark independently of weak tails', () => {
  batch('strong', 5); batch('ordinary', 10, ORDINARY);
  for (let i = 0; i < 30; i++) candidate(`tail-${i}`, 'strong', WEAK);
  frontier.refreshQuality();
  expect(frontier.qualityView().floor).toBe(2.5);
  expect(frontier.snapshot().quality?.anchors).toHaveLength(5);
  expect(frontier.goodQueuedCount('strong')).toBe(5);
});

test('current profiles replace stale queue scores when counting and selecting candidates', () => {
  const strong = batch('strong', 5); const weak = batch('weak', 5, WEAK);
  for (const r of strong) store.upsertFollowRecord({ ...r, score: 0 });
  for (const r of weak) store.upsertFollowRecord({ ...r, score: 1000 });
  frontier.refreshQuality();
  expect(frontier.qualityView().qualifiedSources).toEqual(['strong']);
  expect(pick()).toMatchObject({ targetPk: 'strong', score: 2.5 });
  expect(store.getFollowRecord(strong[0].accountPk)?.score).toBe(0);
});

test.each([
  ['missing counts', {}],
  ['missing following', { followers: 1000 }],
  ['verified', { ...STRONG, isVerified: true }],
  ['zero followers', { followers: 0, following: 1100 }],
  ['negative followers', { followers: -1000, following: 1100 }],
  ['fractional following', { ...STRONG, following: 1100.5 }],
  ['fractional followers', { ...STRONG, followers: 1000.5 }],
  ['fractional mutuals', { ...STRONG, mutuals: 19.5 }],
] satisfies Array<[string, CandidateProfile]>)('a current %s profile cannot complete a cohort', (_name, profile) => {
  batch('source', 4);
  const invalid = candidate('invalid', 'source', profile);
  expect(scoreQueue(store, [invalid], scorer, clock.now())).toEqual([]);
  frontier.refreshQuality();
  expect(frontier.snapshot().quality ?? null).toBeNull();
  expect(pick()).toBeNull();
});

test('a missing projected account cannot qualify based on its stored score', () => {
  batch('source', 4);
  store.upsertFollowRecord({ accountPk: 'absent', targetPk: 'source', state: 'queued', retryCount: 0, score: 999 });
  frontier.refreshQuality();
  expect(frontier.qualityView().qualifiedSources).toEqual([]);
  expect(pick()).toBeNull();
});

test.each([Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_SAFE_INTEGER + 1])(
  'an invalid current count (%s) cannot hide behind an old valid ratio and score', (following) => {
    batch('source', 4);
    const invalid = candidate('invalid', 'source');
    const realGet = store.getAccount.bind(store);
    jest.spyOn(store, 'getAccount').mockImplementation((pk) => {
      const account = realGet(pk);
      return pk === invalid.accountPk && account !== null ? { ...account, following, ratio: 1.1 } : account;
    });
    expect(scoreQueue(store, [invalid], scorer, clock.now())).toEqual([]);
    frontier.refreshQuality();
    expect(frontier.snapshot().quality ?? null).toBeNull();
    expect(pick()).toBeNull();
  });

test('a candidate that becomes verified after preparation cannot pass selection or at-act admission', () => {
  const records = batch('source', 5);
  frontier.refreshQuality();
  clock.advance(1);
  for (const r of records) store.observe({ accountPk: r.accountPk, observedAt: clock.now(), source: 'profile',
    fields: { isVerified: true } });
  expect(frontier.allowsFollow(records[0])).toBe(false);
  expect(pick()).toBeNull();
  expect(frontier.qualityView().floor).toBe(2.5);
});

test.each(['parked', 'journal', 'requester'] as const)('%s candidates cannot complete readiness', (block) => {
  const records = batch('source', 5);
  const last = records[4];
  if (block === 'parked') store.upsertFollowRecord({ ...last, recheckAt: clock.now() + 1 });
  if (block === 'journal') {
    const intent = store.beginEffectIntent({ accountPk: last.accountPk, username: last.accountPk,
      action: 'follow', channel: 'growth', at: clock.now() });
    store.markEffectDispatched(intent.id, clock.now());
  }
  if (block === 'requester') store.observeEdge(last.accountPk, 'self', 'requests', true, clock.now());
  frontier.refreshQuality();
  expect(frontier.snapshot().quality ?? null).toBeNull();
  expect(pick()).toBeNull();
});

test('frozen anchor features rescale with settings; live anchor deterioration cannot lower the benchmark', () => {
  const records = batch('strong', 5); batch('ordinary', 5, ORDINARY);
  frontier.refreshQuality();
  clock.advance(1);
  for (const r of records) store.observe({ accountPk: r.accountPk, observedAt: clock.now(), source: 'profile', fields: WEAK });
  expect(frontier.qualityView().floor).toBe(2.5);
  expect(pick()).toBeNull();
  scorer = { ...scorer, mutualWeight: 0 };
  frontier.refreshQuality();
  expect(frontier.qualityView().floor).toBe(1);
  expect(pick()?.targetPk).toBe('ordinary');
  expect(frontier.snapshot().quality?.anchors).toEqual(Array.from({ length: 5 }, () => ({ ...STRONG, ratio: 1.1 })));
});

test('settings that invalidate anchors require an explicit reset instead of silently preparing a weaker cohort', () => {
  batch('original', 5);
  frontier.refreshQuality();
  const anchors = frontier.snapshot().quality?.anchors;
  scorer = { ...scorer, minFollowers: 2000 };
  batch('replacement', 5, { followers: 3000, following: 3300, mutuals: 0 });
  frontier.refreshQuality();
  expect(frontier.qualityView()).toMatchObject({ needsReset: true, floor: null });
  expect(frontier.snapshot().quality?.anchors).toEqual(anchors);
  expect(pick()).toBeNull();
});

test('quality evaluation, status and picking are pure until explicit preparation persists admission', () => {
  batch('source', 5);
  const before = store.getSourceFrontierState();
  const recordsBefore = queued();
  const projected = evaluateQuality(store, null, quality, clock.now());
  expect(projected.view.floor).toBe(2.5);
  expect(validQuality(projected.next)).toBe(true);
  frontier.qualityView(); frontier.goodQueuedCount('source');
  expect(pick()).toBeNull();
  expect(store.getSourceFrontierState()).toBe(before);
  expect(queued()).toEqual(recordsBefore);
  frontier.refreshQuality();
  const prepared = store.getSourceFrontierState();
  expect(pick()?.targetPk).toBe('source');
  frontier.qualityView();
  expect(store.getSourceFrontierState()).toBe(prepared);
});

test('a zero configured plan admits nothing even with a retained qualified cohort', () => {
  batch('source', 5); frontier.refreshQuality();
  readyCount = 0; capacity = 0;
  frontier.refreshQuality();
  expect(frontier.qualityView().readyCount).toBe(0);
  expect(frontier.allowsFollow(queued()[0])).toBe(false);
  expect(pick()).toBeNull();
  expect(queued()).toHaveLength(5);
});

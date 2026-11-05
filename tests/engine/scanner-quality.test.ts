import { Scanner } from '@/engine/scanner';
import { SCORER_DEFAULTS } from '@/engine/scorer';
import { SourceFrontier } from '@/engine/source-frontier';
import { FakeClock } from '@/governors/clock';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { openTestStore } from '../kit/store';

let store: KnowledgeStore;
const clock = new FakeClock(1_000_000);
let frontier: SourceFrontier;
let scanner: Scanner;
beforeEach(() => {
  store = openTestStore(':memory:');
  frontier = new SourceFrontier({ store, clock, quality: {
    scorer: () => SCORER_DEFAULTS, readyCount: () => 5, capacity: () => 10,
  } });
  scanner = new Scanner({ store, quality: {
    prepare: () => frontier.refreshQuality(), floor: () => frontier.qualityView().floor ?? SCORER_DEFAULTS.bandEdgeScore,
    usableCount: (pk) => frontier.goodQueuedCount(pk),
  } });
  store.addTarget({ accountPk: 'source', source: 'seed', status: 'active', chainIndex: 0 });
});
afterEach(() => store.close());

function person(pk: string, following: number, queued = false): void {
  store.observe({ accountPk: pk, observedAt: clock.now(), source: 'profile',
    fields: { username: pk, followers: 1000, following } });
  store.observeEdge(pk, 'source', 'follows', true, clock.now());
  if (queued) store.upsertFollowRecord({ accountPk: pk, targetPk: 'source', state: 'queued', retryCount: 0, score: 0.3 });
}

test('weak durable leftovers cannot fill the slots needed to prepare a good batch', () => {
  for (let i = 0; i < 10; i++) person(`weak-${i}`, 700, true);
  for (let i = 0; i < 5; i++) person(`good-${i}`, 1100);
  expect(scanner.planTarget('source').queued).toHaveLength(5);
  expect(frontier.qualityView()).toMatchObject({ floor: 1, qualifiedSources: ['source'] });
  for (let i = 0; i < 10; i++) expect(store.getFollowRecord(`weak-${i}`)?.state).toBe('queued');
  expect(frontier.pickQueued(store.followRecordsByState('queued'))?.accountPk).toMatch(/^good-/);
});

test('partial preparation remains visible, cannot act, and admits after enough profiles qualify', () => {
  for (let i = 0; i < 4; i++) person(`good-${i}`, 1100);
  scanner.planTarget('source');
  expect(frontier.goodQueuedCount('source')).toBe(4);
  expect(frontier.pickQueued(store.followRecordsByState('queued'))).toBeNull();
  person('fifth', 1100);
  scanner.planTarget('source');
  expect(frontier.pickQueued(store.followRecordsByState('queued'))).not.toBeNull();
});

test('below-floor newly observed profiles remain reconsiderable and never become fake exhaustion evidence', () => {
  for (let i = 0; i < 5; i++) person(`good-${i}`, 1100);
  scanner.planTarget('source');
  person('soft', 950);
  expect(scanner.planTarget('source').queued).toEqual([]);
  expect(store.getAccount('soft')?.role).not.toBe('skipped');
  expect(store.getTarget('source')?.status).toBe('active');
  clock.advance(1);
  person('soft', 1100);
  expect(scanner.planTarget('source').queued).toEqual(['soft']);
});

test('temporarily parked records cannot consume all usable capacity', () => {
  for (let i = 0; i < 10; i++) {
    person(`parked-${i}`, 1100, true);
    store.upsertFollowRecord({ ...store.getFollowRecord(`parked-${i}`)!, recheckAt: clock.now() + 1000 });
  }
  for (let i = 0; i < 5; i++) person(`available-${i}`, 1100);
  expect(scanner.planTarget('source').queued).toHaveLength(5);
  expect(frontier.goodQueuedCount('source')).toBe(5);
});

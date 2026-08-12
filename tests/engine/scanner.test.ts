import { Scanner, SCANNER_DEFAULTS } from '@/engine/scanner';
import { KnowledgeStore } from '@/store/knowledge-store';
import type { AccountFields } from '@/store/types';

const TARGET = 'target';
const NOW = 1_000_000;

let store: KnowledgeStore;
beforeEach(() => {
  store = new KnowledgeStore(':memory:');
});
afterEach(() => store.close());

/** Seed an account via a profile-source observation, then wire it as a follower of TARGET. */
const seedFollower = (pk: string, fields: AccountFields): void => {
  store.observe({ accountPk: pk, observedAt: NOW, source: 'profile', fields });
  store.observeEdge(pk, TARGET, 'follows', true, NOW);
};

const scanner = (over?: { cfg?: { dailyPlanSize: number } }): Scanner =>
  new Scanner({ store, ...over });

// Scorer defaults: peak plateau r∈[1.0,1.2] → 1.0; in-band edge lower; soft edge < 0.6;
// privateBoost +0.15; verified/too-small/too-large/ratio-excluded → ineligible.

test('ranks eligible followers by descending score and enqueues queued records', () => {
  // peak private → score clamps to 1.0 (highest)
  seedFollower('peakPriv', { followers: 1000, following: 1100, isPrivate: true });
  // in-band public (r=1.4) → ~0.73 (middle)
  seedFollower('inband', { followers: 1000, following: 1400 });
  // soft-edge public (r=2.0) → 0.4 (lowest eligible)
  seedFollower('softPub', { followers: 1000, following: 2000 });

  // Ineligible: must never be queued.
  seedFollower('verified', { followers: 1000, following: 1100, isVerified: true });
  seedFollower('tooSmall', { followers: 40, following: 44 });
  seedFollower('ratioOut', { followers: 1000, following: 5000 }); // r=5.0 hard-excluded

  const plan = scanner().planTarget(TARGET);

  expect(plan.targetPk).toBe(TARGET);
  expect(plan.considered).toBe(6);
  expect(plan.eligible).toBe(3);
  // Descending score order: peak-private > in-band > soft-edge.
  expect(plan.queued).toEqual(['peakPriv', 'inband', 'softPub']);

  // Each queued pk has a `queued` follow_record with the target set and role 'candidate'.
  for (const pk of plan.queued) {
    const fr = store.getFollowRecord(pk)!;
    expect(fr.state).toBe('queued');
    expect(fr.targetPk).toBe(TARGET);
    expect(fr.retryCount).toBe(0);
    expect(store.getAccount(pk)!.role).toBe('candidate');
  }

  // Ineligible followers were never enqueued.
  for (const pk of ['verified', 'tooSmall', 'ratioOut']) {
    expect(store.getFollowRecord(pk)).toBeNull();
    expect(store.getAccount(pk)!.role).toBeUndefined();
  }
});

test('a peak-ratio private account outranks a soft-edge public one', () => {
  seedFollower('softPub', { followers: 1000, following: 2000 }); // r=2.0 → 0.4
  seedFollower('peakPriv', { followers: 1000, following: 1100, isPrivate: true }); // → 1.0

  const plan = scanner().planTarget(TARGET);
  expect(plan.queued).toEqual(['peakPriv', 'softPub']);
});

test('dailyPlanSize caps the number of enqueued candidates', () => {
  seedFollower('peakPriv', { followers: 1000, following: 1100, isPrivate: true }); // 1.0
  seedFollower('inband', { followers: 1000, following: 1400 }); // ~0.73
  seedFollower('softPub', { followers: 1000, following: 2000 }); // 0.4

  const plan = scanner({ cfg: { dailyPlanSize: 2 } }).planTarget(TARGET);

  expect(plan.eligible).toBe(3); // all three were eligible…
  expect(plan.queued).toEqual(['peakPriv', 'inband']); // …but only the top 2 enqueued.
  expect(store.getFollowRecord('softPub')).toBeNull();
});

test('an account already having a follow_record is not re-queued', () => {
  seedFollower('peakPriv', { followers: 1000, following: 1100, isPrivate: true });
  seedFollower('already', { followers: 1000, following: 1100 }); // eligible, but pre-acted-on

  // Pre-existing follow_record excludes it from the candidate pool.
  store.upsertFollowRecord({
    accountPk: 'already',
    targetPk: TARGET,
    state: 'pending_followback',
    retryCount: 0,
  });

  expect(store.candidatePksForTarget(TARGET)).not.toContain('already');

  const plan = scanner().planTarget(TARGET);
  expect(plan.considered).toBe(1); // 'already' excluded before scoring
  expect(plan.queued).toEqual(['peakPriv']);

  // Its record was left untouched (not overwritten to 'queued').
  expect(store.getFollowRecord('already')!.state).toBe('pending_followback');
});

test('default plan size is 25', () => {
  expect(SCANNER_DEFAULTS.dailyPlanSize).toBe(25);
});

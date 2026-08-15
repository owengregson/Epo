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

  // Ineligible followers were never enqueued — and, their counts being KNOWN,
  // they were marked 'skipped' (R1.3) so they drop out of the candidate pool.
  for (const pk of ['verified', 'tooSmall', 'ratioOut']) {
    expect(store.getFollowRecord(pk)).toBeNull();
    expect(store.getAccount(pk)!.role).toBe('skipped');
    expect(store.candidatePksForTarget(TARGET)).not.toContain(pk);
  }
});

test('ineligible-with-counts candidates are skipped; no-counts ones await enrichment', () => {
  seedFollower('eligible', { followers: 1000, following: 1100 });
  seedFollower('ratioOut', { followers: 1000, following: 5000 }); // counts known, ineligible
  // Counts unknown: seen on a followers list only — must NOT be skipped.
  seedFollower('countless', { username: 'countless_user' });

  const plan = scanner().planTarget(TARGET);

  expect(plan.queued).toEqual(['eligible']);
  expect(plan.considered).toBe(3);
  expect(plan.eligible).toBe(1);

  // The rejected-with-counts candidate leaves the pool for good…
  expect(store.getAccount('ratioOut')!.role).toBe('skipped');
  // …while the count-less one stays a candidate, awaiting an enrichment pass.
  expect(store.getAccount('countless')!.role).toBeUndefined();
  expect(store.candidatePksForTarget(TARGET)).toEqual(['countless']);

  // A later pass (still no counts) keeps it un-skipped: only enrichment decides it.
  const replan = scanner().planTarget(TARGET);
  expect(replan.considered).toBe(1);
  expect(replan.queued).toEqual([]);
  expect(store.getAccount('countless')!.role).toBeUndefined();
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

// --- rescoreQueued: backfill for records queued before score persistence ------------

test('rescoreQueued scores legacy null-score queued records so order means something', () => {
  seedFollower('peakPriv', { followers: 1000, following: 1100, isPrivate: true });
  seedFollower('softPub', { followers: 1000, following: 2000 });
  // Legacy records (pre-migration-7): queued directly, score absent.
  store.upsertFollowRecord({ accountPk: 'peakPriv', targetPk: TARGET, state: 'queued', retryCount: 0 });
  store.upsertFollowRecord({ accountPk: 'softPub', targetPk: TARGET, state: 'queued', retryCount: 0 });
  // A record whose account has no counts must stay unscored (sorts last).
  store.observe({ accountPk: 'unknown', observedAt: NOW, source: 'followers-list', fields: {} });
  store.upsertFollowRecord({ accountPk: 'unknown', targetPk: TARGET, state: 'queued', retryCount: 0 });

  const scored = scanner().rescoreQueued();

  expect(scored).toBe(2);
  const peak = store.getFollowRecord('peakPriv')!.score!;
  const soft = store.getFollowRecord('softPub')!.score!;
  expect(peak).toBeGreaterThan(soft);
  expect(store.getFollowRecord('unknown')!.score).toBeUndefined();
  // Idempotent: a second pass rescores nothing.
  expect(scanner().rescoreQueued()).toBe(0);
});

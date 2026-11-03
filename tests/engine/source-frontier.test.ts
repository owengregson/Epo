import fc from 'fast-check';
import { ChainController } from '@/engine/chain-controller';
import { EXPLORATION_POLICY as POLICY } from '@/engine/exploration-policy';
import { SourceFrontier } from '@/engine/source-frontier';
import { matureYield } from '@/engine/source-quality';
import { FakeClock } from '@/governors/clock';
import { AdapterBackedOwnFollowersTargetSource } from '@/rim/own-followers-target-source';
import { StoreBackedTargetDiscovery } from '@/rim/target-discovery';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { FollowRecord } from '@/store/types';
import { makeEngineHarness } from '../kit/engine-harness';
import { openTestStore } from '../kit/store';

let store: KnowledgeStore;
const now = 20 * POLICY.endedRevisitMs;
let clock: FakeClock;
let frontier: SourceFrontier;
beforeEach(() => {
  store = openTestStore(':memory:');
  clock = new FakeClock(now);
  frontier = new SourceFrontier({ store, clock });
});
afterEach(() => store.close());

function account(pk: string, followers = 500, isPrivate = false): void {
  store.observe({ accountPk: pk, observedAt: clock.now(), source: 'profile',
    fields: { username: pk, followers, following: followers, isPrivate } });
}
function queue(pk: string, source: string, score = 1): FollowRecord {
  return { accountPk: pk, targetPk: source, state: 'queued', retryCount: 0, score };
}

test('source visit and fairness allowance survive restart without resetting', () => {
  account('a');
  frontier.offer('a', 'seed');
  frontier.beginVisit('a', 'seed');
  for (let i = 0; i < POLICY.followsPerVisit - 1; i++) frontier.noteFollow('a');
  frontier = new SourceFrontier({ store, clock });
  frontier.beginVisit('a', 'seed');
  expect(frontier.rotationReason('a')).toBeNull();
  frontier.noteFollow('a');
  expect(frontier.rotationReason('a')).toBe('visit-budget');
  expect(frontier.snapshot().totalFollows).toBe(20);
});

test('rotation keeps queue and cursor; empty samples defer without claiming exhaustion', () => {
  account('a'); account('b');
  store.addTarget({ accountPk: 'a', source: 'seed', status: 'active', chainIndex: 0 });
  store.upsertFollowRecord(queue('prospect', 'a'));
  store.setScrapeCursor('a', 'cursor-2', clock.now());
  frontier.beginVisit('a', 'seed'); frontier.offer('b', 'discovered');
  frontier.notePlan('a', 0); frontier.notePlan('a', 0);
  expect(frontier.rotationReason('a')).toBe('low-yield');
  frontier.endVisit('a', 'low-yield');
  expect(frontier.next('a')?.pk).toBe('b');
  expect(store.getTarget('a')?.status).toBe('active');
  expect(store.getFollowRecord('prospect')?.state).toBe('queued');
  expect(store.getScrapeCursor('a')).toBe('cursor-2');
  expect(frontier.snapshot().sources.find((s) => s.pk === 'a')?.status).toBe('deferred');
});

test('rechecking a deferred source does not restart its deadline; ended sources become eligible after a week', () => {
  account('a'); frontier.beginVisit('a', 'seed');
  frontier.endVisit('a', 'verified-ended');
  const deadline = frontier.nextResumeAt();
  clock.advance(POLICY.lowYieldRevisitMs);
  frontier.endVisit('a', 'verified-ended');
  expect(frontier.nextResumeAt()).toBe(deadline);
  expect(frontier.next()).toBeNull();
  clock.advance(POLICY.endedRevisitMs);
  expect(frontier.next()?.pk).toBe('a');
});

test('live alternatives are bounded while historical obligations remain durable', () => {
  for (let i = 0; i < 30; i++) { account(`s${i}`); frontier.offer(`s${i}`, 'discovered'); }
  expect(frontier.snapshot().sources).toHaveLength(POLICY.maxSources);
});

test('same action budget spreads discovery instead of greedily exhausting one hub', () => {
  for (const pk of ['a', 'b', 'c']) { account(pk); frontier.offer(pk, 'discovered'); }
  const candidates = [queue('best', 'a', 2.5), queue('good', 'b', 1.9), queue('new', 'c', 1.8)];
  const selected: string[] = [];
  // The exact same 100 opportunities: no extra requests or follow allowance.
  for (let i = 0; i < 100; i++) {
    const picked = frontier.pickQueued(candidates)!;
    selected.push(picked.targetPk!);
    frontier.noteFollow(picked.targetPk);
    if (i === 45) frontier = new SourceFrontier({ store, clock });
  }
  expect(new Set(selected).size).toBe(3);
  for (const pk of ['a', 'b', 'c']) expect(selected.filter((s) => s === pk).length).toBeLessThanOrEqual(40);
  expect(frontier.snapshot().totalFollows).toBe(100);
});

test('source fairness never locks when only one queue is available', () => {
  account('a'); frontier.offer('a', 'seed');
  for (let i = 0; i < 100; i++) frontier.noteFollow('a');
  expect(frontier.pickQueued([queue('a1', 'a')])?.accountPk).toBe('a1');
});

test('frontier selection preserves candidate identity and count across generated overlapping queues', () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 1, maxLength: 40 }), (ids) => {
    const records = ids.map((id, index) => queue(`person-${index}`, `source-${id}`, index / 40));
    const copy = JSON.stringify(records);
    const picked = frontier.pickQueued(records);
    expect(records).toContain(picked);
    expect(JSON.stringify(records)).toBe(copy);
  }));
});

test('new pending followbacks do not dilute mature quality; outcomes mature at a fixed horizon', () => {
  const old = clock.now() - POLICY.outcomeWindowMs - 1;
  store.upsertFollowRecord({ ...queue('old', 'a'), state: 'followed_back', followedAt: old, followedBackAt: old + 100 });
  const before = matureYield(store, 'a', clock.now());
  for (let i = 0; i < 50; i++) store.upsertFollowRecord({ ...queue(`pending-${i}`, 'a'), state: 'pending_followback', followedAt: clock.now() });
  const after = matureYield(store, 'a', clock.now());
  expect(after.rate).toBe(before.rate);
  expect(after.pending).toBe(50);
  clock.advance(POLICY.outcomeWindowMs);
  expect(matureYield(store, 'a', clock.now()).mature).toBe(1);
  expect(matureYield(store, 'a', clock.now()).censored).toBe(50);
  for (const rec of store.followRecordsByState('pending_followback')) {
    store.upsertFollowRecord({ ...rec, reconciledAt: clock.now() });
  }
  expect(matureYield(store, 'a', clock.now()).mature).toBe(51);
});

test('discovery does not copy a fresh zero-yield parent into all child predictions', async () => {
  account('parent'); account('large', 20000); account('small', 500);
  store.addTarget({ accountPk: 'parent', source: 'seed', status: 'active', chainIndex: 0 });
  for (const pk of ['large', 'small']) store.observeEdge(pk, 'parent', 'follows', true, clock.now());
  store.upsertFollowRecord({ ...queue('pending', 'parent'), state: 'pending_followback', followedAt: clock.now() });
  const choices = await new StoreBackedTargetDiscovery({ store, ownPk: 'me', clock }).discover('parent');
  expect(choices).toHaveLength(2);
  expect(choices.every((c) => c.matureSamples === 0 && c.projectedFollowBackRate > 0)).toBe(true);
});

test('unknown-time reciprocal and pre-existing follower outcomes stay censored', () => {
  const old = clock.now() - POLICY.outcomeWindowMs - 1;
  store.upsertFollowRecord({ ...queue('unknown-time', 'a'), state: 'followed_back', followedAt: old,
    followbackObservedAt: clock.now(), reconciledAt: clock.now() });
  store.upsertFollowRecord({ ...queue('pre-existing', 'a'), state: 'followed_back', followedAt: old,
    followedBackAt: old - 100, reconciledAt: clock.now() });
  expect(matureYield(store, 'a', clock.now())).toMatchObject({ mature: 0, successes: 0, censored: 2 });
});

test('nonviable hubs cannot occupy the five discovery slots ahead of viable sources', async () => {
  account('parent'); account('z-viable', 1500);
  store.addTarget({ accountPk: 'parent', source: 'seed', status: 'active', chainIndex: 0 });
  for (const pk of ['a', 'b', 'c', 'd', 'e']) {
    account(pk, 500);
    store.observeEdge(pk, 'parent', 'follows', true, clock.now());
  }
  store.observeEdge('z-viable', 'parent', 'follows', true, clock.now());
  const choices = await new StoreBackedTargetDiscovery({ store, ownPk: 'me', clock })
    .discover('parent', { minPoolSize: 1000, minFollowBackRate: 0.15 });
  expect(choices.map((c) => c.pk)).toEqual(['z-viable']);
});

test('a known tiny fallback does not prevent bounded enrichment of an unknown viable source', async () => {
  account('tiny', 20);
  store.observe({ accountPk: 'unknown', observedAt: clock.now(), source: 'followers-list', fields: { username: 'unknown' } });
  for (const pk of ['tiny', 'unknown']) store.observeEdge(pk, 'me', 'follows', true, clock.now());
  const enrich = jest.fn(async (usernames: string[]) => {
    for (const username of usernames) account(username, 1200);
    return usernames.length;
  });
  const source = new AdapterBackedOwnFollowersTargetSource({ store, ownPk: 'me', clock, enricher: { enrich } });
  expect(await source.pick(1000)).toBe('unknown');
  expect(enrich).toHaveBeenCalledWith(['unknown']);
});

test('inaccessible private and too-small fallback sources are excluded', async () => {
  account('private', 10000, true); account('public', 1000); account('tiny', 50);
  for (const pk of ['private', 'public', 'tiny']) store.observeEdge(pk, 'me', 'follows', true, clock.now());
  const source = new AdapterBackedOwnFollowersTargetSource({ store, ownPk: 'me', clock });
  expect(await source.candidates()).toEqual(['public']);
  store.observeEdge('me', 'private', 'follows', true, clock.now());
  expect(await source.pick()).toBe('private');
});

test('spending a visit selects an alternative without exhausting or deleting the old source', async () => {
  account('a'); account('b');
  store.addTarget({ accountPk: 'a', source: 'seed', status: 'active', chainIndex: 0 });
  frontier.beginVisit('a', 'seed');
  store.upsertFollowRecord(queue('queued', 'a'));
  const chain = new ChainController({ store, ownPk: 'me', clock, frontier,
    discovery: { discover: async () => [{ pk: 'b', poolSize: 500, projectedFollowBackRate: 0.15, matureSamples: 0 }] },
    ownFollowers: { pick: async () => null },
  });
  expect((await chain.advance('a', 'visit-budget')).nextTargetPk).toBe('b');
  expect(store.getTarget('a')?.status).toBe('active');
  expect(store.getFollowRecord('queued')?.targetPk).toBe('a');
});

test('rejecting a sufficient local pool cannot fabricate audience exhaustion', async () => {
  const h = makeEngineHarness({ useRealScanner: true, settings: { lowWaterCandidates: 5 } });
  h.store.observe({ accountPk: 't1', observedAt: h.clock.now(), source: 'profile', fields: { username: 'targetone', followers: 10000, following: 500 } });
  for (let i = 0; i < 240; i++) {
    const pk = `bad-${i}`;
    h.store.observe({ accountPk: pk, observedAt: h.clock.now(), source: 'profile', fields: { username: pk, followers: 1000, following: 1 } });
    h.store.observeEdge(pk, 't1', 'follows', true, h.clock.now());
  }
  await h.engine.stepOnce();
  expect(h.acquisition.calls).toEqual([]);
  expect(h.chain.advanceCalls).toEqual([]);
  await h.engine.stepOnce();
  expect(h.acquisition.calls).toEqual(['targetone']);
  expect(h.chain.advanceCalls).toEqual([]);
});

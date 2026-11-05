import { ChainController } from '@/engine/chain-controller';
import { Engine } from '@/engine/engine';
import { Scanner } from '@/engine/scanner';
import { SCORER_DEFAULTS } from '@/engine/scorer';
import { SourceFrontier } from '@/engine/source-frontier';
import { FakeClock } from '@/governors/clock';
import { AdapterBackedOwnFollowersTargetSource } from '@/rim/own-followers-target-source';
import { DEFAULT_SETTINGS } from '@/settings/settings';
import type { AccountFields } from '@/store/types';
import { DelayManager } from '@/timing/delay-manager';
import { FakeAcquisition, FakeChurn, FakeEnricher, FakeSleep, HOUR, kitStore, rec, T0, testDeps } from '../kit/engine-harness';
import { FakePlan } from '../kit/harness-plan';

function rig(options: { alternative?: boolean; follows?: number } = {}) {
  const store = kitStore();
  const clock = new FakeClock(T0);
  const observe = (pk: string, fields: AccountFields = {}) => store.observe({ accountPk: pk,
    observedAt: clock.now(), source: 'profile', fields: { username: pk, ...fields } });
  const target = (pk: string, index: number) => {
    observe(pk);
    store.addTarget({ accountPk: pk, source: 'seed', status: 'active', chainIndex: index });
  };
  target('a', 0);
  if (options.alternative) target('b', 1);
  const queue = (pk: string, source: string, following = 1100) => {
    observe(pk, { followers: 1000, following });
    store.upsertFollowRecord(rec({ accountPk: pk, targetPk: source, score: 1 }));
  };
  for (let i = 0; i < (options.follows ?? 4); i++) queue(`a${i}`, 'a');
  const frontier = new SourceFrontier({ store, clock, quality: { scorer: () => SCORER_DEFAULTS,
    readyCount: () => 2, capacity: () => 10 } });
  frontier.beginVisit('a', 'seed');
  const events: string[] = [];
  const churn = new FakeChurn(events);
  churn.nextDue = () => frontier.pickQueued(store.followRecordsByState('queued'));
  churn.execute = async (r) => {
    churn.executed.push(r);
    store.upsertFollowRecord({ ...r, state: 'pending_followback' });
    frontier.noteFollow(r.targetPk);
    return 'ok';
  };
  const pacing = new FakePlan(T0 + HOUR, store);
  pacing.checkEveryMs = Number.POSITIVE_INFINITY;
  const acquisition = new FakeAcquisition();
  const enricher = new FakeEnricher(store, clock);
  const ownFollowers = new AdapterBackedOwnFollowersTargetSource({ store, ownPk: 'me', clock, enricher });
  const chain = new ChainController({ store, clock, ownPk: 'me', frontier, ownFollowers,
    discovery: { discover: async () => [] } });
  const scanner = new Scanner({ store, quality: { prepare: () => frontier.refreshQuality(),
    floor: () => frontier.qualityView().floor ?? SCORER_DEFAULTS.bandEdgeScore,
    usableCount: (pk) => frontier.goodQueuedCount(pk) } });
  const sleep = new FakeSleep(clock);
  const engine = new Engine(testDeps({ store, clock, pacing, frontier, churn, acquisition, enricher, chain, scanner,
    settings: { ...DEFAULT_SETTINGS, lowWaterCandidates: 2 },
    delays: new DelayManager({ clock, sleep: sleep.fn }) }));
  const prospect = (pk: string, source: string, fields: AccountFields = { followers: 1000, following: 1100 }) => {
    observe(pk);
    store.observeEdge(pk, source, 'follows', true, clock.now());
    enricher.profiles.set(pk, { pk, fields });
  };
  return { store, clock, observe, queue, frontier, engine, acquisition, enricher, churn, pacing, prospect, ownFollowers, sleep };
}

test('a stocked source prepares a reserve while old good follows continue between bounded reads', async () => {
  const h = rig({ alternative: true });
  h.prospect('b0', 'b'); h.prospect('b1', 'b');
  expect(await h.engine.stepOnce()).toBe('advanced-chain');
  expect(h.engine.status().currentTargetPk).toBe('b');
  expect(h.store.followRecordsByState('queued').filter((r) => r.targetPk === 'a')).toHaveLength(4);
  expect(await h.engine.stepOnce()).toBe('acted');
  expect(h.churn.executed[0]?.targetPk).toBe('a');
  expect(await h.engine.stepOnce()).toBe('acquired');
  expect(h.acquisition.calls).toEqual(['b']);
  expect(h.enricher.calls).toEqual([]); // acquisition was this unit's one read
  expect(await h.engine.stepOnce()).toBe('acted');
  expect(await h.engine.stepOnce()).toBe('acquired');
  expect(h.enricher.calls).toEqual([['b0']]);
  expect(h.store.getFollowRecord('b0')?.state).toBe('queued'); // planned before yielding
  expect(h.frontier.qualityView().qualifiedSources).not.toContain('b');
  expect(await h.engine.stepOnce()).toBe('acted');
  expect(h.churn.executed.at(-1)?.targetPk).toBe('a');
  expect(await h.engine.stepOnce()).toBe('acquired');
  expect(h.enricher.calls).toEqual([['b0'], ['b1']]);
  expect(h.frontier.qualityView().qualifiedSources).toContain('b');
  expect(await h.engine.stepOnce()).toBe('acted');
  expect(h.churn.executed.at(-1)?.targetPk).toBe('b');
});

test('weak queued records do not make the read source stocked or block its next enrichment', async () => {
  const h = rig({ alternative: true });
  for (let i = 0; i < 10; i++) h.queue(`weak-${i}`, 'b', 695);
  h.prospect('better', 'b');
  await h.engine.stepOnce(); await h.engine.stepOnce();
  await h.engine.stepOnce(); await h.engine.stepOnce();
  expect(await h.engine.stepOnce()).toBe('acquired');
  expect(h.enricher.calls).toEqual([['better']]);
  expect(h.store.getFollowRecord('better')?.state).toBe('queued');
  expect(h.churn.executed.every((r) => r.targetPk === 'a')).toBe(true);
});

test('a previously qualified reserve below K still needs replenishment', async () => {
  const h = rig({ alternative: true });
  h.queue('b0', 'b'); h.queue('b1', 'b');
  h.frontier.refreshQuality();
  h.store.upsertFollowRecord(rec({ accountPk: 'b1', targetPk: 'b', state: 'pending_followback' }));
  expect(h.frontier.qualityView().qualifiedSources).toContain('b');
  expect(h.frontier.goodQueuedCount('b')).toBe(1);
  expect(await h.engine.stepOnce()).toBe('advanced-chain');
  expect(h.engine.status().currentTargetPk).toBe('b');
});

test('no alternative does not re-adopt the stocked source or park an old good action', async () => {
  const h = rig();
  expect(await h.engine.stepOnce()).toBe('idle');
  expect(h.sleep.calls).toEqual([]);
  const visit = h.frontier.snapshot().sources[0]?.visit;
  expect(await h.engine.stepOnce()).toBe('acted');
  expect(await h.engine.stepOnce()).toBe('acted');
  expect(h.acquisition.calls).toEqual([]);
  expect(h.enricher.calls).toEqual([]);
  expect(h.frontier.snapshot().sources[0]?.visit?.startedAt).toBe(visit?.startedAt);
});

test('a sole source can refill after its queue drops below readiness despite a deferred reserve search', async () => {
  const h = rig();
  h.prospect('upcoming', 'a');
  expect(await h.engine.stepOnce()).toBe('idle'); // no other source, reserve search deferred
  for (let i = 0; i < 3; i++) expect(await h.engine.stepOnce()).toBe('acted');
  expect(h.frontier.goodQueuedCount('a')).toBe(1);
  expect(await h.engine.stepOnce()).toBe('acquired');
  expect(h.acquisition.calls).toEqual(['a']); // existing-source refill was not deferred
  expect(await h.engine.stepOnce()).toBe('acted');
  expect(await h.engine.stepOnce()).toBe('acquired');
  expect(h.store.getFollowRecord('upcoming')?.state).toBe('queued');
});

test('one fallback profile can leave preparation pending, but the next tick acts before trying another', async () => {
  const h = rig();
  h.prospect('tiny', 'me', { followers: 10, following: 11 });
  h.prospect('hub', 'me', { followers: 1000, following: 1100 });
  // Preserve list insertion order to exercise the non-qualifying first unit.
  expect(await h.engine.stepOnce()).toBe('idle');
  expect(h.enricher.calls).toEqual([['tiny']]);
  expect(h.ownFollowers.preparationState()).toEqual({ pending: true, retryAt: null });
  expect(await h.engine.stepOnce()).toBe('acted');
  expect(h.enricher.calls).toHaveLength(1);
  expect(await h.engine.stepOnce()).toBe('advanced-chain');
  expect(h.enricher.calls).toEqual([['tiny'], ['hub']]);
  expect(h.engine.status().currentTargetPk).toBe('hub');
});

test.each([null, T0 + HOUR])('fallback refusal with retry %s leaves good actions available and does not repeat reads', async (retryAt) => {
  const h = rig();
  h.prospect('unknown', 'me');
  h.enricher.enrich = jest.fn(async () => 0);
  Object.assign(h.enricher, { budgetResumeAt: () => retryAt });
  expect(await h.engine.stepOnce()).toBe('idle');
  expect(h.sleep.calls).toEqual([]);
  expect(await h.engine.stepOnce()).toBe('acted');
  expect(await h.engine.stepOnce()).toBe('acted');
  expect(h.enricher.enrich).toHaveBeenCalledTimes(1);
  expect(h.engine.status().currentTargetPk).toBe('a');
});

test('small profile steps are not mislabeled as complete empty slices', async () => {
  const h = rig({ alternative: true, follows: 10 });
  for (let i = 0; i < 20; i++) h.prospect(`bad-${i}`, 'b', { followers: 10, following: 11 });
  await h.engine.stepOnce(); await h.engine.stepOnce(); // advance, act
  await h.engine.stepOnce(); await h.engine.stepOnce(); // acquire, act
  await h.engine.stepOnce(); await h.engine.stepOnce(); // first profile, act
  await h.engine.stepOnce(); // second profile
  expect(h.enricher.calls.map((batch) => batch.length)).toEqual([1, 1]);
  expect(h.frontier.snapshot().sources.find((s) => s.pk === 'b')?.visit?.emptySlices).toBe(0);
  expect(h.frontier.rotationReason('b')).toBeNull();
});

test('successful profiles are planned even when the same enrichment unit reaches a durable read refusal', async () => {
  const h = rig({ alternative: true });
  h.prospect('fresh', 'b');
  Object.assign(h.enricher, { budgetResumeAt: () => T0 + HOUR });
  await h.engine.stepOnce(); await h.engine.stepOnce();
  await h.engine.stepOnce(); await h.engine.stepOnce();
  expect(await h.engine.stepOnce()).toBe('idle');
  expect(h.store.getFollowRecord('fresh')?.state).toBe('queued');
  expect(await h.engine.stepOnce()).toBe('acted');
  expect(h.churn.executed.at(-1)?.targetPk).toBe('a');
  expect(h.enricher.calls).toHaveLength(1);
});

test('a partly attempted full slice resumes at the budget deadline rather than being stuck at a zero slice', async () => {
  const h = rig({ follows: 0 });
  for (let i = 0; i < 24; i++) h.prospect(`p${i}`, 'a');
  const enrich = h.enricher.enrich.bind(h.enricher);
  h.enricher.enrich = jest.fn((usernames) => enrich(usernames.slice(0, 1)));
  let retryAt: number | null = T0 + HOUR;
  Object.assign(h.enricher, { budgetResumeAt: () => retryAt });
  expect(await h.engine.stepOnce()).toBe('idle');
  expect(h.enricher.enrich).toHaveBeenCalledTimes(1);
  expect(h.enricher.enrich).toHaveBeenLastCalledWith(expect.any(Array));
  h.clock.advance(HOUR);
  retryAt = null;
  expect(await h.engine.stepOnce()).toBe('acquired');
  expect(h.enricher.enrich).toHaveBeenCalledTimes(2);
});

test('a complete failed profile slice still reaches the existing recovery backoff', async () => {
  const h = rig({ follows: 0 });
  for (let i = 0; i < 24; i++) h.prospect(`p${i}`, 'a');
  h.enricher.enrich = jest.fn(async () => 0);
  expect(await h.engine.stepOnce()).toBe('acquired');
  expect(h.sleep.calls).toEqual([]);
  expect(await h.engine.stepOnce()).toBe('idle');
  expect(h.enricher.enrich).toHaveBeenCalledTimes(1);
  expect(h.sleep.calls.length).toBeGreaterThan(0);
  expect(h.store.getTarget('a')?.status).toBe('active');
});

test.each(['no reads', 'paused', 'invalid anchors'] as const)('%s prevents reserve traffic while existing permitted actions remain', async (reason) => {
  const h = rig({ alternative: true });
  h.frontier.refreshQuality();
  if (reason === 'no reads') h.pacing.exploreLeft = 0;
  if (reason === 'paused') h.pacing.pausedActivities.add('exploration');
  if (reason === 'invalid anchors') {
    // A deliberate audience edit invalidates the original cohort; it cannot lower its own bar.
    const raw = JSON.parse(h.store.getSourceFrontierState()!);
    for (const anchor of raw.quality.anchors) anchor.followers = 0;
    h.store.setSourceFrontierState(JSON.stringify(raw));
  }
  expect(await h.engine.stepOnce()).toBe(reason === 'invalid anchors' ? 'idle' : 'acted');
  expect(h.engine.status().currentTargetPk).toBe('a');
  expect(h.acquisition.calls).toEqual([]);
  expect(h.enricher.calls).toEqual([]);
});

import {
  ChainController,
  CHAIN_DEFAULTS,
  type DiscoveredTarget,
  type TargetDiscovery,
  type OwnFollowersTargetSource,
} from '@/engine/chain-controller';
import { FakeClock } from '@/governors/clock';
import { KnowledgeStore } from '@/store/knowledge-store';
import type { Target } from '@/store/types';

const OWN = 'me';

let store: KnowledgeStore;
beforeEach(() => { store = new KnowledgeStore(':memory:'); });
afterEach(() => store.close());

/** A scripted discovery source returning a fixed candidate list. */
class FakeDiscovery implements TargetDiscovery {
  calls: string[] = [];
  constructor(private readonly result: DiscoveredTarget[]) {}
  async discover(currentTargetPk: string): Promise<DiscoveredTarget[]> {
    this.calls.push(currentTargetPk);
    return this.result;
  }
}

/** A scripted own-followers fallback source. */
class FakeOwnFollowers implements OwnFollowersTargetSource {
  calls = 0;
  constructor(private readonly pk: string | null) {}
  async pick(): Promise<string | null> {
    this.calls += 1;
    return this.pk;
  }
}

const target = (over: Partial<Target> & { accountPk: string }): Target => ({
  source: 'seed',
  status: 'active',
  chainIndex: 0,
  ...over,
});

const controller = (
  discovery: TargetDiscovery,
  ownFollowers: OwnFollowersTargetSource,
): ChainController =>
  new ChainController({ store, ownPk: OWN, discovery, ownFollowers });

test('promotes a discovered candidate that clears both thresholds', async () => {
  store.addTarget(target({ accountPk: 'SEED', chainIndex: 0 }));

  const discovery = new FakeDiscovery([
    { pk: 'HUB', projectedFollowBackRate: 0.4, poolSize: 800 },
  ]);
  const own = new FakeOwnFollowers('own1');

  const res = await controller(discovery, own).advance('SEED');

  expect(res).toEqual({
    nextTargetPk: 'HUB',
    source: 'discovered',
    reason: 'meets-min-yield',
  });
  // Current target marked exhausted.
  expect(store.getTarget('SEED')!.status).toBe('exhausted');
  // New target added with discovered source and an advanced chain index.
  const hub = store.getTarget('HUB')!;
  expect(hub.source).toBe('discovered');
  expect(hub.status).toBe('active');
  expect(hub.chainIndex).toBe(1);
  // Discovery ran against the current target; fallback not consulted.
  expect(discovery.calls).toEqual(['SEED']);
  expect(own.calls).toBe(0);
});

test('sets role retained_target on an existing account row', async () => {
  store.addTarget(target({ accountPk: 'SEED', chainIndex: 0 }));
  // Pre-create the HUB account so setRole has a row to update.
  store.observe({ accountPk: 'HUB', observedAt: 1, source: 'profile', fields: {} });

  const discovery = new FakeDiscovery([
    { pk: 'HUB', projectedFollowBackRate: 0.4, poolSize: 800 },
  ]);
  const res = await controller(discovery, new FakeOwnFollowers(null)).advance('SEED');

  expect(res.source).toBe('discovered');
  expect(store.getAccount('HUB')!.role).toBe('retained_target');
});

test('falls back to own followers when no candidate meets the thresholds', async () => {
  store.addTarget(target({ accountPk: 'SEED', chainIndex: 0 }));

  const discovery = new FakeDiscovery([
    // Rate too low.
    { pk: 'A', projectedFollowBackRate: 0.1, poolSize: 5000 },
    // Pool too small.
    { pk: 'B', projectedFollowBackRate: 0.9, poolSize: 50 },
  ]);
  const own = new FakeOwnFollowers('OWNPICK');

  const res = await controller(discovery, own).advance('SEED');

  expect(res).toEqual({
    nextTargetPk: 'OWNPICK',
    source: 'own_followers',
    reason: 'no-discovered-target-met-min-yield',
  });
  expect(store.getTarget('SEED')!.status).toBe('exhausted');
  const picked = store.getTarget('OWNPICK')!;
  expect(picked.source).toBe('own_followers');
  expect(picked.status).toBe('active');
  expect(picked.chainIndex).toBe(1);
  expect(own.calls).toBe(1);
});

test('returns none when discovery is empty and fallback yields null', async () => {
  store.addTarget(target({ accountPk: 'SEED', chainIndex: 0 }));

  const res = await controller(
    new FakeDiscovery([]),
    new FakeOwnFollowers(null),
  ).advance('SEED');

  expect(res).toEqual({ nextTargetPk: null, source: 'none', reason: 'no-target-available' });
  expect(store.getTarget('SEED')!.status).toBe('exhausted');
  // No new target rows beyond the (now exhausted) seed.
  expect(store.listTargets().map((t) => t.accountPk)).toEqual(['SEED']);
});

test('chooses the highest projectedFollowBackRate among several qualifying candidates', async () => {
  store.addTarget(target({ accountPk: 'SEED', chainIndex: 0 }));

  const discovery = new FakeDiscovery([
    { pk: 'LO', projectedFollowBackRate: 0.2, poolSize: 400 },
    { pk: 'HI', projectedFollowBackRate: 0.6, poolSize: 400 },
    { pk: 'MID', projectedFollowBackRate: 0.35, poolSize: 400 },
    // Higher rate but disqualified by pool size — must NOT win.
    { pk: 'BIGRATE', projectedFollowBackRate: 0.99, poolSize: 10 },
  ]);

  const res = await controller(discovery, new FakeOwnFollowers(null)).advance('SEED');

  expect(res.nextTargetPk).toBe('HI');
  expect(res.source).toBe('discovered');
});

test('advance stamps exhaustedAt with the clock time — the verdict stays reversible', async () => {
  store.addTarget(target({ accountPk: 'SEED', chainIndex: 0 }));

  const c = new ChainController({
    store,
    ownPk: OWN,
    discovery: new FakeDiscovery([]),
    ownFollowers: new FakeOwnFollowers(null),
    clock: new FakeClock(123_456),
  });
  await c.advance('SEED');

  const seed = store.getTarget('SEED')!;
  expect(seed.status).toBe('exhausted');
  // The evidence stamp is what the engine's dead-end re-verify window reads.
  expect(seed.exhaustedAt).toBe(123_456);
  expect(store.exhaustedTargetsSince(0).map((t) => t.accountPk)).toEqual(['SEED']);
});

test('a candidate exactly at both thresholds qualifies (inclusive bounds)', async () => {
  store.addTarget(target({ accountPk: 'SEED', chainIndex: 0 }));

  const discovery = new FakeDiscovery([
    {
      pk: 'EDGE',
      projectedFollowBackRate: CHAIN_DEFAULTS.minFollowBackRate,
      poolSize: CHAIN_DEFAULTS.minPoolSize,
    },
  ]);

  const res = await controller(discovery, new FakeOwnFollowers('fb')).advance('SEED');
  expect(res.nextTargetPk).toBe('EDGE');
  expect(res.source).toBe('discovered');
});

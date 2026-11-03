import fc from 'fast-check';
import { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import { FakeClock } from '@/governors/clock';
import { ReadBudget } from '@/governors/read-budget';
import { AdapterBackedAcquisition } from '@/rim/follower-acquisition';
import { FollowersPageReader } from '@/rim/followers-page-reader';
import { ListPageWalker } from '@/rim/list-page-walker';
import { AdapterBackedProfileEnricher } from '@/rim/profile-enricher';
import { KnowledgeStore } from '@/store/knowledge-store';
import { FakeActor, FakeSentinel, FakeTab, followersBody } from '../kit/fakes';
import { readLimits } from '../kit/read-limits';

let store: KnowledgeStore;
let clock: FakeClock;
beforeEach(() => { store = new KnowledgeStore(':memory:'); clock = new FakeClock(1_000_000); });
afterEach(() => store.close());

test('read reservations survive a restart and expire only after their rolling window', () => {
  let budget = new ReadBudget({ store, clock, limits: readLimits({ profiles: 2, windowMs: 1000 }) });
  expect(budget.consume('profile').allowed).toBe(true);
  clock.advance(100);
  expect(budget.consume('profile').allowed).toBe(true);
  budget = new ReadBudget({ store, clock, limits: readLimits({ profiles: 2, windowMs: 1000 }) });
  expect(budget.consume('profile')).toEqual({ allowed: false, resumeAt: 1_001_000 });
  clock.advance(900);
  expect(budget.consume('profile').allowed).toBe(true);
  expect(budget.consume('profile')).toEqual({ allowed: false, resumeAt: 1_001_100 });
});

test('optional exploration cannot consume the reconciliation reserve or bypass the global ceiling', () => {
  const budget = new ReadBudget({ store, clock, limits: readLimits({ listPages: 4, explorationPages: 2 }) });
  expect(budget.consume('list-page', 'exploration', 2).allowed).toBe(true);
  expect(budget.consume('list-page', 'exploration').allowed).toBe(false);
  expect(budget.consume('list-page', 'reconciliation', 2).allowed).toBe(true);
  expect(budget.consume('list-page', 'reconciliation').allowed).toBe(false);
  expect(budget.snapshot().debits.reduce((sum, d) => sum + d.count, 0)).toBe(4);
});

test('enrichment cannot spend profiles reserved for fresh mutation identity and recovery, even after restart', () => {
  const { profiles, explorationProfiles } = readLimits()();
  let budget = new ReadBudget({ store, clock, limits: readLimits() });
  expect(budget.consume('profile', 'exploration', explorationProfiles).allowed).toBe(true);
  budget = new ReadBudget({ store, clock, limits: readLimits() });
  expect(budget.consume('profile', 'exploration').allowed).toBe(false);
  expect(budget.consume('profile', 'reconciliation', profiles - explorationProfiles).allowed).toBe(true);
  expect(budget.consume('profile', 'reconciliation').allowed).toBe(false);
});

test('the allowance is read live: a settings change moves the ceiling without a restart', () => {
  let ceiling = 1;
  const budget = new ReadBudget({ store, clock, limits: () => readLimits({ profiles: ceiling })() });
  expect(budget.consume('profile', 'reconciliation').allowed).toBe(true);
  expect(budget.consume('profile', 'reconciliation').allowed).toBe(false);
  ceiling = 2;
  expect(budget.consume('profile', 'reconciliation').allowed).toBe(true);
});

test('generated attempted reservations never exceed the same finite budget after arbitrary restarts', () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 5 }), { maxLength: 100 }), (counts) => {
    store.setReadBudgetState(null);
    let permitted = 0;
    for (const count of counts) {
      const budget = new ReadBudget({ store, clock, limits: readLimits({ profiles: 20 }) });
      if (budget.consume('profile', 'exploration', count).allowed) permitted += count;
    }
    expect(permitted).toBeLessThanOrEqual(20);
  }));
});

test('enrichment reserves before visiting and a spent budget stops without claiming a wall', async () => {
  const budget = new ReadBudget({ store, clock, limits: readLimits({ profiles: 1 }) });
  const visited: string[] = [];
  const enricher = new AdapterBackedProfileEnricher({ store, clock, readBudget: budget,
    sentinel: new FakeSentinel() as unknown as Sentinel, sleep: async () => {}, paceMs: 0,
    visitor: { visit: async (username) => {
      expect(budget.snapshot().debits).toHaveLength(1);
      visited.push(username);
      return { ok: true, obs: { accountPk: username, observedAt: clock.now(), source: 'profile', fields: { username } },
        viewer: { following: null, requested: null, followsUs: null } };
    } },
  });
  expect(await enricher.enrich(['one', 'two'])).toBe(1);
  expect(visited).toEqual(['one']);
  expect(enricher.budgetResumeAt()).toBeGreaterThan(clock.now());
});

test('list budget exhaustion streams paid-for rows, preserves resume cursor, and never falls back', async () => {
  const budget = new ReadBudget({ store, clock, limits: readLimits({ explorationPages: 1 }) });
  const tab = new FakeTab();
  let calls = 0;
  tab.onEvaluate = () => {
    calls += 1;
    return { ok: true, status: 200, contentType: 'application/json', json: followersBody(['p1', 'p2'], 'C1', true) };
  };
  const reader = new Reader();
  const actor = new FakeActor();
  const sentinel = new FakeSentinel() as unknown as Sentinel;
  const pageReader = new FollowersPageReader({ tab, reader, actor, clock, readBudget: budget, sleep: async () => {} });
  const walker = new ListPageWalker({ tab, reader, clock, readBudget: budget, sleep: async () => {} });
  store.observe({ accountPk: 'target', observedAt: clock.now(), source: 'profile', fields: { username: 'target', followers: 1000, following: 1000 } });
  const acquisition = new AdapterBackedAcquisition({ pageReader, walker, store, sentinel, clock, readBudget: budget });
  const result = await acquisition.acquire('target');
  expect(result.endReason).toBe('read-budget');
  expect(result.retryAt).toBeGreaterThan(clock.now());
  expect(calls).toBe(1);
  expect(actor.openCalls).toBe(0);
  expect(store.getEdge('p1', 'target', 'follows')).not.toBeNull();
  expect(store.getScrapeCursor('target')).toBe('C1');
});

test('dialog transport uses the same budget and cannot bypass a spent direct-read allowance', async () => {
  const budget = new ReadBudget({ store, clock, limits: readLimits({ explorationPages: 1 }) });
  budget.consume('list-page', 'exploration');
  const actor = new FakeActor();
  const reader = new FollowersPageReader({ tab: new FakeTab(), reader: new Reader(), actor, clock, readBudget: budget });
  const result = await reader.collect({ targetUsername: 'target', readPurpose: 'exploration', onObservation: () => {},
    sentinel: new FakeSentinel() as unknown as Sentinel, maxRounds: 2, noNewStop: 1 });
  expect(result.endReason).toBe('read-budget');
  expect(actor.openCalls).toBe(0);
  expect(result.observedPks).toEqual([]);
});

test('a zero-read refusal does not erase or refresh an aged source cursor', async () => {
  const budget = new ReadBudget({ store, clock, limits: readLimits({ explorationPages: 1 }) });
  budget.consume('list-page', 'exploration');
  const tab = new FakeTab();
  const reader = new Reader();
  const sentinel = new FakeSentinel() as unknown as Sentinel;
  const pageReader = new FollowersPageReader({ tab, reader, actor: new FakeActor(), clock, readBudget: budget });
  const walker = new ListPageWalker({ tab, reader, clock, readBudget: budget });
  store.observe({ accountPk: 'target', observedAt: clock.now(), source: 'profile', fields: { username: 'target', followers: 1000 } });
  const saved = { cursor: 'deep-cursor', updatedAt: clock.now() - 8 * 86_400_000 };
  store.setScrapeCursor('target', saved.cursor, saved.updatedAt);
  const acquisition = new AdapterBackedAcquisition({ pageReader, walker, store, sentinel, clock, readBudget: budget });
  expect((await acquisition.acquire('target')).endReason).toBe('read-budget');
  expect(store.getScrapeCursorState('target')).toEqual(saved);
});

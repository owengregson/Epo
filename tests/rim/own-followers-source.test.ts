import { AdapterBackedOwnFollowersSource } from '@/rim/own-followers-source';
import { FollowersPageReader } from '@/rim/followers-page-reader';
import { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import type { RequestBudget } from '@/governors/request-budget';
import { KnowledgeStore } from '@/store/knowledge-store';
import { FakeClock } from '@/governors/clock';
import type { TabResponse } from '@/types';
import {
  FakeTab,
  FakeBudget,
  FakeSentinel,
  FakeActor,
  followersUrl,
  followersBody,
  mkResp,
} from './fakes';
import { setLevel } from '@/utils/logger';

beforeAll(() => setLevel('error'));

const reader = new Reader();
const clock = new FakeClock(2_000_000);

let store: KnowledgeStore;
beforeEach(() => {
  store = new KnowledgeStore(':memory:');
});
afterEach(() => store.close());

/** Drive one bounded own-followers sweep over scripted followers pages. */
const buildSource = (opts: {
  withStore: boolean;
}): { source: AdapterBackedOwnFollowersSource; actor: FakeActor } => {
  const tab = new FakeTab();
  const actor = new FakeActor();
  const pageReader = new FollowersPageReader({ tab, reader, actor, clock, scrollWaitMs: 1 });

  const pages: TabResponse[] = [
    mkResp(followersUrl('42'), followersBody(['a', 'b'], 'C1', true)), // on open
    mkResp(followersUrl('42', 'C1'), followersBody(['c'], 'C2', true)), // scroll 1
    mkResp(followersUrl('42', 'C2'), followersBody([], 'C2', true)), // scroll 2: no new
    mkResp(followersUrl('42', 'C2'), followersBody([], 'C2', true)), // scroll 3: no new → stop
  ];
  let i = 0;
  actor.onOpen = () => tab.emit(pages[i++]);
  actor.onScroll = () => {
    if (i < pages.length) tab.emit(pages[i++]);
  };

  const source = new AdapterBackedOwnFollowersSource({
    pageReader,
    ownUsername: 'me',
    budget: new FakeBudget() as unknown as RequestBudget,
    sentinel: new FakeSentinel() as unknown as Sentinel,
    store: opts.withStore ? store : undefined,
    cfg: { maxRounds: 5, noNewStop: 2, pageSize: 50 },
  });
  return { source, actor };
};

test('f11: a sweep stores every parsed follower profile as a real account row', async () => {
  const { source } = buildSource({ withStore: true });

  const page = await source.nextPage(null); // null cursor → fresh sweep

  // The pks are still yielded to the Watcher as before.
  expect([...page.pks].sort()).toEqual(['a', 'b', 'c']);
  // f11: and each parsed follower is now a stored account row (free data).
  for (const pk of ['a', 'b', 'c']) {
    const account = store.getAccount(pk);
    expect(account).not.toBeNull();
    expect(account?.username).toBe(`u${pk}`);
  }
});

test('f11: without an injected store the sweep still yields pks (no observations, no throw)', async () => {
  const { source } = buildSource({ withStore: false });

  const page = await source.nextPage(null);

  expect([...page.pks].sort()).toEqual(['a', 'b', 'c']);
  // Nothing was written anywhere (the separate `store` fixture stays empty).
  expect(store.getAccount('a')).toBeNull();
});

// --- fetchAllPks (Phase 5 — the prune scan's whole-list, interruptible scrape) ------

test('fetchAllPks scrapes the whole followers list in one call and stores every profile', async () => {
  const { source, actor } = buildSource({ withStore: true });

  const pks = await source.fetchAllPks();

  expect([...pks].sort()).toEqual(['a', 'b', 'c']);
  expect(actor.openCalls).toBe(1); // the FOLLOWERS dialog, never following
  expect(actor.openFollowingCalls).toBe(0);
  for (const pk of ['a', 'b', 'c']) {
    expect(store.getAccount(pk)?.username).toBe(`u${pk}`);
  }
});

test('fetchAllPks threads shouldStop into the scrape (immediate stop: no scroll, open page kept)', async () => {
  const { source, actor } = buildSource({ withStore: true });

  const pks = await source.fetchAllPks({ shouldStop: () => true });

  expect(actor.scrollCalls).toBe(0);
  expect([...pks].sort()).toEqual(['a', 'b']); // only the on-open page landed
});

test('fetchAllPks threads the jittered scan pacing into the scrape', async () => {
  const tab = new FakeTab();
  const actor = new FakeActor();
  const sleeps: number[] = [];
  const pageReader = new FollowersPageReader({
    tab,
    reader,
    actor,
    clock,
    scrollWaitMs: 1,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    rng: () => 0.5,
  });
  actor.onOpen = () => tab.emit(mkResp(followersUrl('42'), followersBody(['a'], null, false)));

  const source = new AdapterBackedOwnFollowersSource({
    pageReader,
    ownUsername: 'me',
    budget: new FakeBudget() as unknown as RequestBudget,
    sentinel: new FakeSentinel() as unknown as Sentinel,
    store,
  });

  const pks = await source.fetchAllPks({ scrollMinMs: 1_000, scrollMaxMs: 3_000 });

  expect(pks).toEqual(['a']);
  // Every wait the scrape took was the deterministic midpoint draw, not 2000ms fixed.
  expect(sleeps.length).toBeGreaterThan(0);
  for (const ms of sleeps) expect(ms).toBe(2_000);
});

test('fetchAllPks with a blocked sentinel yields an empty scrape (warned, never a throw)', async () => {
  const tab = new FakeTab();
  const actor = new FakeActor();
  const pageReader = new FollowersPageReader({ tab, reader, actor, clock, scrollWaitMs: 1 });
  const source = new AdapterBackedOwnFollowersSource({
    pageReader,
    ownUsername: 'me',
    budget: new FakeBudget() as unknown as RequestBudget,
    sentinel: new FakeSentinel(['challenge']) as unknown as Sentinel,
    store,
  });

  await expect(source.fetchAllPks()).resolves.toEqual([]);
  expect(actor.openCalls).toBe(0); // never touched the tab
});

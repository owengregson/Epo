/**
 * AdapterBackedOwnFollowingSource (Phase 5): one bounded scrape of our OWN
 * FOLLOWING list through the shared FollowersPageReader's `dialog: 'following'`
 * route — the FOLLOWING dialog is opened (never followers), the paginated
 * `following/` endpoint is what gets parsed, and every parsed profile lands in
 * the store so prune candidates carry usernames.
 */
import { AdapterBackedOwnFollowingSource } from '@/rim/own-following-source';
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
  followingUrl,
  followersBody,
  mkResp,
} from './fakes';
import { setLevel } from '@/utils/logger';

beforeAll(() => setLevel('error'));

const reader = new Reader();
const clock = new FakeClock(3_000_000);

let store: KnowledgeStore;
beforeEach(() => {
  store = new KnowledgeStore(':memory:');
});
afterEach(() => store.close());

const buildSource = (): { source: AdapterBackedOwnFollowingSource; actor: FakeActor } => {
  const tab = new FakeTab();
  const actor = new FakeActor();
  const pageReader = new FollowersPageReader({ tab, reader, actor, clock, scrollWaitMs: 1 });

  const pages: TabResponse[] = [
    mkResp(followingUrl('42'), followersBody(['a', 'b'], 'C1', true)), // on open
    mkResp(followingUrl('42', 'C1'), followersBody(['c'], 'C2', true)), // scroll 1
    mkResp(followingUrl('42', 'C2'), followersBody([], 'C2', true)), // scroll 2: no new
    mkResp(followingUrl('42', 'C2'), followersBody([], 'C2', true)), // scroll 3: no new → stop
  ];
  let i = 0;
  actor.onOpen = () => tab.emit(pages[i++]);
  actor.onScroll = () => {
    if (i < pages.length) tab.emit(pages[i++]);
  };

  const source = new AdapterBackedOwnFollowingSource({
    pageReader,
    ownUsername: 'me',
    budget: new FakeBudget() as unknown as RequestBudget,
    sentinel: new FakeSentinel() as unknown as Sentinel,
    store,
    cfg: { maxRounds: 5, noNewStop: 2 },
  });
  return { source, actor };
};

test('fetchAllPks opens the FOLLOWING dialog (never followers) and yields every pk', async () => {
  const { source, actor } = buildSource();

  const pks = await source.fetchAllPks();

  expect([...pks].sort()).toEqual(['a', 'b', 'c']);
  expect(actor.openFollowingCalls).toBe(1);
  expect(actor.openCalls).toBe(0); // the followers dialog was never opened
  // Every parsed following profile became a stored account row (usernames the
  // PruneEngine reads back when composing candidates).
  for (const pk of ['a', 'b', 'c']) {
    expect(store.getAccount(pk)?.username).toBe(`u${pk}`);
  }
});

test('a followers-list response is ignored while the following dialog drives the scrape', async () => {
  const tab = new FakeTab();
  const actor = new FakeActor();
  const pageReader = new FollowersPageReader({ tab, reader, actor, clock, scrollWaitMs: 1 });
  actor.onOpen = () => {
    // A stray followers page (e.g. cached traffic) must not be ingested.
    tab.emit(mkResp(followersUrl('42'), followersBody(['stray'], null, false)));
    tab.emit(mkResp(followingUrl('42'), followersBody(['real'], null, false)));
  };

  const source = new AdapterBackedOwnFollowingSource({
    pageReader,
    ownUsername: 'me',
    budget: new FakeBudget() as unknown as RequestBudget,
    sentinel: new FakeSentinel() as unknown as Sentinel,
    store,
    cfg: { maxRounds: 2, noNewStop: 1 },
  });

  const pks = await source.fetchAllPks();
  expect(pks).toEqual(['real']);
  expect(store.getAccount('stray')).toBeNull();
});

test('fetchAllPks threads shouldStop + the jittered scan pacing into the scrape', async () => {
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
  let n = 0;
  actor.onOpen = () => tab.emit(mkResp(followingUrl('42'), followersBody(['a'], 'C', true)));
  actor.onScroll = () => {
    n += 1;
    tab.emit(mkResp(followingUrl('42', `C${n}`), followersBody([`s${n}`], `C${n}`, true)));
  };

  const source = new AdapterBackedOwnFollowingSource({
    pageReader,
    ownUsername: 'me',
    budget: new FakeBudget() as unknown as RequestBudget,
    sentinel: new FakeSentinel() as unknown as Sentinel,
    store,
    cfg: { maxRounds: 2, noNewStop: 5 },
  });

  let stop = false;
  const pks = await source.fetchAllPks({
    shouldStop: () => stop,
    scrollMinMs: 1_000,
    scrollMaxMs: 3_000,
  });

  // Pacing reached the reader: every wait is the deterministic midpoint draw.
  expect(sleeps).toEqual([2_000, 2_000, 2_000]);
  expect([...pks].sort()).toEqual(['a', 's1', 's2']);

  // And an immediate stop reaches the reader too: no scroll, no wait.
  stop = true;
  actor.scrollCalls = 0;
  sleeps.length = 0;
  actor.onOpen = () => tab.emit(mkResp(followingUrl('42'), followersBody(['z'], null, false)));
  const stopped = await source.fetchAllPks({ shouldStop: () => stop });
  expect(actor.scrollCalls).toBe(0);
  expect(sleeps).toEqual([]);
  expect(stopped).toEqual(['z']); // the open-page capture is still returned
});

test('a blocked sentinel yields an empty scrape (warned, never a throw)', async () => {
  const tab = new FakeTab();
  const actor = new FakeActor();
  const pageReader = new FollowersPageReader({ tab, reader, actor, clock, scrollWaitMs: 1 });
  const source = new AdapterBackedOwnFollowingSource({
    pageReader,
    ownUsername: 'me',
    budget: new FakeBudget() as unknown as RequestBudget,
    sentinel: new FakeSentinel(['action-blocked']) as unknown as Sentinel,
    store,
  });

  await expect(source.fetchAllPks()).resolves.toEqual([]);
  expect(actor.openFollowingCalls).toBe(0); // never touched the tab
});

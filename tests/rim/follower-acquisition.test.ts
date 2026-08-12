import { AdapterBackedAcquisition } from '@/rim/follower-acquisition';
import { FollowersPageReader } from '@/rim/followers-page-reader';
import { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import type { RequestBudget } from '@/governors/request-budget';
import { KnowledgeStore } from '@/store/knowledge-store';
import { FakeClock } from '@/governors/clock';
import { FakeTab, FakeBudget, FakeSentinel, FakeActor, followersUrl, followersBody, mkResp } from './fakes';

const reader = new Reader();
const clock = new FakeClock(2_000_000);

let store: KnowledgeStore;
beforeEach(() => {
  store = new KnowledgeStore(':memory:');
});
afterEach(() => store.close());

test('observes followers, back-fills follower→target edges, and persists the cursor', async () => {
  const tab = new FakeTab();
  const actor = new FakeActor();

  // page1 on open (pks a,b), page2 on the first scroll (pks c,d; last page).
  const pages = [
    mkResp(followersUrl('999'), followersBody(['a', 'b'], 'C1', true)),
    mkResp(followersUrl('999', 'C1'), followersBody(['c', 'd'], 'C2', false)),
  ];
  let i = 0;
  actor.onOpen = () => tab.emit(pages[i++]);
  actor.onScroll = () => {
    if (i < pages.length) tab.emit(pages[i++]);
  };

  const pageReader = new FollowersPageReader({ tab, reader, actor, clock, scrollWaitMs: 1 });
  const acquisition = new AdapterBackedAcquisition({
    pageReader,
    store,
    budget: new FakeBudget() as unknown as RequestBudget,
    sentinel: new FakeSentinel() as unknown as Sentinel,
    clock,
    cfg: { maxRounds: 5, noNewStop: 2 },
  });

  const result = await acquisition.acquire('target');

  expect(result.observed).toBe(4);
  expect(result.targetPk).toBe('999');

  // Every observed follower is now an account in the store.
  for (const pk of ['a', 'b', 'c', 'd']) {
    expect(store.getAccount(pk)).not.toBeNull();
  }

  // R1: every follower — including a,b seen on the FIRST page before any later
  // page — has an active follower→target edge.
  for (const pk of ['a', 'b', 'c', 'd']) {
    const edge = store.getEdge(pk, '999', 'follows');
    expect(edge).not.toBeNull();
    expect(edge!.status).toBe('active');
  }

  // R4: the final resume cursor is persisted per target.
  expect(store.getScrapeCursor('999')).toBe('C2');
});

test('bails without scraping when the sentinel is blocked', async () => {
  const tab = new FakeTab();
  const actor = new FakeActor();
  const pageReader = new FollowersPageReader({ tab, reader, actor, clock, scrollWaitMs: 1 });
  const acquisition = new AdapterBackedAcquisition({
    pageReader,
    store,
    budget: new FakeBudget() as unknown as RequestBudget,
    sentinel: new FakeSentinel(['challenge']) as unknown as Sentinel,
    clock,
  });

  const result = await acquisition.acquire('target');
  expect(result).toEqual({ observed: 0, targetPk: null });
  expect(actor.openCalls).toBe(0);
});

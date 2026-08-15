import { AdapterBackedOwnFollowersSource } from '@/rim/own-followers-source';
import { FollowersPageReader } from '@/rim/followers-page-reader';
import { ListPageWalker } from '@/rim/list-page-walker';
import { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import { KnowledgeStore } from '@/store/knowledge-store';
import { FakeClock } from '@/governors/clock';
import type { TabResponse } from '@/types';
import {
  FakeTab,
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

/** Drive one whole-list followers scrape over scripted followers pages. */
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
    sentinel: new FakeSentinel() as unknown as Sentinel,
    store: opts.withStore ? store : undefined,
  });
  return { source, actor };
};

// --- fetchAllPks (Phase 5 — the prune scan's whole-list, interruptible scrape) ------

test('fetchAllPks scrapes the whole followers list in one call and stores every profile', async () => {
  const { source, actor } = buildSource({ withStore: true });

  const { pks } = await source.fetchAllPks();

  expect([...pks].sort()).toEqual(['a', 'b', 'c']);
  expect(actor.openCalls).toBe(1); // the FOLLOWERS dialog, never following
  expect(actor.openFollowingCalls).toBe(0);
  for (const pk of ['a', 'b', 'c']) {
    expect(store.getAccount(pk)?.username).toBe(`u${pk}`);
  }
});

test('f11: without an injected store the scrape still yields pks (no observations, no throw)', async () => {
  const { source } = buildSource({ withStore: false });

  const { pks } = await source.fetchAllPks();

  expect([...pks].sort()).toEqual(['a', 'b', 'c']);
  // Nothing was written anywhere (the separate `store` fixture stays empty).
  expect(store.getAccount('a')).toBeNull();
});

test('fetchAllPks threads onProgress into the scrape (live mid-scan counts)', async () => {
  const { source } = buildSource({ withStore: true });

  const seen: number[] = [];
  await source.fetchAllPks({ onProgress: (n) => seen.push(n) });

  expect(seen.length).toBeGreaterThan(0);
  expect(seen[seen.length - 1]).toBe(3);
});

test('fetchAllPks threads shouldStop into the scrape (immediate stop: no scroll, open page kept)', async () => {
  const { source, actor } = buildSource({ withStore: true });

  const { pks } = await source.fetchAllPks({ shouldStop: () => true });

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
    sentinel: new FakeSentinel() as unknown as Sentinel,
    store,
  });

  const { pks } = await source.fetchAllPks({ scrollMinMs: 1_000, scrollMaxMs: 3_000 });

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
    sentinel: new FakeSentinel(['challenge']) as unknown as Sentinel,
    store,
  });

  await expect(source.fetchAllPks()).resolves.toMatchObject({ pks: [], complete: false });
  expect(actor.openCalls).toBe(0); // never touched the tab
});

describe('direct list-page walker fast path', () => {
  const okEnv = (body: unknown): unknown => ({
    ok: true,
    status: 200,
    contentType: 'application/json',
    json: body,
  });

  const buildWithWalker = (
    envelopes: unknown[],
  ): { source: AdapterBackedOwnFollowersSource; tab: FakeTab; actor: FakeActor } => {
    const tab = new FakeTab();
    const actor = new FakeActor();
    let i = 0;
    tab.onEvaluate = () => envelopes[i++];
    const pageReader = new FollowersPageReader({ tab, reader, actor, clock, scrollWaitMs: 1 });
    const walker = new ListPageWalker({ tab, reader, clock, sleep: async () => {} });
    const source = new AdapterBackedOwnFollowersSource({
      pageReader,
      ownUsername: 'me',
      sentinel: new FakeSentinel() as unknown as Sentinel,
      store,
      walker,
      ownPk: '42',
    });
    return { source, tab, actor };
  };

  test('fetchAllPks pages the API directly — the followers dialog is never opened', async () => {
    const { source, actor } = buildWithWalker([
      okEnv(followersBody(['a', 'b'], 'C1', true)),
      okEnv(followersBody(['c'], null, false)),
      okEnv(followersBody([], null, false)), // the walker's end-verification probe
    ]);

    const { pks } = await source.fetchAllPks();

    expect([...pks].sort()).toEqual(['a', 'b', 'c']);
    expect(actor.openCalls).toBe(0);
    expect(actor.scrollCalls).toBe(0);
  });

  test('a failed direct walk falls back to the dialog-scroll scrape', async () => {
    const { source, tab, actor } = buildWithWalker([
      { ok: false, status: 429, contentType: 'text/html', textHead: 'wall' },
    ]);
    actor.onOpen = () =>
      tab.emit(mkResp(followersUrl('42'), followersBody(['d'], null, false)));

    const { pks } = await source.fetchAllPks();

    expect(pks).toEqual(['d']);
    expect(actor.openCalls).toBe(1);
  });
});

// --- Facts stream (docs/PRINCIPLES.md §1): partial walks still enrich -----------------

test('every parsed follower row writes its follows-us edge IMMEDIATELY — a stopped walk keeps what it saw', async () => {
  const tab = new FakeTab();
  const actor = new FakeActor();
  const pageReader = new FollowersPageReader({ tab, reader, actor, clock, scrollWaitMs: 1 });
  actor.onOpen = () =>
    tab.emit(mkResp(followersUrl('42'), followersBody(['a', 'b'], 'C1', true)));

  const source = new AdapterBackedOwnFollowersSource({
    pageReader,
    ownUsername: 'me',
    sentinel: new FakeSentinel() as unknown as Sentinel,
    store,
    ownPk: 'me-pk',
  });

  // Immediate stop: only the on-open page lands; the walk is INCOMPLETE.
  const res = await source.fetchAllPks({ shouldStop: () => true });
  expect(res.complete).toBe(false);

  // The knowledge already paid for is in the graph anyway — accounts AND the
  // follows-us edges the follow-back watcher's zero-request pass reads.
  for (const pk of ['a', 'b']) {
    expect(store.getAccount(pk)?.username).toBe(`u${pk}`);
    expect(store.getEdge(pk, 'me-pk', 'follows')?.status).toBe('active');
  }
});

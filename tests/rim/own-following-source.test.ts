/**
 * AdapterBackedOwnFollowingSource (Phase 5): one bounded scrape of our OWN
 * FOLLOWING list through the shared FollowersPageReader's `dialog: 'following'`
 * route — the FOLLOWING dialog is opened (never followers), the paginated
 * `following/` endpoint is what gets parsed, and every parsed profile lands in
 * the store so prune candidates carry usernames.
 */
import { AdapterBackedOwnFollowingSource } from '@/rim/own-following-source';
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
    sentinel: new FakeSentinel() as unknown as Sentinel,
    store,
    cfg: { maxRounds: 5, noNewStop: 2 },
  });
  return { source, actor };
};

test('fetchAllPks opens the FOLLOWING dialog (never followers) and yields every pk', async () => {
  const { source, actor } = buildSource();

  const { pks } = await source.fetchAllPks();

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
    sentinel: new FakeSentinel() as unknown as Sentinel,
    store,
    cfg: { maxRounds: 2, noNewStop: 1 },
  });

  const { pks } = await source.fetchAllPks();
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
    sentinel: new FakeSentinel() as unknown as Sentinel,
    store,
    cfg: { maxRounds: 2, noNewStop: 5 },
  });

  let stop = false;
  const { pks } = await source.fetchAllPks({
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
  const { pks: stopped } = await source.fetchAllPks({ shouldStop: () => stop });
  expect(actor.scrollCalls).toBe(0);
  expect(sleeps).toEqual([]);
  expect(stopped).toEqual(['z']); // the open-page capture is still returned
});

test('fetchAllPks threads onProgress into the scrape (live mid-scan counts)', async () => {
  const { source } = buildSource();

  const progress: number[] = [];
  const { pks } = await source.fetchAllPks({ onProgress: (n) => progress.push(n) });

  // Page 1 (open) lands 2 pks, scroll 1 lands 1 more; stagnant pages are silent.
  expect(progress).toEqual([2, 3]);
  expect(pks.length).toBe(3);
});

test('a blocked sentinel yields an empty scrape (warned, never a throw)', async () => {
  const tab = new FakeTab();
  const actor = new FakeActor();
  const pageReader = new FollowersPageReader({ tab, reader, actor, clock, scrollWaitMs: 1 });
  const source = new AdapterBackedOwnFollowingSource({
    pageReader,
    ownUsername: 'me',
    sentinel: new FakeSentinel(['action-blocked']) as unknown as Sentinel,
    store,
  });

  await expect(source.fetchAllPks()).resolves.toMatchObject({ pks: [], complete: false });
  expect(actor.openFollowingCalls).toBe(0); // never touched the tab
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
  ): { source: AdapterBackedOwnFollowingSource; tab: FakeTab; actor: FakeActor } => {
    const tab = new FakeTab();
    const actor = new FakeActor();
    let i = 0;
    tab.onEvaluate = () => envelopes[i++];
    const pageReader = new FollowersPageReader({ tab, reader, actor, clock, scrollWaitMs: 1 });
    const walker = new ListPageWalker({ tab, reader, clock, sleep: async () => {} });
    const source = new AdapterBackedOwnFollowingSource({
      pageReader,
      ownUsername: 'me',
      sentinel: new FakeSentinel() as unknown as Sentinel,
      store,
      walker,
      ownPk: '42',
    });
    return { source, tab, actor };
  };

  test('a wired walker pages the API directly — the FOLLOWING dialog is never opened', async () => {
    const { source, actor } = buildWithWalker([
      okEnv(followersBody(['a', 'b'], 'C1', true)),
      okEnv(followersBody(['c'], null, false)),
      okEnv(followersBody([], null, false)), // the walker's end-verification probe
    ]);

    const { pks } = await source.fetchAllPks();

    expect([...pks].sort()).toEqual(['a', 'b', 'c']);
    expect(actor.openFollowingCalls).toBe(0); // no dialog, no scrolling
    expect(actor.scrollCalls).toBe(0);
    // The walked profiles still become stored account rows (prune usernames).
    for (const pk of ['a', 'b', 'c']) {
      expect(store.getAccount(pk)?.username).toBe(`u${pk}`);
    }
  });

  test('a failed direct walk falls back to the dialog-scroll scrape', async () => {
    const { source, tab, actor } = buildWithWalker([
      { ok: false, status: 429, contentType: 'text/html', textHead: 'wall' },
    ]);
    actor.onOpen = () =>
      tab.emit(mkResp(followingUrl('42'), followersBody(['d'], null, false)));

    const { pks } = await source.fetchAllPks();

    expect(pks).toEqual(['d']); // the dialog path produced the census
    expect(actor.openFollowingCalls).toBe(1);
  });
});

// --- Facts stream (docs/PRINCIPLES.md §1): partial walks still enrich -----------------

test('every parsed row reconciles the we-follow edge IMMEDIATELY — a stopped walk keeps what it saw', async () => {
  const tab = new FakeTab();
  const actor = new FakeActor();
  const pageReader = new FollowersPageReader({ tab, reader, actor, clock, scrollWaitMs: 1 });
  actor.onOpen = () =>
    tab.emit(mkResp(followingUrl('42'), followersBody(['a', 'b'], 'C1', true)));

  store.setOwnPk('me-pk');
  const source = new AdapterBackedOwnFollowingSource({
    pageReader,
    ownUsername: 'me',
    sentinel: new FakeSentinel() as unknown as Sentinel,
    store,
    ownPk: 'me-pk',
    cfg: { maxRounds: 5, noNewStop: 2 },
  });

  // Immediate stop: only the on-open page lands; the walk is INCOMPLETE.
  const res = await source.fetchAllPks({ shouldStop: () => true });
  expect(res.complete).toBe(false);

  // The knowledge already paid for is in the graph anyway: accounts AND edges.
  for (const pk of ['a', 'b']) {
    expect(store.getAccount(pk)?.username).toBe(`u${pk}`);
    expect(store.getEdge('me-pk', pk, 'follows')?.status).toBe('active');
  }
});

test('a following row for a still-QUEUED candidate heals the drift on sight (external)', async () => {
  const tab = new FakeTab();
  const actor = new FakeActor();
  const pageReader = new FollowersPageReader({ tab, reader, actor, clock, scrollWaitMs: 1 });
  actor.onOpen = () =>
    tab.emit(mkResp(followingUrl('42'), followersBody(['q'], null, false)));

  store.setOwnPk('me-pk');
  // A queued candidate we ALREADY follow (externally) — the row must drop it.
  store.upsertFollowRecord({ accountPk: 'q', targetPk: null, state: 'queued', retryCount: 0 });

  const source = new AdapterBackedOwnFollowingSource({
    pageReader,
    ownUsername: 'me',
    sentinel: new FakeSentinel() as unknown as Sentinel,
    store,
    ownPk: 'me-pk',
    cfg: { maxRounds: 5, noNewStop: 2 },
  });
  await source.fetchAllPks({ shouldStop: () => true });

  expect(store.getFollowRecord('q')!.state).toBe('external');
});

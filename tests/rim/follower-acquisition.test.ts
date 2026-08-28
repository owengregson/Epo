import { AdapterBackedAcquisition } from '@/rim/follower-acquisition';
import { FollowersPageReader } from '@/rim/followers-page-reader';
import { ListPageWalker } from '@/rim/list-page-walker';
import { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import { KnowledgeStore } from '@/store/knowledge-store';
import { FakeClock } from '@/governors/clock';
import { FakeTab, FakeSentinel, FakeActor, followersUrl, followersBody, mkResp } from './fakes';

const reader = new Reader();
const clock = new FakeClock(2_000_000);

let store: KnowledgeStore;
beforeEach(() => {
  store = new KnowledgeStore(':memory:');
});
afterEach(() => store.close());

/** 2xx JSON FetchEnvelope (what the in-page fetch scripts resolve to). */
const okEnv = (body: unknown): unknown => ({
  ok: true,
  status: 200,
  contentType: 'application/json',
  json: body,
});

/** A web_profile_info body carrying the target's own pk + counts. */
const profileBody = (pk: string, username: string): unknown => ({
  data: {
    user: {
      id: pk,
      username,
      edge_followed_by: { count: 500 },
      edge_follow: { count: 480 },
      edge_mutual_followed_by: { count: 4 },
      is_private: false,
      is_verified: false,
    },
  },
});

describe('direct API walk (the request-efficient path)', () => {
  test('resolves pk via one profile fetch, pages the API directly, writes edges + cursor', async () => {
    const tab = new FakeTab();
    tab.onEvaluate = (script) => {
      if (script.includes('web_profile_info')) return okEnv(profileBody('999', 'target'));
      // Two followers pages, then the API says the list is done. The built
      // script embeds the cursor as encodeURIComponent("C1"), so match on "C1".
      if (script.includes('"C1"')) return okEnv(followersBody(['c', 'd'], null, false));
      return okEnv(followersBody(['a', 'b'], 'C1', true));
    };
    const walker = new ListPageWalker({ tab, reader, clock, sleep: async () => {}, rng: () => 0.5 });
    const pageReader = new FollowersPageReader({ tab, reader, actor: new FakeActor(), clock, scrollWaitMs: 1 });
    const acquisition = new AdapterBackedAcquisition({
      pageReader,
      store,
      sentinel: new FakeSentinel() as unknown as Sentinel,
      walker,
      tab,
      reader,
      clock,
    });

    const result = await acquisition.acquire('target');

    expect(result.targetPk).toBe('999');
    expect(result.observed).toBe(4);
    // The list's end was VERIFIED — a genuine completion reason.
    expect(result.endReason).toBe('no-more-pages');
    for (const pk of ['a', 'b', 'c', 'd']) {
      const edge = store.getEdge(pk, '999', 'follows');
      expect(edge).not.toBeNull();
      expect(edge!.status).toBe('active');
    }
    // The target's own counts were enriched for free by the resolve fetch.
    expect(store.getAccount('999')!.followers).toBe(500);
    expect(store.getAccount('999')!.mutuals).toBe(4);
    // A completed list leaves no resume cursor.
    expect(store.getScrapeCursor('999')).toBeNull();
  });

  test('resumes from the persisted cursor instead of re-paging from the head', async () => {
    store.observe({ accountPk: '999', observedAt: 1_000, source: 'profile', fields: { username: 'target' } });
    store.setScrapeCursor('999', 'C1', 1_000);

    const tab = new FakeTab();
    const seenUrls: string[] = [];
    tab.onEvaluate = (script) => {
      seenUrls.push(script);
      // The walk must START at C1; that page ends the list.
      return okEnv(followersBody(['c', 'd'], null, false));
    };
    const walker = new ListPageWalker({ tab, reader, clock, sleep: async () => {}, rng: () => 0.5 });
    const pageReader = new FollowersPageReader({ tab, reader, actor: new FakeActor(), clock, scrollWaitMs: 1 });
    const acquisition = new AdapterBackedAcquisition({
      pageReader,
      store,
      sentinel: new FakeSentinel() as unknown as Sentinel,
      walker,
      tab,
      reader,
      clock,
    });

    const result = await acquisition.acquire('target');

    expect(result.targetPk).toBe('999');
    // No profile-info fetch (pk was already known) — only list-page scripts.
    expect(seenUrls.every((s) => !s.includes('web_profile_info'))).toBe(true);
    // The first (and only) fetched page carried the resume cursor (embedded as
    // encodeURIComponent("C1")).
    expect(seenUrls[0]).toContain('max_id');
    expect(seenUrls[0]).toContain('"C1"');
    expect(result.observed).toBe(2);
  });

  test('stops early once the pk target is reached (demand-driven, not a census)', async () => {
    store.observe({ accountPk: '999', observedAt: 1_000, source: 'profile', fields: { username: 'target' } });

    const tab = new FakeTab();
    let page = 0;
    tab.onEvaluate = () => {
      // Each page yields 2 fresh pks and always claims more pages exist.
      const base = page * 2;
      page += 1;
      return okEnv(followersBody([`p${base}`, `p${base + 1}`], `C${page}`, true));
    };
    const walker = new ListPageWalker({ tab, reader, clock, sleep: async () => {}, rng: () => 0.5 });
    const pageReader = new FollowersPageReader({ tab, reader, actor: new FakeActor(), clock, scrollWaitMs: 1 });
    const acquisition = new AdapterBackedAcquisition({
      pageReader,
      store,
      sentinel: new FakeSentinel() as unknown as Sentinel,
      walker,
      tab,
      reader,
      clock,
      cfg: { targetNewPks: 5, maxPages: 100, maxCoverageFraction: 0.5, maxRounds: 5, noNewStop: 2 },
    });

    const result = await acquisition.acquire('target');

    // Stops at the first page that pushes the observed set to >= 5 (3 pages = 6).
    expect(result.observed).toBe(6);
    expect(result.endReason).toBe('target-reached');
    expect(page).toBe(3);
    // A partial walk persists a real resume cursor for the next refill.
    expect(store.getScrapeCursor('999')).toBe('C3');
  });

  test('caps coverage at maxCoverageFraction of the target audience, then stops', async () => {
    // Target has 20 followers; 50 % cap = 10. We already observed 8 of them.
    store.observe({
      accountPk: '999',
      observedAt: 1_000,
      source: 'profile',
      fields: { username: 'target', followers: 20, following: 20 },
    });
    for (let i = 0; i < 8; i++) store.observeEdge(`old${i}`, '999', 'follows', true, 1_000);

    const tab = new FakeTab();
    let page = 0;
    tab.onEvaluate = () => {
      const base = page * 2;
      page += 1;
      return okEnv(followersBody([`n${base}`, `n${base + 1}`], `K${page}`, true));
    };
    const walker = new ListPageWalker({ tab, reader, clock, sleep: async () => {}, rng: () => 0.5 });
    const pageReader = new FollowersPageReader({ tab, reader, actor: new FakeActor(), clock, scrollWaitMs: 1 });
    const acquisition = new AdapterBackedAcquisition({
      pageReader,
      store,
      sentinel: new FakeSentinel() as unknown as Sentinel,
      walker,
      tab,
      reader,
      clock,
      cfg: { targetNewPks: 250, maxPages: 100, maxCoverageFraction: 0.5, maxRounds: 5, noNewStop: 2 },
    });

    // Budget = cap(10) − observed(8) = 2 new pks → one page of 2, then stop.
    const first = await acquisition.acquire('target');
    expect(first.observed).toBe(2);
    expect(page).toBe(1);

    // Now at 10 observed = the cap. A second acquire scrapes NOTHING more and
    // yields the target so the engine's exhaustion path advances the chain —
    // a GENUINE completion reason, distinguishable from a failed read.
    const second = await acquisition.acquire('target');
    expect(second).toEqual({ observed: 0, targetPk: '999', endReason: 'coverage-cap' });
    expect(page).toBe(1); // no further API pages fetched
  });

  test('a SHAPE-MISMATCH walk is a FAILURE — no dialog fallback, no fabricated exhaustion', async () => {
    store.observe({ accountPk: '999', observedAt: 1_000, source: 'profile', fields: { username: 'target' } });

    const tab = new FakeTab();
    let calls = 0;
    tab.onEvaluate = () => {
      calls += 1;
      // First page parses; the second no longer matches the extractor (drift).
      if (calls === 1) return okEnv(followersBody(['a', 'b'], 'C1', true));
      return okEnv({ unexpected_new_shape: true });
    };
    const walker = new ListPageWalker({ tab, reader, clock, sleep: async () => {}, rng: () => 0.5 });
    const actor = new FakeActor();
    const pageReader = new FollowersPageReader({ tab, reader, actor, clock, scrollWaitMs: 1 });
    const acquisition = new AdapterBackedAcquisition({
      pageReader,
      store,
      sentinel: new FakeSentinel() as unknown as Sentinel,
      walker,
      tab,
      reader,
      clock,
    });

    const result = await acquisition.acquire('target');

    // Rows before the drift are kept; the end reason is the failure it is.
    expect(result).toEqual({ observed: 2, targetPk: '999', endReason: 'shape-mismatch' });
    // The dialog fallback was NOT attempted — it parses through the same
    // drifted extractor and would only fabricate a second empty read.
    expect(actor.openCalls).toBe(0);
    // The resume cursor points at the last well-formed page for a fixed adapter.
    expect(store.getScrapeCursor('999')).toBe('C1');
  });

  test('a mid-walk sentinel trip surfaces as sentinel-blocked, not a completion', async () => {
    store.observe({ accountPk: '999', observedAt: 1_000, source: 'profile', fields: { username: 'target' } });

    const tab = new FakeTab();
    tab.onEvaluate = () => okEnv(followersBody(['a', 'b'], 'C1', true));
    const walker = new ListPageWalker({ tab, reader, clock, sleep: async () => {}, rng: () => 0.5 });
    const pageReader = new FollowersPageReader({ tab, reader, actor: new FakeActor(), clock, scrollWaitMs: 1 });
    const acquisition = new AdapterBackedAcquisition({
      pageReader,
      store,
      // Pre-check ok, page 1 ok, page 2's top-of-page check trips.
      sentinel: new FakeSentinel(['ok', 'ok', 'challenge']) as unknown as Sentinel,
      walker,
      tab,
      reader,
      clock,
    });

    const result = await acquisition.acquire('target');

    expect(result.observed).toBe(2); // the page already fetched is kept
    expect(result.endReason).toBe('sentinel-blocked');
  });

  test('fetch-failed walk + failing dialog fallback = dialog-failed, never observed:0-as-done', async () => {
    store.observe({ accountPk: '999', observedAt: 1_000, source: 'profile', fields: { username: 'target' } });

    const tab = new FakeTab();
    tab.onEvaluate = () => ({ ok: false, status: 429, contentType: 'text/html', textHead: 'wall' });
    const walker = new ListPageWalker({ tab, reader, clock, sleep: async () => {}, rng: () => 0.5 });
    const actor = new FakeActor();
    actor.onOpen = () => {
      throw new Error('followers stat control not found');
    };
    const pageReader = new FollowersPageReader({
      tab,
      reader,
      actor,
      clock,
      scrollWaitMs: 1,
      sleep: async () => {},
    });
    const acquisition = new AdapterBackedAcquisition({
      pageReader,
      store,
      sentinel: new FakeSentinel() as unknown as Sentinel,
      walker,
      tab,
      reader,
      clock,
    });

    const result = await acquisition.acquire('target');

    // The old behavior returned {observed: 0} shaped exactly like genuine
    // exhaustion; the failure must now be visible to the caller.
    expect(result.observed).toBe(0);
    expect(result.endReason).toBe('dialog-failed');
  });
});

describe('dialog-scroll fallback', () => {
  test('used when no walker is wired; back-fills edges + persists cursor', async () => {
    const tab = new FakeTab();
    const actor = new FakeActor();
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
      sentinel: new FakeSentinel() as unknown as Sentinel,
      clock,
      cfg: { targetNewPks: 60, maxPages: 8, maxCoverageFraction: 0.5, maxRounds: 5, noNewStop: 2 },
    });

    const result = await acquisition.acquire('target');

    expect(result.observed).toBe(4);
    expect(result.targetPk).toBe('999');
    // The dialog stopped yielding new rows — its natural drain, a genuine
    // outcome (the last page still carried a cursor, so never 'no-more-pages').
    expect(result.endReason).toBe('stagnant');
    for (const pk of ['a', 'b', 'c', 'd']) {
      const edge = store.getEdge(pk, '999', 'follows');
      expect(edge).not.toBeNull();
      expect(edge!.status).toBe('active');
    }
    expect(store.getScrapeCursor('999')).toBe('C2');
  });
});

test('bails without scraping when the sentinel is blocked', async () => {
  const tab = new FakeTab();
  const actor = new FakeActor();
  const pageReader = new FollowersPageReader({ tab, reader, actor, clock, scrollWaitMs: 1 });
  const acquisition = new AdapterBackedAcquisition({
    pageReader,
    store,
    sentinel: new FakeSentinel(['challenge']) as unknown as Sentinel,
    clock,
  });

  const result = await acquisition.acquire('target');
  // A blocked pre-check is a FAILURE reason — an acquire that never ran must
  // not read as "this audience yielded nothing".
  expect(result).toEqual({ observed: 0, targetPk: null, endReason: 'sentinel-blocked' });
  expect(actor.openCalls).toBe(0);
});

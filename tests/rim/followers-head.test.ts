import type { Sentinel } from '@/adapter/sentinel';
import type { Observation } from '@/adapter/surface-types';
import { type HeadFrontier, storeHeadFacts, walkFollowersHead } from '@/rim/followers-head';
import type { WalkArgs, WalkResult } from '@/rim/list-walk-types';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { setLevel } from '@/utils/logger';
import { FakeSentinel } from '../kit/fakes';
import { openTestStore } from '../kit/store';

beforeAll(() => setLevel('error'));

const T0 = 1_000_000;
const FRONTIER = 2_000_000;
const NOW = 3_000_000;

const row = (pk: string, at = NOW): Observation =>
  ({ accountPk: pk, observedAt: at, source: 'followers-list', fields: { username: `u${pk}` } });

/** A scripted list walker over fixed pages: the hooks the head walk uses, the real stop reasons. */
function scriptedWalker(pages: readonly (readonly string[])[], fail?: { atPage: number; reason: string }) {
  const calls: WalkArgs[] = [];
  return {
    calls,
    walkAll: async (args: WalkArgs): Promise<WalkResult> => {
      calls.push(args);
      const pks: string[] = [];
      const max = args.maxPages ?? 200;
      let n = 0;
      let reason = 'max-pages';
      for (; n < Math.min(max, pages.length); n++) {
        if (fail?.atPage === n) { reason = fail.reason; break; }
        const page = pages[n].map((pk) => row(pk));
        for (const obs of page) { pks.push(obs.accountPk); args.onObservation(obs, null); }
        if (args.stopAfterPage?.(page) === true) { reason = 'caller-stop'; n += 1; break; }
        if (n === pages.length - 1) { reason = 'no-more-pages'; n += 1; break; }
      }
      return { pks, pages: n, complete: reason === 'no-more-pages', endConfirmed: false, quarantined: 0, reason, cursor: null };
    },
  };
}

function setup(): KnowledgeStore {
  const store = openTestStore(':memory:');
  store.setOwnPk('ME');
  store.ensureFollowersBaseline(T0);
  // Followers before the frontier, and one an event dated exactly.
  for (const pk of ['o1', 'o2', 'o3', 'o4']) store.observeEdge(pk, 'ME', 'follows', true, FRONTIER - 10);
  return store;
}

const args = (o: Partial<Parameters<typeof walkFollowersHead>[1]> = {}): Parameters<typeof walkFollowersHead>[1] => ({
  ownPk: 'ME', frontierAt: FRONTIER, floor: T0, maxPages: 5, use: 'check', prior: null,
  signal: new AbortController().signal, ...o,
});
const deps = (store: KnowledgeStore, walker: ReturnType<typeof scriptedWalker>) => ({
  walker, facts: storeHeadFacts(store, 'ME'), clock: { now: () => NOW }, sentinel: new FakeSentinel() as unknown as Sentinel,
});

describe('L10: the followers head', () => {
  test('stops after the page where the frontier run is found, writing every new row with the conservative interval', async () => {
    const store = setup();
    const walker = scriptedWalker([['n1', 'n2', 'o1', 'o2', 'o3'], ['o4']]);
    const res = await walkFollowersHead(deps(store, walker), args());
    expect(res).toMatchObject({ outcome: 'reached-frontier', pages: 1, newRows: 2 });
    expect(res.next).toMatchObject({ walkedAt: NOW, contiguous: true });
    const gain = store.growth.latestGain('n1');
    expect(gain).toMatchObject({ source: 'head-walk', lo: T0, hi: NOW });
    expect(walker.calls[0]).toMatchObject({ which: 'followers', readUse: 'check', maxPages: 5 });
    store.close();
  });

  test('a head walk never removes an edge, and an unread follower stays a follower', async () => {
    const store = setup();
    await walkFollowersHead(deps(store, scriptedWalker([['n1', 'o1', 'o2']])), args());
    for (const pk of ['o1', 'o2', 'o3', 'o4']) expect(store.getEdge(pk, 'ME', 'follows')?.status).toBe('active');
    store.close();
  });

  test('past the page bound the walk records a gap and the frontier moves to the walk', async () => {
    const store = setup();
    const res = await walkFollowersHead(deps(store, scriptedWalker([['a', 'b'], ['c', 'd'], ['e', 'f']])), args({ maxPages: 2 }));
    expect(res).toMatchObject({ outcome: 'gap', pages: 2, newRows: 4 });
    expect(res.next).toMatchObject({ walkedAt: NOW, contiguous: false });
    store.close();
  });

  test('without a frontier (the upgrade launch) one page initializes it', async () => {
    const store = setup();
    const walker = scriptedWalker([['n1', 'o1', 'o2'], ['o3'], ['o4']]);
    const res = await walkFollowersHead(deps(store, walker), args({ frontierAt: null }));
    expect(res).toMatchObject({ outcome: 'initialized', pages: 1 });
    expect(walker.calls[0].maxPages).toBe(1);
    store.close();
  });

  test('a list that ends before any run is contiguous: every follower was read', async () => {
    const store = setup();
    expect((await walkFollowersHead(deps(store, scriptedWalker([['n1', 'o1']])), args())).outcome).toBe('reached-frontier');
    store.close();
  });

  test('a walk that read no page sets no frontier, not even on the upgrade launch (never fabricate)', async () => {
    const store = setup();
    // The walker's page bound counts a failed fetch: one attempt, no page, 'max-pages'.
    const empty = { calls: [] as WalkArgs[], walkAll: async (): Promise<WalkResult> =>
      ({ pks: [], pages: 0, complete: false, endConfirmed: false, quarantined: 0, reason: 'max-pages', cursor: null }) };
    for (const frontierAt of [null, FRONTIER]) {
      const res = await walkFollowersHead({ ...deps(store, scriptedWalker([])), walker: empty }, args({ frontierAt }));
      expect(res).toMatchObject({ outcome: 'fetch-failed', pages: 0, next: null });
    }
    store.close();
  });

  test('a failed walk keeps every fact it wrote and returns no frontier', async () => {
    const store = setup();
    const res = await walkFollowersHead(deps(store, scriptedWalker([['n1', 'n2'], ['n3']], { atPage: 1, reason: 'read-budget' })), args());
    expect(res).toMatchObject({ outcome: 'read-budget', next: null, newRows: 2 });
    expect(store.getEdge('n2', 'ME', 'follows')?.status).toBe('active');
    store.close();
  });
});

describe('dating waits for the frontier and the order self-check', () => {
  const verified: HeadFrontier = { walkedAt: FRONTIER, rowsPerPage: 12, contiguous: true,
    order: { verdict: 'newest-first', pairs: 60, ordered: 60, at: FRONTIER } };

  function datedStore(): KnowledgeStore {
    const store = setup();
    store.observeOwnFollowerEvent('x9', 'ME', NOW - 100, 'feed');
    store.observeOwnFollowerEvent('x5', 'ME', NOW - 500, 'feed');
    return store;
  }

  test('newest-first: a new gain narrows between its exact-dated neighbours', async () => {
    const store = datedStore();
    await walkFollowersHead(deps(store, scriptedWalker([['x9', 'n1', 'x5', 'o1', 'o2']])), args({ prior: verified }));
    expect(store.growth.latestGain('n1')).toMatchObject({ lo: NOW - 500, hi: NOW - 100 });
    store.close();
  });

  test('an unverified order keeps the conservative interval', async () => {
    const store = datedStore();
    await walkFollowersHead(deps(store, scriptedWalker([['x9', 'n1', 'x5', 'o1', 'o2']])), args());
    expect(store.growth.latestGain('n1')).toMatchObject({ lo: T0, hi: NOW });
    store.close();
  });

  test('the walk measures its page size from full pages and accumulates the order pairs', async () => {
    const store = datedStore();
    const pages = [['x9', 'x5', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
      ['k', 'l', 'm', 'n', 'p', 'q', 'r', 's', 't', 'u', 'o1', 'o2']];
    const res = await walkFollowersHead(deps(store, scriptedWalker(pages)), args({ prior: { ...verified, rowsPerPage: null } }));
    expect(res.next?.rowsPerPage).toBe(12);
    expect(res.next?.order).toMatchObject({ verdict: 'newest-first', pairs: 61, ordered: 61 });
    store.close();
  });
});

import { AdapterBackedProfileEnricher } from '@/rim/profile-enricher';
import { Reader } from '@/adapter/reader';
import type { RequestBudget } from '@/governors/request-budget';
import type { Sentinel } from '@/adapter/sentinel';
import { KnowledgeStore } from '@/store/knowledge-store';
import { FakeClock } from '@/governors/clock';
import type { RimTab } from '@/rim/types';
import type { ResponseHandler, Unsubscribe } from '@/types';
import { FakeBudget, FakeSentinel } from './fakes';
import { setLevel } from '@/utils/logger';

beforeAll(() => setLevel('error'));

/** The `web_profile_info` body shape the Reader parses (data.user.*). */
const profileBody = (
  id: string,
  username: string,
  followers: number,
  following: number,
): unknown => ({
  data: {
    user: {
      id,
      username,
      edge_followed_by: { count: followers },
      edge_follow: { count: following },
      is_private: false,
      is_verified: false,
    },
  },
});

/**
 * A fake port-tab whose `evaluate` returns a scripted `web_profile_info` body
 * chosen by matching the username the enricher embedded in the fetch script.
 */
class EnrichTab implements RimTab {
  evalCalls: string[] = [];
  bodies: Record<string, unknown> = {};
  throwFor = new Set<string>();
  url = 'https://www.instagram.com/';

  async goto(u: string): Promise<void> {
    this.url = u;
  }
  onResponse(_handler: ResponseHandler): Unsubscribe {
    return () => {};
  }
  currentUrl(): string {
    return this.url;
  }
  async evaluate<T>(fnOrString: string | (() => T | Promise<T>)): Promise<T> {
    const s = String(fnOrString);
    this.evalCalls.push(s);
    const user = Object.keys(this.bodies).find((u) => s.includes(JSON.stringify(u)));
    if (user !== undefined && this.throwFor.has(user)) {
      throw new Error(`fetch failed for ${user}`);
    }
    return (user !== undefined ? this.bodies[user] : undefined) as T;
  }
}

const clock = new FakeClock(5_000_000);
const noSleep = async (): Promise<void> => {};

let store: KnowledgeStore;
beforeEach(() => {
  store = new KnowledgeStore(':memory:');
});
afterEach(() => store.close());

interface Built {
  enricher: AdapterBackedProfileEnricher;
  tab: EnrichTab;
  budget: FakeBudget;
  sentinel: FakeSentinel;
}

const build = (opts?: {
  budgetAllows?: boolean;
  sentinel?: FakeSentinel;
  batchCap?: number;
}): Built => {
  const tab = new EnrichTab();
  const budget = new FakeBudget(opts?.budgetAllows ?? true);
  const sentinel = opts?.sentinel ?? new FakeSentinel();
  const enricher = new AdapterBackedProfileEnricher({
    tab,
    reader: new Reader(),
    store,
    budget: budget as unknown as RequestBudget,
    sentinel: sentinel as unknown as Sentinel,
    clock,
    batchCap: opts?.batchCap,
    sleep: noSleep,
  });
  return { enricher, tab, budget, sentinel };
};

test('enriches each username: fetches web_profile_info, parses, and store.observe writes counts', async () => {
  const { enricher, tab } = build();
  tab.bodies = {
    alice: profileBody('101', 'alice', 1200, 300),
    bob: profileBody('102', 'bob', 50, 75),
  };

  const n = await enricher.enrich(['alice', 'bob']);

  expect(n).toBe(2);
  const a = store.getAccount('101');
  expect(a?.username).toBe('alice');
  expect(a?.followers).toBe(1200);
  expect(a?.following).toBe(300);
  expect(a?.enrichment).toBe('profiled');
  expect(store.getAccount('102')?.followers).toBe(50);
});

test('the fetch script targets web_profile_info with the app-id header and encoded username', async () => {
  const { enricher, tab } = build();
  tab.bodies = { alice: profileBody('101', 'alice', 10, 10) };

  await enricher.enrich(['alice']);

  expect(tab.evalCalls).toHaveLength(1);
  const script = tab.evalCalls[0];
  expect(script).toContain('/api/v1/users/web_profile_info/?username=');
  expect(script).toContain("'x-ig-app-id': '936619743392459'");
  expect(script).toContain("credentials: 'include'");
  expect(script).toContain('encodeURIComponent("alice")');
});

test('an exhausted budget skips every username and enriches none (no fetch)', async () => {
  const { enricher, tab } = build({ budgetAllows: false });
  tab.bodies = { alice: profileBody('101', 'alice', 10, 10) };

  const n = await enricher.enrich(['alice']);

  expect(n).toBe(0);
  expect(tab.evalCalls).toEqual([]); // budget gated before any fetch
  expect(store.getAccount('101')).toBeNull();
});

test('a non-ok sentinel skips that username and returns the count of the rest', async () => {
  // First username sees a challenge (skip); the rest fall through to `ok`.
  const { enricher, tab } = build({ sentinel: new FakeSentinel(['challenge']) });
  tab.bodies = {
    alice: profileBody('101', 'alice', 10, 10),
    bob: profileBody('102', 'bob', 20, 20),
  };

  const n = await enricher.enrich(['alice', 'bob']);

  expect(n).toBe(1); // alice skipped, bob enriched
  expect(store.getAccount('101')).toBeNull();
  expect(store.getAccount('102')?.followers).toBe(20);
});

test('a malformed/unparseable body is skipped and the pass continues', async () => {
  const { enricher, tab } = build();
  tab.bodies = {
    alice: { data: { user: null } }, // no user → parseProfileInfo returns null
    bob: profileBody('102', 'bob', 20, 20),
  };

  const n = await enricher.enrich(['alice', 'bob']);

  expect(n).toBe(1);
  expect(store.getAccount('102')?.followers).toBe(20);
});

test('a fetch/evaluate rejection is logged-and-skipped, not fatal to the pass', async () => {
  const { enricher, tab } = build();
  tab.bodies = {
    alice: profileBody('101', 'alice', 10, 10),
    bob: profileBody('102', 'bob', 20, 20),
  };
  tab.throwFor.add('alice');

  const n = await enricher.enrich(['alice', 'bob']);

  expect(n).toBe(1); // alice threw, bob still enriched
  expect(store.getAccount('101')).toBeNull();
  expect(store.getAccount('102')?.followers).toBe(20);
});

test('respects batchCap: only the first N usernames are attempted', async () => {
  const { enricher, tab } = build({ batchCap: 1 });
  tab.bodies = {
    alice: profileBody('101', 'alice', 10, 10),
    bob: profileBody('102', 'bob', 20, 20),
  };

  const n = await enricher.enrich(['alice', 'bob']);

  expect(n).toBe(1);
  expect(tab.evalCalls).toHaveLength(1);
  expect(store.getAccount('102')).toBeNull();
});

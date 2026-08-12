import { Actor, type AdapterTab } from '@/adapter/actor';
import { Sentinel, type SentinelTab } from '@/adapter/sentinel';
import { AdapterStaleError } from '@/adapter/errors';
import { SELECTORS, SCROLL_CONTAINER_HEURISTIC } from '@/adapter/field-notes';

/**
 * A fake tab whose `evaluate` returns a canned value (default: null, i.e. the
 * "selector not found" / empty result). No real browser is involved — DOM
 * interaction itself is validated live in Task 9. These tests only prove the
 * health-checks fail LOUD (AdapterStaleError, correct component) when the tab
 * reports nothing, and that the Sentinel maps signatures to the right labels.
 */
class FakeTab implements AdapterTab, SentinelTab {
  evaluateReturn: unknown;
  urlReturn: string;
  gotoCalls: string[] = [];

  constructor(opts: { evaluateReturn?: unknown; urlReturn?: string } = {}) {
    this.evaluateReturn = opts.evaluateReturn ?? null;
    this.urlReturn = opts.urlReturn ?? 'https://www.instagram.com/';
  }

  async goto(url: string): Promise<void> {
    this.gotoCalls.push(url);
  }

  async evaluate<T>(): Promise<T> {
    return this.evaluateReturn as T;
  }

  currentUrl(): string {
    return this.urlReturn;
  }
}

/** Run a promise expected to reject and return the thrown value. */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected promise to reject but it resolved');
}

// Tiny poll bounds so any wait loop resolves immediately in tests.
const fastActor = (tab: AdapterTab): Actor =>
  new Actor(tab, { pollIntervalMs: 0, pollTimeoutMs: 0 });

describe('Actor health-checks throw AdapterStaleError on absent selectors', () => {
  test('follow: missing header button -> actor.follow / profileActionButtonRole', async () => {
    const tab = new FakeTab();
    const err = await rejection(fastActor(tab).follow('someone'));
    expect(err).toBeInstanceOf(AdapterStaleError);
    expect((err as AdapterStaleError).component).toBe('actor.follow');
    expect((err as AdapterStaleError).selector).toBe(SELECTORS.profileActionButtonRole);
    // It navigated to the profile before probing.
    expect(tab.gotoCalls).toContain('https://www.instagram.com/someone/');
  });

  test('unfollow: missing header button -> actor.unfollow / profileActionButtonRole', async () => {
    const tab = new FakeTab();
    const err = await rejection(fastActor(tab).unfollow('someone'));
    expect(err).toBeInstanceOf(AdapterStaleError);
    expect((err as AdapterStaleError).component).toBe('actor.unfollow');
    expect((err as AdapterStaleError).selector).toBe(SELECTORS.profileActionButtonRole);
  });

  test('unfollow: confirm control never appears -> actor.unfollow', async () => {
    // Button found & Following clicked (needsConfirm), but confirm never shows.
    const tab = new FakeTab({
      evaluateReturn: { found: true, state: 'following', clicked: true, needsConfirm: true },
    });
    // The confirm probe reuses the same canned return which lacks `confirmed`.
    const err = await rejection(fastActor(tab).unfollow('someone'));
    expect(err).toBeInstanceOf(AdapterStaleError);
    expect((err as AdapterStaleError).component).toBe('actor.unfollow');
    expect((err as AdapterStaleError).selector).toBe(String(SELECTORS.unfollowConfirmText));
  });

  test('openFollowersDialog: link/dialog absent -> actor.openFollowersDialog', async () => {
    const tab = new FakeTab();
    const err = await rejection(fastActor(tab).openFollowersDialog('target'));
    expect(err).toBeInstanceOf(AdapterStaleError);
    expect((err as AdapterStaleError).component).toBe('actor.openFollowersDialog');
  });

  test('scrollFollowers: no scroll container -> returns false (best-effort, never throws)', async () => {
    const tab = new FakeTab();
    // A small list that fits (or an un-hydrated list) has no scrollable container;
    // scrolling is best-effort, so this must resolve `false` rather than throwing —
    // throwing would abort collection and discard already-loaded followers.
    await expect(fastActor(tab).scrollFollowers()).resolves.toBe(false);
  });
});

describe('Actor tolerates an already-satisfied state (idempotent, no throw)', () => {
  test('follow: already Following resolves ok without re-clicking', async () => {
    const tab = new FakeTab({
      evaluateReturn: { found: true, state: 'following', clicked: false },
    });
    const res = await fastActor(tab).follow('someone');
    expect(res.ok).toBe(true);
  });
});

/**
 * A fake that classifies the in-page script by a stable token and returns
 * scripted values per call — enough to exercise the Actor's initial-lookup
 * retry (A1) and post-click verification (A3) without a real DOM. The find/act
 * script is tagged by `const OP =`; the state probe by `actor:probe-state`.
 */
class ScriptTab implements AdapterTab {
  gotoCalls: string[] = [];
  findCalls = 0;
  probeCalls = 0;

  constructor(
    private readonly opts: {
      find: (call: number) => unknown;
      probe?: (call: number) => unknown;
      confirm?: unknown;
    },
  ) {}

  async goto(url: string): Promise<void> {
    this.gotoCalls.push(url);
  }

  async evaluate<T>(fnOrString: string | (() => T | Promise<T>)): Promise<T> {
    const src = String(fnOrString);
    if (src.includes('actor:probe-state')) {
      const r = this.opts.probe
        ? this.opts.probe(++this.probeCalls)
        : { found: false, state: 'unknown' };
      return r as T;
    }
    if (src.includes('const OP =')) {
      return this.opts.find(++this.findCalls) as T;
    }
    if (src.includes('confirmed')) {
      return (this.opts.confirm ?? { confirmed: true }) as T;
    }
    return null as T;
  }

  currentUrl(): string {
    return 'https://www.instagram.com/';
  }
}

describe('Actor A1: initial control lookup retries through waitFor (SPA hydration)', () => {
  test('control appears late -> resolves ok without throwing (proves retry)', async () => {
    const tab = new ScriptTab({
      // Not-found on the first 3 probes, then the button appears and is clicked.
      find: (call) =>
        call <= 3 ? { found: false } : { found: true, state: 'follow', clicked: true },
      probe: () => ({ found: true, state: 'following' }),
    });
    const actor = new Actor(tab, { pollIntervalMs: 0, pollTimeoutMs: 1000 });
    const res = await actor.follow('late');
    expect(res.ok).toBe(true);
    expect(tab.findCalls).toBeGreaterThan(1); // it retried rather than probing once
  });

  test('control never appears -> throws AdapterStaleError', async () => {
    const tab = new ScriptTab({ find: () => ({ found: false }) });
    const actor = new Actor(tab, { pollIntervalMs: 0, pollTimeoutMs: 20 });
    const err = await rejection(actor.follow('never'));
    expect(err).toBeInstanceOf(AdapterStaleError);
    expect((err as AdapterStaleError).component).toBe('actor.follow');
    expect(tab.findCalls).toBeGreaterThan(1); // it polled repeatedly before giving up
  });
});

describe('Actor A2: broadened (fallback) button anchor', () => {
  /**
   * The button exists ONLY under the fallback selector — the primary anchor
   * yields nothing. The fake reports found only when the generated script
   * embeds the fallback selector, so a Follow that succeeds proves the script
   * searches the fallback anchor.
   */
  class FallbackOnlyTab implements AdapterTab {
    gotoCalls: string[] = [];
    async goto(url: string): Promise<void> {
      this.gotoCalls.push(url);
    }
    async evaluate<T>(fnOrString: string | (() => T | Promise<T>)): Promise<T> {
      const src = String(fnOrString);
      // The fallback selector is JSON-embedded in the script (its quotes get
      // escaped), so detect it by a distinctive quote-free substring unique to
      // the fallback anchor ('main button'; the primary is 'header button').
      const hasFallback = src.includes('main button');
      if (src.includes('const OP =')) {
        return (hasFallback ? { found: true, state: 'follow', clicked: true } : { found: false }) as T;
      }
      if (src.includes('actor:probe-state')) {
        return (hasFallback ? { found: true, state: 'following' } : { found: false, state: 'unknown' }) as T;
      }
      return null as T;
    }
    currentUrl(): string {
      return 'https://www.instagram.com/';
    }
  }

  test('match only under the fallback selector -> follow succeeds', async () => {
    const tab = new FallbackOnlyTab();
    const res = await new Actor(tab, { pollIntervalMs: 0, pollTimeoutMs: 0 }).follow('someone');
    expect(res.ok).toBe(true);
  });
});

describe('Actor A3: post-click state verification', () => {
  test('post-click state never flips -> typed err (not ok, no throw)', async () => {
    const tab = new ScriptTab({
      find: () => ({ found: true, state: 'follow', clicked: true }),
      probe: () => ({ found: true, state: 'follow' }), // stays Follow: click unverified
    });
    const res = await new Actor(tab, { pollIntervalMs: 0, pollTimeoutMs: 0 }).follow('someone');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/post-click state not confirmed/);
    }
  });

  test('post-click state flips to Following -> ok', async () => {
    const tab = new ScriptTab({
      find: () => ({ found: true, state: 'follow', clicked: true }),
      probe: () => ({ found: true, state: 'following' }),
    });
    const res = await new Actor(tab, { pollIntervalMs: 0, pollTimeoutMs: 0 }).follow('someone');
    expect(res.ok).toBe(true);
  });

  test('unfollow: post-confirm state never flips to Follow -> typed err', async () => {
    const tab = new ScriptTab({
      find: () => ({ found: true, state: 'following', clicked: true, needsConfirm: true }),
      confirm: { confirmed: true },
      probe: () => ({ found: true, state: 'following' }), // stays Following: unverified
    });
    const res = await new Actor(tab, { pollIntervalMs: 0, pollTimeoutMs: 0 }).unfollow('someone');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/post-click state not confirmed/);
    }
  });
});

describe('Sentinel maps block signatures to labels', () => {
  test('challenge URL -> challenge', async () => {
    const tab = new FakeTab({ urlReturn: 'https://www.instagram.com/challenge/?next=/' });
    expect(await new Sentinel(tab).check()).toBe('challenge');
  });

  test('login redirect -> logged-out', async () => {
    const tab = new FakeTab({ urlReturn: 'https://www.instagram.com/accounts/login/?next=/' });
    expect(await new Sentinel(tab).check()).toBe('logged-out');
  });

  test('suspended URL -> challenge', async () => {
    const tab = new FakeTab({ urlReturn: 'https://www.instagram.com/accounts/suspended/' });
    expect(await new Sentinel(tab).check()).toBe('challenge');
  });

  test('"action blocked" body text -> action-blocked', async () => {
    const tab = new FakeTab({
      urlReturn: 'https://www.instagram.com/someone/',
      evaluateReturn: 'Action Blocked\nYou can try again later.',
    });
    expect(await new Sentinel(tab).check()).toBe('action-blocked');
  });

  test('clean page -> ok', async () => {
    const tab = new FakeTab({
      urlReturn: 'https://www.instagram.com/someone/',
      evaluateReturn: 'Just some normal profile content here.',
    });
    expect(await new Sentinel(tab).check()).toBe('ok');
  });
});

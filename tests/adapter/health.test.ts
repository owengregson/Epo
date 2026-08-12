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

  test('scrollFollowers: no scroll container -> actor.scrollFollowers / heuristic', async () => {
    const tab = new FakeTab();
    const err = await rejection(fastActor(tab).scrollFollowers());
    expect(err).toBeInstanceOf(AdapterStaleError);
    expect((err as AdapterStaleError).component).toBe('actor.scrollFollowers');
    expect((err as AdapterStaleError).selector).toBe(SCROLL_CONTAINER_HEURISTIC);
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

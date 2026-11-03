/**
 * Actor + Sentinel health-checks. No real browser is involved: these prove the
 * checks fail LOUD (`AdapterStaleError`, correct component) when the page
 * reports nothing, that an already-satisfied state is idempotent, and that the
 * Sentinel maps signatures to the right labels. The in-page mechanics
 * themselves are exercised against a DOM in `tests/page/**`.
 */
import { Actor, type AdapterTab } from '@/adapter/actor';
import { ActionAbortedError, ActionBlockedError, AdapterStaleError } from '@/adapter/errors';
import type { LocateActionResult, LocatedRect, LocateRectResult } from '@/adapter/ig-surface';
import { SURFACE } from '@/adapter/ig-surface';
import { Sentinel } from '@/adapter/sentinel';
import { CannedTab, FakeInteractor, pageCall, ScriptedTab } from '../kit/tabs';

const RECT: LocatedRect = { x: 300, y: 200, width: 120, height: 40 };

/** Run a promise expected to reject and return the thrown value. */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected promise to reject but it resolved');
}

/** Tiny poll bounds so any wait loop resolves immediately in tests. */
const fastActor = (tab: AdapterTab, interactor = new FakeInteractor()): Actor =>
  new Actor(tab, { pollIntervalMs: 0, pollTimeoutMs: 0, interactor });

/**
 * A tab whose scripts all answer `null` — the "control not found" shape a
 * drifted page produces. Scripted handlers registered first take precedence.
 */
const blindTab = (): ScriptedTab =>
  new ScriptedTab().on(
    () => true,
    () => null,
  );

/** A located action button in `state`, which `op` would press. */
const locatedButton = (state: LocateActionResult['state'], needsConfirm = false) =>
  (): LocateActionResult => ({ found: true, state, wouldClick: true, needsConfirm, rect: RECT });

describe('Actor health-checks throw AdapterStaleError on absent controls', () => {
  test('follow: missing header button -> actor.follow / the action-button label', async () => {
    const tab = blindTab();
    const err = await rejection(fastActor(tab).follow('someone'));
    expect(err).toBeInstanceOf(AdapterStaleError);
    expect((err as AdapterStaleError).component).toBe('actor.follow');
    expect((err as AdapterStaleError).selector).toBe(SURFACE.staleSelectorLabel('action-button'));
    // It navigated to the profile before probing.
    expect(tab.gotoCalls).toContain(SURFACE.profileUrl('someone'));
  });

  test('unfollow: missing header button -> actor.unfollow / the action-button label', async () => {
    const err = await rejection(fastActor(blindTab()).unfollow('someone'));
    expect(err).toBeInstanceOf(AdapterStaleError);
    expect((err as AdapterStaleError).component).toBe('actor.unfollow');
    expect((err as AdapterStaleError).selector).toBe(SURFACE.staleSelectorLabel('action-button'));
  });

  test('unfollow: confirm control never appears -> an honest unverified result, never a second press', async () => {
    // The button reads Following and is pressed (needsConfirm), but the confirm
    // control never shows — and the page carries no block interstitial. The
    // press was dispatched (ADR 0308), so this is no longer pre-click drift.
    const interactor = new FakeInteractor();
    const tab = new ScriptedTab()
      .on(pageCall('locateActionButton'), locatedButton('following', true))
      .on(
        () => true,
        () => null,
      );
    const res = await fastActor(tab, interactor).unfollow('someone');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/post-click state not confirmed/);
    expect(interactor.clicks).toEqual([RECT]);
  });

  test('openFollowersDialog: stat/dialog absent -> actor.openFollowersDialog', async () => {
    const err = await rejection(fastActor(blindTab()).openFollowersDialog('target'));
    expect(err).toBeInstanceOf(AdapterStaleError);
    expect((err as AdapterStaleError).component).toBe('actor.openFollowersDialog');
  });

  test('scrollFollowers: no scroll container -> false (best-effort, never throws)', async () => {
    // A small list that fits (or an un-hydrated list) has no scrollable
    // container; scrolling is best-effort, so this must resolve `false`.
    // Throwing would abort the collect and discard already-loaded followers.
    await expect(fastActor(blindTab()).scrollFollowers()).resolves.toBe(false);
  });
});

describe('Actor tolerates an already-satisfied state (idempotent, no throw)', () => {
  test('follow: already Following resolves ok without pressing anything', async () => {
    const interactor = new FakeInteractor();
    const tab = new ScriptedTab().on(
      pageCall('locateActionButton'),
      (): LocateActionResult => ({
        found: true,
        state: 'following',
        wouldClick: false,
        rect: RECT,
      }),
    );
    const res = await fastActor(tab, interactor).follow('someone');
    expect(res.ok).toBe(true);
    // No click happened — surfaced so callers can reconcile the external follow.
    if (res.ok) expect(res.value.clicked).toBe(false);
    expect(interactor.clicks).toEqual([]);
  });
});

describe('Actor A1: initial control lookup retries through waitFor (SPA hydration)', () => {
  test('control appears late -> resolves ok without throwing (proves retry)', async () => {
    let locates = 0;
    const tab = new ScriptedTab()
      .on(pageCall('locateActionButton'), (): LocateActionResult => {
        locates += 1;
        // Not-found on the first 3 probes, then the button appears.
        return locates <= 3
          ? { found: false }
          : { found: true, state: 'follow', wouldClick: true, rect: RECT };
      })
      .on(pageCall('probeActionButton'), () => ({ found: true, state: 'following' }));

    const actor = new Actor(tab, {
      pollIntervalMs: 0,
      pollTimeoutMs: 1000,
      interactor: new FakeInteractor(),
    });
    const res = await actor.follow('late');
    expect(res.ok).toBe(true);
    expect(locates).toBeGreaterThan(1); // it retried rather than probing once
  });

  test('control never appears -> throws AdapterStaleError after polling', async () => {
    const tab = blindTab();
    const actor = new Actor(tab, {
      pollIntervalMs: 0,
      pollTimeoutMs: 20,
      interactor: new FakeInteractor(),
    });
    const err = await rejection(actor.follow('never'));
    expect(err).toBeInstanceOf(AdapterStaleError);
    expect((err as AdapterStaleError).component).toBe('actor.follow');
    expect(tab.evaluated.length).toBeGreaterThan(1); // it polled before giving up
  });
});

describe('Actor A3: post-click state verification', () => {
  test('post-click state never flips -> typed err (not ok, no throw)', async () => {
    const tab = new ScriptedTab()
      .on(pageCall('locateActionButton'), locatedButton('follow'))
      // Stays Follow: the click is unverified.
      .on(pageCall('probeActionButton'), () => ({ found: true, state: 'follow' }))
      .on(
        () => true,
        () => null,
      );
    const res = await fastActor(tab).follow('someone');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/post-click state not confirmed/);
  });

  test('post-click state flips to Following -> ok', async () => {
    const tab = new ScriptedTab()
      .on(pageCall('locateActionButton'), locatedButton('follow'))
      .on(pageCall('probeActionButton'), () => ({ found: true, state: 'following' }));
    const res = await fastActor(tab).follow('someone');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.clicked).toBe(true);
  });

  test('unfollow: post-confirm state never flips to Follow -> typed err', async () => {
    const tab = new ScriptedTab()
      .on(pageCall('locateActionButton'), locatedButton('following', true))
      .on(pageCall('locateConfirm'), (): LocateRectResult & { sig: string } => ({ found: true, rect: RECT, sig: 'menu' }))
      // Stays Following: unverified.
      .on(pageCall('probeActionButton'), () => ({ found: true, state: 'following' }))
      .on(
        () => true,
        () => null,
      );
    const res = await fastActor(tab).unfollow('someone');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/post-click state not confirmed/);
  });
});

describe('Sentinel maps block signatures to labels', () => {
  test('challenge URL -> challenge', async () => {
    const tab = new CannedTab({ urlReturn: 'https://www.instagram.com/challenge/?next=/' });
    expect(await new Sentinel(tab).check()).toBe('challenge');
  });

  test('login redirect -> logged-out', async () => {
    const tab = new CannedTab({ urlReturn: 'https://www.instagram.com/accounts/login/?next=/' });
    expect(await new Sentinel(tab).check()).toBe('logged-out');
  });

  test('suspended URL -> challenge', async () => {
    const tab = new CannedTab({ urlReturn: 'https://www.instagram.com/accounts/suspended/' });
    expect(await new Sentinel(tab).check()).toBe('challenge');
  });

  test('"action blocked" body text -> action-blocked', async () => {
    const tab = new CannedTab({
      urlReturn: 'https://www.instagram.com/someone/',
      evaluateReturn: 'Action Blocked\nYou can try again later.',
    });
    expect(await new Sentinel(tab).check()).toBe('action-blocked');
  });

  test('clean page -> ok', async () => {
    const tab = new CannedTab({
      urlReturn: 'https://www.instagram.com/someone/',
      evaluateReturn: 'Just some normal profile content here.',
    });
    expect(await new Sentinel(tab).check()).toBe('ok');
  });
});

describe('Actor — cancellable waits (driver abort signal)', () => {
  test('waitFor aborts mid-poll when the provided signal fires', async () => {
    const ac = new AbortController();
    // Never satisfies `done`; the first evaluate schedules the abort.
    const tab = new ScriptedTab().on(
      () => true,
      () => {
        if (tab.evaluated.length === 1) setTimeout(() => ac.abort(), 0);
        return { found: false };
      },
    );
    const actor = new Actor(tab, {
      pollIntervalMs: 60_000, // an un-abortable sleep would hang the test here
      pollTimeoutMs: 600_000,
      abortSignal: () => ac.signal,
      interactor: new FakeInteractor(),
    });

    const err = await rejection(actor.follow('someone'));

    // An abort is a CONTROL COMMAND, not selector drift: it must surface as
    // ActionAbortedError (callers map it to 'blocked' — record untouched),
    // never as AdapterStaleError (which burns a retry + a failed ledger row).
    expect(err).toBeInstanceOf(ActionAbortedError);
    expect(tab.evaluated.length).toBeLessThan(3); // returned mid-poll, not after the timeout
  });

  test('an already-aborted signal short-circuits before the first attempt', async () => {
    const ac = new AbortController();
    ac.abort();
    const tab = new ScriptedTab().on(pageCall('locateActionButton'), locatedButton('follow'));
    const actor = new Actor(tab, { abortSignal: () => ac.signal, interactor: new FakeInteractor() });

    await rejection(actor.follow('someone'));

    expect(tab.evaluated).toEqual([]); // stop means stop: no DOM touch at all
  });
});

describe('Actor block detection: an interstitial in place of the expected control', () => {
  /** A tab whose body-text probe reports `bodyText`; locate/probe are scripted. */
  const blockedTab = (bodyText: string): ScriptedTab =>
    new ScriptedTab().on(
      pageCall('blockText'),
      () => bodyText,
    );

  test('unfollow: missing confirm + "Try Again Later" -> ActionBlockedError, not stale', async () => {
    const tab = blockedTab('Try Again Later We restrict certain activity to protect our community.')
      .on(pageCall('locateActionButton'), locatedButton('following', true))
      .on(
        () => true,
        () => null,
      );
    const err = await rejection(fastActor(tab).unfollow('someone'));
    expect(err).toBeInstanceOf(ActionBlockedError);
    expect((err as ActionBlockedError).component).toBe('actor.unfollow');
  });

  test('unfollow: missing confirm + unrelated dialog text -> unverified, not a block (no refusal text)', async () => {
    const tab = blockedTab('Add to favorites')
      .on(pageCall('locateActionButton'), locatedButton('following', true))
      .on(
        () => true,
        () => null,
      );
    const res = await fastActor(tab).unfollow('someone');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/post-click state not confirmed/);
  });

  test('follow: verify never confirms + block dialog -> ActionBlockedError, not a failed Result', async () => {
    const tab = blockedTab('Action Blocked')
      .on(pageCall('locateActionButton'), locatedButton('follow'))
      // Never flips to following.
      .on(pageCall('probeActionButton'), () => ({ found: true, state: 'follow' }))
      .on(
        () => true,
        () => null,
      );
    const err = await rejection(fastActor(tab).follow('someone'));
    expect(err).toBeInstanceOf(ActionBlockedError);
    expect((err as ActionBlockedError).component).toBe('actor.follow');
  });
});

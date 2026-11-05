/**
 * Actor × mutation response: the network response of the follow/unfollow
 * mutation is the AUTHORITATIVE arbiter of whether an action landed. The web
 * client flips the header button optimistically and snaps it back when the
 * server refuses (rate limit: "feedback_required", no page dialog) — so the
 * DOM alone can report a phantom success, or an anonymous failure. With a
 * tab that exposes `onResponse`, the Actor arms a watch BEFORE the click and
 * lets the response decide; without one, the DOM path is unchanged.
 */
import { Actor, type ActorInteractor, type AdapterTab } from '@/adapter/actor';
import { ActionAbortedError, ActionBlockedError, ActionRateLimitedError } from '@/adapter/errors';
import type { LocateActionResult, LocatedRect, LocateRectResult } from '@/adapter/ig-surface';
import { setLevel } from '@/utils/logger';
import { FakeInteractor, NetworkTab, pageCall, ScriptedTab } from '../kit/tabs';

beforeAll(() => setLevel('error'));

const RECT: LocatedRect = { x: 300, y: 200, width: 120, height: 40 };
const CONFIRM_RECT: LocatedRect = { x: 400, y: 500, width: 200, height: 44 };
const ORIGIN = 'https://www.instagram.com';

const FOLLOW_URL = `${ORIGIN}/api/v1/web/friendships/123/follow/`;
const UNFOLLOW_URL = `${ORIGIN}/api/v1/web/friendships/123/unfollow/`;
const THROTTLED = {
  message: 'feedback_required',
  spam: true,
  feedback_title: 'Try Again Later',
  feedback_message: 'We restrict certain activity to protect our community.',
  status: 'fail',
};

/** A Follow button that reads Following from the first post-click probe (the optimistic flip). */
function scriptFollowFlow(tab: NetworkTab, after: 'follow' | 'following' = 'following'): void {
  tab.on(pageCall('locateActionButton'), (): LocateActionResult => ({
    found: true,
    state: 'follow',
    wouldClick: true,
    needsConfirm: false,
    rect: RECT,
  }));
  tab.on(pageCall('probeActionButton'), () => ({ found: true, state: after }));
  tab.on(pageCall('blockText'), () => '');
  // No confirm layer on screen: an unobserved window counts toward blindness (ADR 0308).
  tab.on(pageCall('confirmLayer'), () => ({ present: false }));
}

const build = (tab: AdapterTab, interactor: ActorInteractor, extra: object = {}): Actor =>
  new Actor(tab, {
    pollIntervalMs: 1,
    pollTimeoutMs: 5,
    mutationTimeoutMs: 40,
    interactor,
    ...extra,
  });

describe('follow — the mutation response arbitrates', () => {
  test('a throttled follow (400 feedback_required) is RATE-LIMITED even though the button flipped', async () => {
    const tab = new NetworkTab();
    const h = new FakeInteractor();
    scriptFollowFlow(tab);
    // The page: optimistic flip (probe already says Following), then the server refuses.
    h.onClick = () => tab.emit({ url: FOLLOW_URL, status: 400, body: THROTTLED });

    await expect(build(tab, h).follow('someone')).rejects.toBeInstanceOf(ActionRateLimitedError);
    expect(h.clicks).toEqual([RECT]);
    expect(tab.responseHandlers.size).toBe(0); // the watch is released
  });

  test('the rate-limit error carries the server’s own words for the log', async () => {
    const tab = new NetworkTab();
    const h = new FakeInteractor();
    scriptFollowFlow(tab);
    h.onClick = () => tab.emit({ url: FOLLOW_URL, status: 400, body: THROTTLED });

    let caught: unknown;
    try {
      await build(tab, h).follow('someone');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ActionRateLimitedError);
    const e = caught as ActionRateLimitedError;
    expect(e.component).toBe('actor.follow');
    expect(e.httpStatus).toBe(400);
    expect(e.detail).toMatch(/feedback_required/);
    expect(e.detail).toMatch(/Try Again Later/);
  });

  test('a 429 with an unreadable (HTML) body is also rate-limited', async () => {
    const tab = new NetworkTab();
    const h = new FakeInteractor();
    scriptFollowFlow(tab);
    h.onClick = () =>
      tab.emit({ url: FOLLOW_URL, status: 429, mimeType: 'text/html', body: '<!DOCTYPE html>' });

    await expect(build(tab, h).follow('someone')).rejects.toBeInstanceOf(ActionRateLimitedError);
  });

  test('a confirmed ok response is ok — even when the DOM probe lags behind', async () => {
    const tab = new NetworkTab();
    const h = new FakeInteractor();
    tab.on(pageCall('locateActionButton'), (): LocateActionResult => ({
      found: true,
      state: 'follow',
      wouldClick: true,
      needsConfirm: false,
      rect: RECT,
    }));
    // The DOM never catches up inside the (tiny) poll window.
    tab.on(pageCall('probeActionButton'), () => ({ found: true, state: 'follow' }));
    tab.on(pageCall('blockText'), () => '');
    h.onClick = () => tab.emit({ url: FOLLOW_URL, status: 200, body: { result: 'following', status: 'ok' } });

    const result = await build(tab, h).follow('someone');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.clicked).toBe(true);
  });

  test("a refused mutation (unknown 4xx message) is Instagram's refusal, never the unverified result (ADR 0308)", async () => {
    const tab = new NetworkTab();
    const h = new FakeInteractor();
    scriptFollowFlow(tab, 'follow');
    h.onClick = () =>
      tab.emit({
        url: FOLLOW_URL,
        status: 400,
        body: { status: 'fail', message: 'Sorry, this user is not available' },
      });

    const error = await build(tab, h).follow('someone').then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ActionBlockedError);
    expect((error as ActionBlockedError).matchedText).toMatch(/not available/);
  });

  test('an errors[] response is evidence too: a refusal, never the unverified result', async () => {
    const tab = new NetworkTab();
    const h = new FakeInteractor();
    scriptFollowFlow(tab, 'follow');
    h.onClick = () => tab.emit({ url: FOLLOW_URL, status: 200, body: { errors: [{ message: 'unexpected' }] } });

    await expect(build(tab, h).follow('someone')).rejects.toBeInstanceOf(ActionBlockedError);
  });

  test('no response, no refusal text and an unchanged header: the honest unverified result (an err)', async () => {
    const tab = new NetworkTab();
    const h = new FakeInteractor();
    scriptFollowFlow(tab, 'follow');

    const result = await build(tab, h).follow('someone');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/post-click state not confirmed/);
  });

  test('no mutation response inside the window → the DOM verification decides, as before', async () => {
    const tab = new NetworkTab();
    const h = new FakeInteractor();
    scriptFollowFlow(tab); // probe reads Following

    const result = await build(tab, h).follow('someone');
    expect(result.ok).toBe(true);
    expect(tab.probes).toBeGreaterThan(0);
  });

  test('an unrelated response (a read, another endpoint) never satisfies the watch', async () => {
    const tab = new NetworkTab();
    const h = new FakeInteractor();
    scriptFollowFlow(tab);
    h.onClick = () => {
      tab.emit({ url: `${ORIGIN}/api/v1/friendships/show/123/`, status: 400, body: THROTTLED });
      tab.emit({ url: UNFOLLOW_URL, status: 400, body: THROTTLED }); // the OTHER mutation
    };

    // Falls through to the DOM path (which reads Following) — no rate-limit claim.
    const result = await build(tab, h).follow('someone');
    expect(result.ok).toBe(true);
  });

  test('an already-Following button arms nothing and clicks nothing', async () => {
    const tab = new NetworkTab();
    const h = new FakeInteractor();
    tab.on(pageCall('locateActionButton'), (): LocateActionResult => ({
      found: true,
      state: 'following',
      wouldClick: false,
      needsConfirm: false,
      rect: RECT,
    }));

    const result = await build(tab, h).follow('someone');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.clicked).toBe(false);
    expect(tab.responseHandlers.size).toBe(0);
  });

  test('a stop() during the response wait surfaces as ActionAbortedError, not a timeout', async () => {
    const tab = new NetworkTab();
    const h = new FakeInteractor();
    scriptFollowFlow(tab);
    const abort = new AbortController();
    h.onClick = () => abort.abort();

    await expect(
      build(tab, h, { abortSignal: () => abort.signal, mutationTimeoutMs: 5_000 }).follow('someone'),
    ).rejects.toBeInstanceOf(ActionAbortedError);
  });

  test('a tab WITHOUT a response seam keeps the pure DOM behaviour', async () => {
    const h = new FakeInteractor();
    // A ScriptedTab carries no `onResponse`: the watch is inert and the DOM
    // verification is the only arbiter, exactly as before the seam existed.
    const plain = new ScriptedTab();
    plain.on(pageCall('locateActionButton'), (): LocateActionResult => ({
      found: true,
      state: 'follow',
      wouldClick: true,
      rect: RECT,
    }));
    plain.on(pageCall('probeActionButton'), () => ({ found: true, state: 'following' }));

    const result = await build(plain, h).follow('someone');
    expect(result.ok).toBe(true);
  });
});

describe('unfollow — the mutation response arbitrates', () => {
  class ConfirmingInteractor extends FakeInteractor {
    emitAfterConfirm: (() => void) | null = null;
  }

  function scriptUnfollowFlow(tab: NetworkTab, h: ConfirmingInteractor): void {
    tab.on(pageCall('locateActionButton'), (): LocateActionResult => ({
      found: true,
      state: 'following',
      wouldClick: true,
      needsConfirm: true,
      rect: RECT,
    }));
    tab.on(pageCall('locateConfirm'), (): LocateRectResult & { sig: string } => ({ found: true, rect: CONFIRM_RECT, sig: 'menu' }));
    // Optimistic flip: the header reads Follow right after the confirm.
    tab.on(pageCall('probeActionButton'), () => ({ found: true, state: 'follow' }));
    tab.on(pageCall('blockText'), () => '');
    tab.on(pageCall('confirmLayer'), () => ({ present: false }));
    // The mutation fires on the CONFIRM click (the second click).
    h.onClick = () => {
      if (h.clicks.length === 2) h.emitAfterConfirm?.();
    };
  }

  test('a throttled unfollow is RATE-LIMITED despite the optimistic flip', async () => {
    const tab = new NetworkTab();
    const h = new ConfirmingInteractor();
    scriptUnfollowFlow(tab, h);
    h.emitAfterConfirm = () => tab.emit({ url: UNFOLLOW_URL, status: 400, body: THROTTLED });

    await expect(build(tab, h).unfollow('someone')).rejects.toBeInstanceOf(ActionRateLimitedError);
    expect(h.clicks).toEqual([RECT, CONFIRM_RECT]);
    expect(tab.responseHandlers.size).toBe(0);
  });

  test('a confirmed ok unfollow is ok', async () => {
    const tab = new NetworkTab();
    const h = new ConfirmingInteractor();
    scriptUnfollowFlow(tab, h);
    h.emitAfterConfirm = () => tab.emit({ url: UNFOLLOW_URL, status: 200, body: { status: 'ok' } });

    const result = await build(tab, h).unfollow('someone');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.clicked).toBe(true);
  });
});

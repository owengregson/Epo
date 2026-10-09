/**
 * Actor × Interactor integration: element LOCATING stays in-page (the surface's
 * locate scripts, matched here by the page call each ends with) and every
 * click/scroll goes through the Interactor.
 */
import { Actor, type ActorInteractor } from '@/adapter/actor';
import type {
  LocateActionResult,
  LocatedRect,
  LocateRectResult,
  LocateScrollResult,
} from '@/adapter/ig-surface';
import { setLevel } from '@/utils/logger';
import { FakeInteractor, pageCall, ScriptedTab } from '../kit/tabs';

beforeAll(() => setLevel('error'));

const RECT: LocatedRect = { x: 300, y: 200, width: 120, height: 40 };

const buildActor = (tab: ScriptedTab, interactor: ActorInteractor): Actor =>
  new Actor(tab, { pollIntervalMs: 1, pollTimeoutMs: 5, interactor });

describe('follow/unfollow with a interactor', () => {
  test('follow: locate script finds the button, the Interactor clicks its rect, state verified', async () => {
    const tab = new ScriptedTab();
    const h = new FakeInteractor();
    // Locate: a Follow button that would be clicked.
    tab.on(pageCall('locateActionButton'), (): LocateActionResult => ({
      found: true,
      state: 'follow',
      wouldClick: true,
      needsConfirm: false,
      rect: RECT,
    }));
    // Post-click verification reads Following.
    tab.on(pageCall('probeActionButton'), () => ({ found: true, state: 'following' }));

    const result = await buildActor(tab, h).follow('someone');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.clicked).toBe(true);
    expect(h.clicks).toEqual([RECT]); // the interactor performed the click
    // The in-page JS CLICK script never ran: every evaluate was a locate or a
    // probe of the action-button DESCRIPTOR, nothing that presses in page.
    for (const s of tab.evaluated) {
      expect(s.includes('"control":"action-button"')).toBe(true);
      expect(s.includes('__epoPage.locate({') || s.includes('__epoPage.probe({')).toBe(true);
    }
  });

  test('follow: an already-Following button is a no-click idempotent ok', async () => {
    const tab = new ScriptedTab();
    const h = new FakeInteractor();
    tab.on(pageCall('locateActionButton'), (): LocateActionResult => ({
      found: true,
      state: 'following',
      wouldClick: false,
      needsConfirm: false,
      rect: RECT,
    }));

    const result = await buildActor(tab, h).follow('someone');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.clicked).toBe(false);
    expect(h.clicks).toEqual([]); // nothing pressed
  });

  test('unfollow: interactor clicks the button AND the confirm control', async () => {
    const tab = new ScriptedTab();
    const h = new FakeInteractor();
    const confirmRect: LocatedRect = { x: 400, y: 500, width: 200, height: 44 };
    tab.on(pageCall('locateActionButton'), (): LocateActionResult => ({
      found: true,
      state: 'following',
      wouldClick: true,
      needsConfirm: true,
      rect: RECT,
    }));
    tab.on(
      pageCall('locateConfirm'),
      (): LocateRectResult => ({ found: true, rect: confirmRect }),
    );
    tab.on(pageCall('probeActionButton'), () => ({ found: true, state: 'follow' }));

    const result = await buildActor(tab, h).unfollow('someone');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.clicked).toBe(true);
    expect(h.clicks).toEqual([RECT, confirmRect]); // button, then confirm
  });

  test('unfollow: a vanished confirm menu is REOPENED once, then the confirm clicked', async () => {
    const tab = new ScriptedTab();
    const h = new FakeInteractor();
    const confirmRect: LocatedRect = { x: 400, y: 500, width: 200, height: 44 };
    // The confirm locate misses for the whole first wait window (menu closed
    // under it), then resolves after the recovery re-click reopens the menu.
    let reopenClicks = 0;
    tab.on(pageCall('locateActionButton'), (): LocateActionResult => {
      reopenClicks += 1;
      return { found: true, state: 'following', wouldClick: true, needsConfirm: true, rect: RECT };
    });
    tab.on(
      pageCall('locateConfirm'),
      (): LocateRectResult =>
        reopenClicks >= 2 ? { found: true, rect: confirmRect } : { found: false },
    );
    tab.on(pageCall('probeActionButton'), () => ({ found: true, state: 'follow' }));
    // The stale-escalation probe (never reached here, but polled mid-recovery).
    tab.on(pageCall('blockText'), () => '');

    const result = await buildActor(tab, h).unfollow('someone');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.clicked).toBe(true);
    // Button, reopen-button, then the confirm found on the retry.
    expect(h.clicks).toEqual([RECT, RECT, confirmRect]);
  });

  test('unfollow: a fallback-located confirm (self-recovery) is clicked like a primary hit', async () => {
    const tab = new ScriptedTab();
    const h = new FakeInteractor();
    const confirmRect: LocatedRect = { x: 380, y: 510, width: 180, height: 40 };
    tab.on(pageCall('locateActionButton'), (): LocateActionResult => ({
      found: true,
      state: 'following',
      wouldClick: true,
      needsConfirm: true,
      rect: RECT,
    }));
    tab.on(
      pageCall('locateConfirm'),
      (): LocateRectResult => ({ found: true, rect: confirmRect, fallback: true }),
    );
    tab.on(pageCall('probeActionButton'), () => ({ found: true, state: 'follow' }));

    const result = await buildActor(tab, h).unfollow('someone');

    expect(result.ok).toBe(true);
    expect(h.clicks).toEqual([RECT, confirmRect]);
  });
});

describe('dialogs and scrolling with a interactor', () => {
  test('openFollowersDialog: the stat rect is interactor-clicked, then the dialog awaited', async () => {
    const tab = new ScriptedTab();
    const h = new FakeInteractor();
    tab.on(
      pageCall('locateStat', '"which":"followers"'),
      (): LocateRectResult => ({ found: true, rect: RECT }),
    );
    // The dialog-present script has no custom marker; match its source shape.
    tab.on(pageCall('dialogPresent'), () => ({ present: true }));

    await buildActor(tab, h).openFollowersDialog('target');

    expect(h.clicks).toEqual([RECT]);
  });

  test('openFollowersDialog: a click the SPA never registered is retried (re-navigate + re-click)', async () => {
    const tab = new ScriptedTab();
    const h = new FakeInteractor();
    tab.on(
      pageCall('locateStat', '"which":"followers"'),
      (): LocateRectResult => ({ found: true, rect: RECT }),
    );
    // Attempt 1's click never lands (dialog stays absent through the poll);
    // attempt 2's click works — the dialog appears once a second click happened.
    tab.on(pageCall('dialogPresent'), () => ({ present: h.clicks.length >= 2 }));

    await buildActor(tab, h).openFollowersDialog('target');

    expect(h.clicks).toEqual([RECT, RECT]); // one click per attempt
  });

  test('openFollowersDialog: both attempts without a dialog throw AdapterStaleError', async () => {
    const tab = new ScriptedTab();
    const h = new FakeInteractor();
    tab.on(
      pageCall('locateStat', '"which":"followers"'),
      (): LocateRectResult => ({ found: true, rect: RECT }),
    );
    tab.on(pageCall('dialogPresent'), () => ({ present: false }));

    await expect(buildActor(tab, h).openFollowersDialog('target')).rejects.toThrow(
      /dialog/,
    );
    expect(h.clicks).toEqual([RECT, RECT]); // it did retry before giving up
  });

  test('scrollFollowers: remaining distance is interactor-scrolled, capped at 3 viewports', async () => {
    const tab = new ScriptedTab();
    const h = new FakeInteractor();
    tab.on(pageCall('locateScrollContainer'), (): LocateScrollResult => ({
      found: true,
      rect: { x: 100, y: 100, width: 400, height: 600 },
      scrollTop: 0,
      scrollHeight: 5000,
      clientHeight: 600,
    }));

    const scrolled = await buildActor(tab, h).scrollFollowers();

    expect(scrolled).toBe(true);
    expect(h.scrolls).toHaveLength(1);
    expect(h.scrolls[0].deltaPx).toBe(1800); // min(4400 remaining, 3 × 600 viewport)
  });

  test('scrollFollowers: the hover-safe rest point is forwarded to the interactor', async () => {
    const tab = new ScriptedTab();
    const h = new FakeInteractor();
    tab.on(pageCall('locateScrollContainer'), (): LocateScrollResult => ({
      found: true,
      rect: { x: 100, y: 100, width: 400, height: 600 },
      scrollTop: 0,
      scrollHeight: 5000,
      clientHeight: 600,
      safePoint: { x: 108, y: 400 },
    }));

    await buildActor(tab, h).scrollFollowers();

    expect(h.scrolls[0].restPoint).toEqual({ x: 108, y: 400 }); // wheels off the hover triggers
  });

  test('scrollFollowers: an already-bottomed container reports false, no scroll', async () => {
    const tab = new ScriptedTab();
    const h = new FakeInteractor();
    tab.on(pageCall('locateScrollContainer'), (): LocateScrollResult => ({
      found: true,
      rect: { x: 100, y: 100, width: 400, height: 600 },
      scrollTop: 4400,
      scrollHeight: 5000,
      clientHeight: 600,
    }));

    expect(await buildActor(tab, h).scrollFollowers()).toBe(false);
    expect(h.scrolls).toEqual([]);
  });

  test('scrollFollowers: a missing container reports false (list fits — nothing to scroll)', async () => {
    const tab = new ScriptedTab();
    const h = new FakeInteractor();
    tab.on(pageCall('locateScrollContainer'), (): LocateScrollResult => ({ found: false }));

    expect(await buildActor(tab, h).scrollFollowers()).toBe(false);
    expect(h.scrolls).toEqual([]);
  });

  test('clickOwnProfileLink: the nav avatar rect is Interactor-clicked (no JS click)', async () => {
    const tab = new ScriptedTab();
    const h = new FakeInteractor();
    tab.on(
      pageCall('locateProfileLink'),
      (): LocateRectResult => ({ found: true, rect: RECT }),
    );

    expect(await buildActor(tab, h).clickOwnProfileLink()).toBe(true);
    expect(h.clicks).toEqual([RECT]);
    // Only the LOCATE ran — the `profile-link-click` escape control (the
    // identity resolver's in-page a.click(), ADR 0305) never did.
    for (const s of tab.evaluated) {
      expect(s.includes('"control":"profile-link"')).toBe(true);
      expect(s.includes('"control":"profile-link-click"')).toBe(false);
    }
  });

  test('clickOwnProfileLink: link not hydrated yet reports false, nothing pressed', async () => {
    const tab = new ScriptedTab();
    const h = new FakeInteractor();
    tab.on(pageCall('locateProfileLink'), (): LocateRectResult => ({ found: false }));

    expect(await buildActor(tab, h).clickOwnProfileLink()).toBe(false);
    expect(h.clicks).toEqual([]);
  });
});

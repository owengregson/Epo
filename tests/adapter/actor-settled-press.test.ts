/**
 * Settle-then-press for hover-reactive chrome.
 *
 * Live 2026-10-08: Instagram's nav rail is a collapsed icon rail that
 * RE-RENDERS its nodes as the cursor arrives (the notifications control went
 * from a 48×56 link to a 214×16.5 one, and the node located before travel was
 * disconnected), and drawer controls scale on hover (the close X 16 → 16.8 px).
 * A rect located before the cursor travelled is no longer what is under it, so
 * the click guard refused every rail press — the drawer never opened and
 * follow-back detection went blind.
 *
 * The contract pinned here: for rail and drawer controls the Actor rests the
 * cursor on the control FIRST, locates it AGAIN, and presses the SETTLED rect.
 */
import { Actor } from '@/adapter/actor';
import type { LocateConfirmRequestResult, LocatedRect, LocateRectResult } from '@/adapter/ig-surface';
import { setLevel } from '@/utils/logger';
import { FakeInteractor, marker, pageCall, ScriptedTab } from '../kit/tabs';

beforeAll(() => setLevel('error'));

/** The collapsed rail item, and the same control once the rail has expanded. */
const COLLAPSED: LocatedRect = { x: 12, y: 410.5, width: 48, height: 56 };
const EXPANDED: LocatedRect = { x: 12, y: 437, width: 214, height: 16.5 };

const build = (tab: ScriptedTab, h: FakeInteractor): Actor =>
  new Actor(tab, { pollIntervalMs: 1, pollTimeoutMs: 5, interactor: h });

/** A control whose locate answers COLLAPSED until the cursor has hovered, then EXPANDED. */
function reactive(tab: ScriptedTab, h: FakeInteractor, control: string): void {
  tab.on(marker(`"control":"${control}"`), (): LocateRectResult => ({
    found: true,
    rect: h.hovers.length === 0 ? COLLAPSED : EXPANDED,
  }));
}

describe('rail and drawer controls: hover, locate again, press the settled rect', () => {
  const cases: Array<[string, string, (a: Actor) => Promise<boolean>]> = [
    ['clickNotifications', 'notifications-link', (a) => a.clickNotifications()],
    ['clickOwnProfileLink', 'profile-link', (a) => a.clickOwnProfileLink()],
    ['clickNotificationsFollowsFilter', 'notifications-follows-filter', (a) => a.clickNotificationsFollowsFilter()],
    ['clickNotificationsClose', 'drawer-close', (a) => a.clickNotificationsClose()],
    ['clickFollowRequestsEntry', 'follow-requests-entry', (a) => a.clickFollowRequestsEntry()],
  ];

  test.each(cases)('%s presses the rect located AFTER the hover', async (_name, control, act) => {
    const tab = new ScriptedTab();
    const h = new FakeInteractor();
    reactive(tab, h, control);

    expect(await act(build(tab, h))).toBe(true);
    expect(h.hovers).toEqual([COLLAPSED]);
    expect(h.clicks).toEqual([EXPANDED]);
  });

  test.each(cases)('%s presses nothing when the control is gone after the hover', async (_name, control, act) => {
    const tab = new ScriptedTab();
    const h = new FakeInteractor();
    tab.on(marker(`"control":"${control}"`), (): LocateRectResult =>
      h.hovers.length === 0 ? { found: true, rect: COLLAPSED } : { found: false },
    );

    expect(await act(build(tab, h))).toBe(false);
    expect(h.clicks).toEqual([]);
  });

  test('confirmNextFollowRequest presses — and reports — the row located after the hover', async () => {
    const tab = new ScriptedTab();
    const h = new FakeInteractor();
    tab.on(marker('"control":"confirm-follow-request"'), (): LocateConfirmRequestResult =>
      h.hovers.length === 0
        ? { found: true, rect: COLLAPSED, username: 'before', remaining: 3 }
        : { found: true, rect: EXPANDED, username: 'settled', remaining: 3 },
    );

    expect(await build(tab, h).confirmNextFollowRequest()).toEqual({
      clicked: true,
      username: 'settled',
      remaining: 3,
    });
    expect(h.hovers).toEqual([COLLAPSED]);
    expect(h.clicks).toEqual([EXPANDED]);
  });
});

describe('the unfollow menu animates open: its confirm is pressed once it has settled', () => {
  // Live 2026-10-09 (`EPO_PROBE=unfollow-hover`): the menu scales in over
  // ~100 ms — the confirm row is first found at 672×64.8, then shrinks to its
  // final 560×54. The 250 ms poll caught it mid-animation, the guard pinned
  // that rect, and the cursor arrived over a smaller row: "control moved".
  const HEADER: LocatedRect = { x: 360, y: 212, width: 324, height: 44 };
  const OPENING: LocatedRect = { x: 364, y: 518.9, width: 672, height: 64.8 };
  const SETTLED: LocatedRect = { x: 420, y: 501.5, width: 560, height: 54 };

  test('unfollow presses the header, then the confirm rect located AFTER the hover', async () => {
    const tab = new ScriptedTab();
    const h = new FakeInteractor();
    tab.on(marker('"control":"action-button"'), () =>
      tab.evaluated[tab.evaluated.length - 1].includes('__epoPage.probe({')
        ? { found: true, state: 'follow' }
        : { found: true, state: 'following', wouldClick: true, needsConfirm: true, rect: HEADER },
    );
    // The menu reports its layer signature, so the flow never presses the same layer twice.
    tab.on(pageCall('locateConfirm'), (): LocateRectResult & { sig: string } => ({
      found: true,
      rect: h.hovers.length === 0 ? OPENING : SETTLED,
      sig: 'menu',
    }));

    const result = await build(tab, h).unfollow('someone');

    expect(result.ok).toBe(true);
    expect(h.hovers).toEqual([OPENING]);
    expect(h.clicks).toEqual([HEADER, SETTLED]);
  });
});

test('the settled locate\'s AIM (its exposed part) is what the press is aimed at', async () => {
  // Live 2026-11-02: the drawer header covers the lower half of the close X.
  const tab = new ScriptedTab();
  const h = new FakeInteractor();
  const X: LocatedRect = { x: 428, y: 16, width: 16, height: 16 };
  const EXPOSED: LocatedRect = { x: 428, y: 16, width: 16, height: 8 };
  tab.on(marker('"control":"drawer-close"'), (): LocateRectResult => ({ found: true, rect: X, aim: EXPOSED }));

  expect(await build(tab, h).clickNotificationsClose()).toBe(true);
  expect(h.clicks).toEqual([X]);
  expect(h.aims).toEqual([EXPOSED]);
});

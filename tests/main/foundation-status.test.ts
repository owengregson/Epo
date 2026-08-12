import { Foundation } from '@/main/foundation-wiring';
import type { InstagramTab } from '@/adapter/tab';

/**
 * The composition root builds its dependency graph lazily — only after login,
 * when `ownPk` is resolvable. Before that, `status()` must still return a complete,
 * well-shaped `PeanutStatus` with idle defaults and `loggedIn: false` (there is no
 * `ds_user_id` cookie available under jest, and the cookie read fails closed).
 *
 * This exercises the not-built status path WITHOUT a browser or a real store: the
 * fake tab is never touched by the not-built branch.
 */
describe('Foundation status (not built)', () => {
  const fakeTab = {
    show: () => {},
    hide: () => {},
    goto: async () => {},
    currentUrl: () => 'https://www.instagram.com/',
    evaluate: async () => null,
    onResponse: () => () => {},
  } as unknown as InstagramTab;

  test('reports a complete idle, logged-out status before the graph is built', async () => {
    const f = new Foundation({ tab: fakeTab });
    const s = await f.status();

    expect(s).toEqual({
      state: 'idle',
      currentTargetPk: null,
      currentTargetUsername: null,
      chainIndex: null,
      actionsToday: 0,
      remainingToday: 0,
      atHardCeiling: false,
      requestBudgetRemaining: 0,
      queued: 0,
      pendingFollowback: 0,
      followedBackHeld: 0,
      unfollowDue: 0,
      lastStep: null,
      lastSentinel: null,
      lastActionAt: null,
      loggedIn: false,
    });

    f.dispose(); // idempotent no-op when nothing was built
  });

  test('isLoggedIn is false and ensureBuilt returns false without a session', async () => {
    const f = new Foundation({ tab: fakeTab });
    await expect(f.isLoggedIn()).resolves.toBe(false);
    await expect(f.ensureBuilt()).resolves.toBe(false);
  });
});

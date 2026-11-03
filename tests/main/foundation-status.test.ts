/**
 * The composition root builds its dependency graph lazily — only after login,
 * when `ownPk` is resolvable. Before that, `status()` must still return a
 * complete, well-shaped `EpoStatus` with idle defaults and `loggedIn: false`.
 *
 * This exercises the not-built status path WITHOUT a browser or a real store:
 * the session port answers with no `ds_user_id`, and the fake tab is never
 * touched by the not-built branch.
 */

import {
  cleanupMainHarness,
  makeFakeTab,
  makeIgSession,
  newFoundation,
} from '../kit/main-harness';

afterAll(cleanupMainHarness);

const loggedOut = () => ({
  tab: makeFakeTab({ evaluate: async <T>(): Promise<T> => null as T }),
  igSession: makeIgSession(null),
});

describe('Foundation status (not built)', () => {
  test('reports a complete idle, logged-out status before the graph is built', async () => {
    const { foundation: f } = newFoundation(loggedOut());
    const s = await f.status();

    expect(s).toEqual({
      runtime: expect.objectContaining({ desired: 'stopped', phase: 'ready', blockedReason: null }),
      state: 'idle',
      currentTargetPk: null,
      currentTargetUsername: null,
      chainIndex: null,
      actionsToday: 0,
      remainingToday: 0,
      plannedToday: 0,
      atHardCeiling: false,
      queued: 0,
      pendingFollowback: 0,
      followedBackHeld: 0,
      unfollowDue: 0,
      lastStep: null,
      lastSentinel: null,
      lastActionAt: null,
      sessionStartedAt: null,
      nextActionAt: null,
      netToday: 0,
      online: true,
      haltReason: null,
      recovery: null,
      pacing: null,
      loggedIn: false,
      // The composed status fields: never a count from a not-built graph.
      basis: 'not-built',
      boot: null,
      account: null,
      plan: null,
      boost: null,
      catchUp: null,
      own: null,
      today: null,
      journal: null,
      requests: null,
      unfollowsPaused: null,
      actionsUnconfirmed: null,
      resumeTarget: null,
    });

    f.dispose(); // idempotent no-op when nothing was built
  });

  test('isLoggedIn is false and ensureBuilt returns false without a session', async () => {
    const { foundation: f } = newFoundation(loggedOut());
    await expect(f.isLoggedIn()).resolves.toBe(false);
    await expect(f.ensureBuilt()).resolves.toBe(false);
  });

  test('growthSeries before build returns the empty read envelope, any days', async () => {
    const { foundation: f } = newFoundation(loggedOut());
    await expect(f.growthSeries()).resolves.toEqual({ points: [], baselineAt: null });
    await expect(f.growthSeries(90)).resolves.toEqual({ points: [], baselineAt: null });
  });
});

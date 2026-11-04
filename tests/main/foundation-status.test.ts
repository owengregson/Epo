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
      loggedIn: false,
      // The composed status fields: never a count from a not-built graph. Readiness rides the status even
      // before the build (spec §12.8 R4), so `boot` is the live boot view.
      basis: 'not-built',
      boot: expect.objectContaining({ phase: 'starting', identity: 'pending', data: 'pending', ig: 'pending' }),
      account: null,
      plan: null,
      boost: null,
      catchUp: null,
      own: null,
      today: null,
      journal: null,
      requests: null,
      surface: null,
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

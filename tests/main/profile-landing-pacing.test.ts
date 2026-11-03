import { TabUnresponsiveError } from '@/adapter/errors';
import { openOwnProfileStep, type StartupDeps } from '@/main/modules/startup-steps';
import type { BuiltGraph } from '@/main/services/graph-types';
import type { RuntimeSnapshot } from '@/main/services/runtime-coordinator';
import { ADAPTER, NOISE } from '@/timing/config';
import * as logger from '@/utils/logger';

/** The landing step (startup step 1) over plain deps: a signed-in graph, a free tab, the given press. */
function landingDeps(over: { url(): string; click(): Promise<boolean> }): StartupDeps {
  return {
    runtime: {
      ready: () => true, wantsRun: () => false, token: () => 0, record: () => {},
      snapshot: () => ({ accountPk: null }) as RuntimeSnapshot,
    },
    session: { current: () => ({ ownUsername: 'myself' }) as BuiltGraph, rebuildWith: async () => true },
    tab: { currentUrl: over.url },
    readOwnUsernamePassively: async () => undefined,
    clickOwnProfileLink: over.click,
    withHold: (_name, run) => run(),
    readCookie: async () => null,
    block: () => {},
    startEngine: async () => undefined,
    setAccountConfirmed: () => {},
    tourHeld: () => false,
    disposing: () => false,
    tabBusy: () => false,
  };
}

test('failed profile navigation waits a fresh page beat after its exact settle deadline', async () => {
  jest.useFakeTimers();
  const clicks: number[] = [];
  const step = openOwnProfileStep(landingDeps({
    url: () => 'https://www.instagram.com/',
    click: async () => {
      clicks.push(Date.now());
      return true;
    },
  }));
  const random = jest.spyOn(Math, 'random').mockReturnValue(0.5);
  try {
    const landing = step.run(new AbortController().signal);
    await jest.advanceTimersByTimeAsync(0);
    expect(clicks).toHaveLength(1);
    const settleMs = ADAPTER.NAV_SETTLE_MS * ADAPTER.NAV_SETTLE_ROUNDS;
    const retryMs = Math.round(
      ADAPTER.PROFILE_LAND_RETRY_MS * (NOISE.BEAT_MIN_FACTOR + NOISE.BEAT_MAX_FACTOR) / 2,
    );
    await jest.advanceTimersByTimeAsync(settleMs + retryMs - 1);
    expect(clicks).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(clicks).toHaveLength(2);
    expect(clicks[1] - clicks[0]).toBe(settleMs + retryMs);
    await jest.advanceTimersByTimeAsync(settleMs);
    await landing;
  } finally {
    random.mockRestore();
    jest.useRealTimers();
  }
});

test('a post-click uncertain press is verified by the URL, not reported as a failed landing', async () => {
  // Live 2026-10-08: the rail link navigates IN-PAGE, and the route change can
  // start before the release is acknowledged — the input queue then reports
  // post-click UNCERTAINTY although the click landed. The URL decides.
  jest.useFakeTimers();
  let url = 'https://www.instagram.com/';
  const clicks: number[] = [];
  const step = openOwnProfileStep(landingDeps({
    url: () => url,
    click: async () => {
      clicks.push(Date.now());
      url = 'https://www.instagram.com/myself/';
      throw new TabUnresponsiveError('input:document-changed-after-press', 15_000, 'post-click');
    },
  }));
  const warned: string[] = [];
  const said: string[] = [];
  logger.setLevel('info'); // the suite default (tests/kit/setup.ts) is 'error'
  logger.setSink((level, message) => {
    (level === 'warn' ? warned : said).push(message);
  });
  try {
    const landing = step.run(new AbortController().signal);
    await jest.advanceTimersByTimeAsync(ADAPTER.NAV_SETTLE_MS * ADAPTER.NAV_SETTLE_ROUNDS);
    await landing;
    expect(clicks).toHaveLength(1);
    expect(said).toContain('foundation: landed on own profile');
    expect(warned).not.toContain('foundation: profile landing click failed');
    expect(warned).not.toContain('foundation: profile click did not navigate, retrying');
  } finally {
    logger.setSink(null);
    logger.setLevel('error');
    jest.useRealTimers();
  }
});

test('a press that lands on a renamed profile counts as landed (the stored name may be stale)', async () => {
  jest.useFakeTimers();
  let url = 'https://www.instagram.com/';
  const clicks: number[] = [];
  const step = openOwnProfileStep(landingDeps({
    url: () => url,
    click: async () => {
      clicks.push(Date.now());
      url = 'https://www.instagram.com/myself.new/';
      return true;
    },
  }));
  try {
    const landing = step.run(new AbortController().signal);
    await jest.advanceTimersByTimeAsync(ADAPTER.NAV_SETTLE_MS);
    await landing;
    expect(clicks).toHaveLength(1);
  } finally {
    jest.useRealTimers();
  }
});

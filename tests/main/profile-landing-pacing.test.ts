import { Actor } from '@/adapter/actor';
import { TabUnresponsiveError } from '@/adapter/errors';
import { ADAPTER, NOISE } from '@/timing/config';
import * as logger from '@/utils/logger';
import { builtFoundation, cleanupMainHarness, makeFakeTab } from '../kit/main-harness';

afterAll(cleanupMainHarness);

test('failed profile navigation waits a fresh page beat after its exact settle deadline', async () => {
  jest.useFakeTimers();
  const clicks: number[] = [];
  const click = jest.spyOn(Actor.prototype, 'clickOwnProfileLink').mockImplementation(async () => {
    clicks.push(Date.now());
    return true;
  });
  const { foundation } = await builtFoundation();
  const random = jest.spyOn(Math, 'random').mockReturnValue(0.5);
  try {
    const landing = foundation.landOnOwnProfile();
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
    await foundation.dispose();
    random.mockRestore();
    click.mockRestore();
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
  const click = jest.spyOn(Actor.prototype, 'clickOwnProfileLink').mockImplementation(async () => {
    clicks.push(Date.now());
    url = 'https://www.instagram.com/myself/';
    throw new TabUnresponsiveError('input:document-changed-after-press', 15_000, 'post-click');
  });
  const { foundation } = await builtFoundation({ tab: makeFakeTab({ currentUrl: () => url }) });
  const warned: string[] = [];
  const said: string[] = [];
  logger.setLevel('info'); // the suite default (tests/kit/setup.ts) is 'error'
  logger.setSink((level, message) => {
    (level === 'warn' ? warned : said).push(message);
  });
  try {
    const landing = foundation.landOnOwnProfile();
    await jest.advanceTimersByTimeAsync(ADAPTER.NAV_SETTLE_MS * ADAPTER.NAV_SETTLE_ROUNDS);
    await landing;
    expect(clicks).toHaveLength(1);
    expect(said).toContain('foundation: landed on own profile');
    expect(warned).not.toContain('foundation: profile landing click failed');
    expect(warned).not.toContain('foundation: profile click did not navigate, retrying');
  } finally {
    await foundation.dispose();
    logger.setSink(null);
    logger.setLevel('error');
    click.mockRestore();
    jest.useRealTimers();
  }
});

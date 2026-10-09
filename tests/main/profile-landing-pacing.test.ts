import { Actor } from '@/adapter/actor';
import { ADAPTER, NOISE } from '@/timing/config';
import { builtFoundation, cleanupMainHarness } from '../kit/main-harness';

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

import { NOISE } from '@/timing/config';
import { pauseBeforePageRetry } from '@/timing/page-pacing';

describe('page retry spacing', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('each retry samples the existing bounded band and resolves at that deadline', async () => {
    const elapsed: number[] = [];
    for (const draw of [0, 0.5, 1]) {
      const start = Date.now();
      const pause = pauseBeforePageRetry(2_000, undefined, () => draw);
      await jest.runOnlyPendingTimersAsync();
      await pause;
      elapsed.push(Date.now() - start);
    }
    expect(elapsed).toEqual([1_400, 2_150, 2_900]);
    expect(Math.min(...elapsed)).toBe(2_000 * NOISE.BEAT_MIN_FACTOR);
    expect(Math.max(...elapsed)).toBe(2_000 * NOISE.BEAT_MAX_FACTOR);
  });

  test('with no rng handed in the pause draws from a launch stream, never Math.random', async () => {
    const random = jest.spyOn(Math, 'random');
    try {
      const elapsed: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        const start = Date.now();
        const pause = pauseBeforePageRetry(2_000);
        await jest.runOnlyPendingTimersAsync();
        await pause;
        elapsed.push(Date.now() - start);
      }
      expect(random).not.toHaveBeenCalled();
      for (const ms of elapsed) {
        expect(ms).toBeGreaterThanOrEqual(2_000 * NOISE.BEAT_MIN_FACTOR);
        expect(ms).toBeLessThanOrEqual(2_000 * NOISE.BEAT_MAX_FACTOR);
      }
      expect(new Set(elapsed).size).toBeGreaterThan(1);
    } finally {
      random.mockRestore();
    }
  });

  test('stopping cancels an outstanding page retry without waiting for its sampled deadline', async () => {
    const abort = new AbortController();
    const start = Date.now();
    const pause = pauseBeforePageRetry(2_000, abort.signal, () => 1);
    abort.abort();
    await pause;
    expect(Date.now()).toBe(start);
    expect(jest.getTimerCount()).toBe(0);
  });
});

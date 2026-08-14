/**
 * ConnectivityMonitor tests — the probe loop rides ScheduleManager.
 * `electron.net` is mocked BEFORE importing the module under test; the
 * `isOnline() === false` short-circuit keeps probes off the network entirely.
 */
jest.mock('electron', () => ({
  net: {
    isOnline: () => false,
    request: (): never => {
      throw new Error('unused');
    },
  },
}));

import { ConnectivityMonitor } from '@/main/connectivity';
import { setLevel } from '@/utils/logger';

beforeAll(() => setLevel('error'));

describe('ConnectivityMonitor', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('reports offline on the first resolved check and only on change after', async () => {
    const changes: boolean[] = [];
    const mon = new ConnectivityMonitor((online) => changes.push(online), {
      intervalMs: 1000,
      timeoutMs: 100,
    });
    mon.start();
    await Promise.resolve(); // let the immediate check settle (isOnline short-circuit)
    await Promise.resolve();
    expect(changes).toEqual([false]);

    jest.advanceTimersByTime(3000);
    await Promise.resolve();
    await Promise.resolve();
    expect(changes).toEqual([false]); // no change → no repeat callbacks

    mon.stop();
    jest.advanceTimersByTime(3000);
    await Promise.resolve();
    expect(changes).toEqual([false]); // stopped → no further checks
  });

  test('start() is idempotent while running', async () => {
    const changes: boolean[] = [];
    const mon = new ConnectivityMonitor((online) => changes.push(online), {
      intervalMs: 1000,
      timeoutMs: 100,
    });
    mon.start();
    mon.start(); // second start must not double the loop
    await Promise.resolve();
    await Promise.resolve();
    expect(changes).toEqual([false]);
    mon.stop();
  });
});

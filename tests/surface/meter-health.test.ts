/**
 * `SurfaceMeter` — what wave B's derivations and the compatibility report read
 * (per-read health is the sink's: `tests/surface/read-body.test.ts`).
 *
 * The guard rails are the point, not the percentiles: a meter that records
 * FAILED waits feeds every timeout into itself (slow → longer timeout → slower
 * detection → slower), which is why `time()` records only on resolve.
 */

import { RESERVOIR, SURFACE_METRICS, SurfaceMeter } from '@/surface/meter';

describe('SurfaceMeter', () => {
  test('reports p50/p95 over the samples it holds', () => {
    const meter = new SurfaceMeter();
    for (let i = 1; i <= 100; i++) meter.record('hydration', i);
    const s = meter.summary('hydration');
    expect(s.n).toBe(100);
    expect(s.p50).toBe(50);
    expect(s.p95).toBe(95);
  });

  test('an unsampled metric reports null, never a fabricated number', () => {
    const meter = new SurfaceMeter();
    expect(meter.summary('scroll-settle')).toEqual({
      metric: 'scroll-settle',
      n: 0,
      p50: null,
      p95: null,
    });
    // The snapshot always names every metric, so a missing one is visible.
    expect(Object.keys(meter.snapshot()).sort()).toEqual([...SURFACE_METRICS].sort());
  });

  test('the reservoir is bounded and newest-wins', () => {
    const meter = new SurfaceMeter();
    for (let i = 0; i < RESERVOIR + 50; i++) meter.record('body-read', i);
    const s = meter.summary('body-read');
    expect(s.n).toBe(RESERVOIR);
    // The oldest 50 fell out, so the median moved with them.
    expect(s.p50).toBeGreaterThan(RESERVOIR / 2);
  });

  test('a nonsense duration is dropped, not clamped', () => {
    const meter = new SurfaceMeter();
    meter.record('list-page', Number.NaN);
    meter.record('list-page', -5);
    expect(meter.summary('list-page').n).toBe(0);
  });

  test('time() records a RESOLVED call and ignores a rejected one', async () => {
    const meter = new SurfaceMeter();
    let clock = 0;
    const now = (): number => clock;

    await meter.time('hydration', now, async () => {
      clock += 120;
    });
    expect(meter.summary('hydration')).toMatchObject({ n: 1, p50: 120 });

    await expect(
      meter.time('hydration', now, async () => {
        clock += 8_000; // the timeout, not the page
        throw new Error('stale');
      }),
    ).rejects.toThrow('stale');
    // Successful samples only — the 8s failure never entered the reservoir.
    expect(meter.summary('hydration')).toMatchObject({ n: 1, p50: 120 });
  });
});

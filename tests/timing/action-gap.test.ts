import { actionGap } from '@/timing/action-gap';
import { NOISE } from '@/timing/config';
import { mulberry32 } from '@/timing/noise';
import { jittered, sample } from '@/timing/primitives';

test('equal positive bounds with zero jitter draw varied delays without accelerating actions', () => {
  const rng = mulberry32(20260921);
  const gaps = Array.from({ length: 10_000 }, () => sample(actionGap(60_000, 60_000, 0), rng));
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(60_000);
  expect(Math.max(...gaps)).toBeLessThanOrEqual(60_000 * NOISE.BEAT_MAX_FACTOR);
  expect(new Set(gaps).size).toBeGreaterThan(8_000);
});

test.each([[60_000, 90_000, 0], [60_000, 60_000, 30], [60_000, 90_000, 30], [0, 0, 0]])(
  'existing varied or zero policy (%i,%i,%i) retains its exact draws',
  (min, max, jitter) => {
    const actualRng = mulberry32(42);
    const previousRng = mulberry32(42);
    for (let index = 0; index < 100; index++) {
      expect(sample(actionGap(min, max, jitter), actualRng))
        .toBe(sample(jittered(min, max, jitter), previousRng));
    }
    expect(actualRng()).toBe(previousRng());
  },
);

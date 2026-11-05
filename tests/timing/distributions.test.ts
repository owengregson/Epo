import { clamp, logNormal, normal01 } from '@/timing/distributions';
import { sample } from '@/timing/primitives';

/** A deterministic rng that replays the given values in order (cycling). */
const seq = (...values: number[]): (() => number) => {
  let i = 0;
  return () => values[i++ % values.length];
};

/** A counting wrapper: reports how many times the rng was invoked. */
const counting = (
  inner: () => number,
): { rng: () => number; calls: () => number } => {
  let n = 0;
  return {
    rng: () => {
      n += 1;
      return inner();
    },
    calls: () => n,
  };
};

/** mulberry32 — deterministic PRNG for statistical assertions. */
const mulberry32 = (seed: number) => (): number => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe('distributions/normal01 — Box–Muller', () => {
  test('consumes exactly two rng draws', () => {
    const c = counting(seq(0.3, 0.7));
    normal01(c.rng);
    expect(c.calls()).toBe(2);
  });

  test('u1=1 (first draw 0) yields Z=0 regardless of the second draw', () => {
    // u1 = 1 - rng() = 1 → ln(1) = 0 → Z = 0
    expect(normal01(seq(0, 0.42))).toBe(0);
  });

  test('is a standard normal: mean ~0, sd ~1 over many samples', () => {
    const rng = mulberry32(1);
    const xs = Array.from({ length: 20000 }, () => normal01(rng));
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const varc = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(Math.abs(Math.sqrt(varc) - 1)).toBeLessThan(0.03);
  });
});

describe('distributions/logNormal', () => {
  test('Z=0 draw returns the median (rounded)', () => {
    expect(sample(logNormal(60_000, 0.75), seq(0, 0))).toBe(60_000);
  });

  test('every draw is a positive integer', () => {
    const rng = mulberry32(2);
    for (let i = 0; i < 500; i++) {
      const v = sample(logNormal(90_000, 0.8), rng);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });

  test('empirical median tracks the parameter', () => {
    const rng = mulberry32(3);
    const xs = Array.from({ length: 20000 }, () => sample(logNormal(95_000, 0.75), rng)).sort(
      (a, b) => a - b,
    );
    const median = xs[Math.floor(xs.length / 2)];
    expect(Math.abs(median - 95_000) / 95_000).toBeLessThan(0.04);
  });
});

describe('distributions/clamp — bounded re-draw', () => {
  test('passes through an in-range draw on the first try', () => {
    const c = counting(seq(0.5));
    // logNormal(1000, 0) is deterministically 1000 (sigma 0 → Z*0), within [500, 2000]
    const v = sample(clamp(logNormal(1000, 0), 500, 2000), c.rng);
    expect(v).toBe(1000);
  });

  test('projects onto the nearer bound after 4 failed inner draws', () => {
    const c = counting(seq(0, 0)); // logNormal(100_000,0) = 100_000, always above the cap
    const v = sample(clamp(logNormal(100_000, 0), 500, 2000), c.rng);
    expect(v).toBe(2000); // projected to max (nearer bound)
    // 4 inner attempts, each consuming normal01's 2 draws → at most 8 rng calls
    expect(c.calls()).toBeLessThanOrEqual(8);
  });

  test('never returns a value outside the bounds', () => {
    const rng = mulberry32(8);
    for (let i = 0; i < 2000; i++) {
      const v = sample(clamp(logNormal(1500, 1.2), 800, 4000), rng);
      expect(v).toBeGreaterThanOrEqual(800);
      expect(v).toBeLessThanOrEqual(4000);
    }
  });
});
